// 分片上传（RESUMABLE_UPLOAD_SPEC，冻结于 privchat-docs bdef282）。
//
// 与 Rust SDK 同一套模型：
//   · 申请 `file/request_chunked_upload_token`：命中 → claim；未命中 → 会话
//   · 四个端点只认 `X-Upload-Token`（单凭据）
//   · `GET status` 回 received/missing，客户端**直接用 missing**
//   · 首片 64KiB 探测 → 按吞吐调整（每步最多 4 倍、失败减半），并发 1
//   · complete 带 {cek, encryption_version}；SessionGone → 重新申请一次
//
// 浏览器只有 fetch/XHR，没有磁盘：密文本来就在内存里，按 offset 切 Uint8Array 视图即可。

import { PrivchatClient, RpcError } from './client.js';
import { parseRpcJson } from './codec/safe-json.js';
import { sha256Hex, type SealedAttachment } from './attachment-crypto.js';
import { uploadSealedFileViaToken, type UploadProgressEvent } from './api-methods.js';
import type { FileUploadResult } from './api-types.js';

/** 超过这个大小走分片（spec §2.4）。客户端常量，不进协议。 */
export const CHUNKED_UPLOAD_THRESHOLD = 1024 * 1024;

/** 单次请求上限。 */
const MAX_REQUEST_SIZE = 2 * 1024 * 1024;
/** 单片重试预算（按「没有进展」计）。 */
const CHUNK_RETRIES = 2;

/** 服务端错误码（protocol `ErrorCode` 20610-20618）。 */
const CODE_RANGE_OVERLAP = 20610;
const CODE_CHECKSUM_MISMATCH = 20611;
const CODE_SESSION_BUSY = 20612;
const CODE_SESSION_GONE = 20613;
const CODE_SESSION_COMPLETED = 20614;
const CODE_MISSING_RANGES = 20615;
/** 完成后校验失败（仅 S3 直传）：废弃会话从零重来（RESUMABLE §8）。 */
const CODE_RESTART_UPLOAD = 20618;
/** `ServerError::NotFound` 的协议码：claim 没命中。 */
const RESOURCE_NOT_FOUND = 10201;

export class UploadSessionGoneError extends Error {
  constructor() {
    super('upload session gone');
    this.name = 'UploadSessionGoneError';
  }
}

export interface ChunkedUploadSession {
  uploadToken: string;
  /** `.../files` */
  uploadUrl: string;
  baseUnit: number;
  expiresAt?: number;
}

type Range = { offset: number; length: number };

/** 请求大小自适应：端到端吞吐 EWMA，目标一片约 1 秒；每步最多 4 倍；失败立即减半。 */
class ChunkSizer {
  private rate: number | undefined;
  private next: number;
  constructor(private readonly base: number) {
    this.next = base;
  }
  nextSize(): number {
    return this.next;
  }
  onSuccess(bytes: number, elapsedMs: number): void {
    const secs = Math.max(elapsedMs / 1000, 0.001);
    const sample = bytes / secs;
    this.rate = this.rate === undefined ? sample : this.rate * 0.7 + sample * 0.3;
    const capped = Math.min(this.rate, bytes * 4);
    this.next = this.clamp(capped);
  }
  onFailure(): void {
    this.next = this.clamp(Math.floor(this.next / 2));
    this.rate = undefined;
  }
  private clamp(want: number): number {
    const max = Math.max(MAX_REQUEST_SIZE, this.base);
    const w = Math.min(Math.max(want, this.base), max);
    return Math.max(Math.floor(w / this.base) * this.base, this.base);
  }
}

async function readEnvelope(resp: Response): Promise<{ code: number; message?: string; data?: unknown }> {
  const text = await resp.text();
  try {
    const json = parseRpcJson(text) as { code?: number; message?: string; data?: unknown };
    return { code: json.code ?? 0, message: json.message, data: json.data };
  } catch {
    return { code: -1, message: `HTTP ${resp.status}: ${text.slice(0, 200)}` };
  }
}

async function fetchStatus(
  session: ChunkedUploadSession,
  signal?: AbortSignal,
): Promise<{ missing: Range[]; completed: boolean }> {
  const resp = await fetch(`${session.uploadUrl}/status`, {
    method: 'GET',
    headers: { 'X-Upload-Token': session.uploadToken },
    signal,
  });
  const env = await readEnvelope(resp);
  if (env.code === CODE_SESSION_GONE) throw new UploadSessionGoneError();
  if (env.code !== 0) throw new Error(`upload status failed: code=${env.code} ${env.message ?? ''}`);
  const data = env.data as { missing?: Range[]; completed?: boolean };
  return {
    missing: (data.missing ?? []).map((r) => ({ offset: Number(r.offset), length: Number(r.length) })),
    completed: data.completed === true,
  };
}

export type ChunkVerdict = 'ok' | 'retry' | 'resync' | 'gone' | 'restart' | 'fatal';

async function putChunk(
  session: ChunkedUploadSession,
  offset: number,
  bytes: Uint8Array,
  signal?: AbortSignal,
): Promise<ChunkVerdict> {
  const digest = await sha256Hex(bytes);
  let resp: Response;
  try {
    resp = await fetch(`${session.uploadUrl}/chunk?offset=${offset}`, {
      method: 'PUT',
      headers: {
        'X-Upload-Token': session.uploadToken,
        'X-Chunk-SHA256': digest,
        'Content-Type': 'application/octet-stream',
      },
      body: bytes.slice().buffer as ArrayBuffer,
      signal,
    });
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') throw e;
    return 'retry';
  }
  const env = await readEnvelope(resp);
  return chunkVerdict(env.code, resp.status >= 500);
}

/** 一次分片 PUT 响应 → 客户端动作。**TS 与 Rust `chunk_verdict` 必须逐字一致**。
 *
 *  已知业务码给定论；其余（未知码 / 20616 未对齐 / 20617 模式冲突 / 无法解析→code=-1）
 *  按 HTTP 状态兜底：5xx 视为瞬时错误可重试，其余终局失败。
 *
 *  🔴 少了 5xx 这一路，一次数据库抖动返回的带未知码的 500 会被直接判死、放弃整份上传。 */
export function chunkVerdict(code: number, isServerError: boolean): ChunkVerdict {
  switch (code) {
    case 0:
    case CODE_SESSION_COMPLETED:
      return 'ok';
    case CODE_CHECKSUM_MISMATCH:
    case CODE_SESSION_BUSY:
      return 'retry';
    case CODE_RANGE_OVERLAP:
    case CODE_MISSING_RANGES:
      return 'resync';
    case CODE_SESSION_GONE:
      return 'gone';
    case CODE_RESTART_UPLOAD:
      return 'restart';
    default:
      return isServerError ? 'retry' : 'fatal';
  }
}

async function complete(
  session: ChunkedUploadSession,
  cek: string,
  businessId?: string,
  signal?: AbortSignal,
): Promise<FileUploadResult> {
  const resp = await fetch(`${session.uploadUrl}/complete`, {
    method: 'POST',
    headers: { 'X-Upload-Token': session.uploadToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ cek, encryption_version: 1, business_id: businessId }),
    signal,
  });
  const env = await readEnvelope(resp);
  if (env.code === CODE_SESSION_GONE) throw new UploadSessionGoneError();
  if (env.code !== 0 || env.data === undefined) {
    throw new Error(`upload complete failed: code=${env.code} ${env.message ?? ''}`);
  }
  return env.data as FileUploadResult;
}

/** 分片上传**已封装好**的 blob：status → 只补 missing → complete。
 *
 * 抛 [UploadSessionGoneError] 表示会话没了，调用方该重新申请 token。 */
export async function uploadSealedFileChunked(args: {
  sealed: SealedAttachment;
  session: ChunkedUploadSession;
  businessId?: string;
  onProgress?: (event: UploadProgressEvent) => void;
  signal?: AbortSignal;
}): Promise<FileUploadResult> {
  const { sealed, session } = args;
  const total = sealed.blob.byteLength;
  const base = Math.max(session.baseUnit | 0, 1);
  const sizer = new ChunkSizer(base);

  const first = await fetchStatus(session, args.signal);
  if (first.completed) return complete(session, sealed.cek, args.businessId, args.signal);
  let gaps = first.missing.slice().sort((a, b) => a.offset - b.offset);
  const report = () => {
    const missingBytes = gaps.reduce((n, g) => n + g.length, 0);
    const loaded = Math.max(total - missingBytes, 0);
    args.onProgress?.({ loaded, total, percent: total > 0 ? Math.round((loaded / total) * 100) : 100 });
  };
  report();

  let failuresSinceProgress = 0;
  while (gaps.length > 0) {
    const gap = gaps[0]!;
    let len = Math.min(sizer.nextSize(), gap.length);
    // 非末段必须整格。
    if (gap.offset + len < total) len = Math.max(Math.floor(len / base) * base, base);
    len = Math.min(len, gap.length);
    const piece = sealed.blob.subarray(gap.offset, gap.offset + len);

    const started = Date.now();
    const verdict = await putChunk(session, gap.offset, piece, args.signal);
    if (verdict === 'ok') {
      sizer.onSuccess(len, Date.now() - started);
      if (len >= gap.length) gaps.shift();
      else gaps[0] = { offset: gap.offset + len, length: gap.length - len };
      failuresSinceProgress = 0;
      report();
      continue;
    }
    if (verdict === 'gone') throw new UploadSessionGoneError();
    // 20618 只在 complete 路径产生，chunk 路径不会碰到；语义同为「废弃会话、
    // 从零重新申请」，并入 gone 同一出口（RESUMABLE §8）。
    if (verdict === 'restart') throw new UploadSessionGoneError();
    if (verdict === 'fatal') throw new Error(`chunk upload rejected at offset=${gap.offset}`);
    failuresSinceProgress += 1;
    if (failuresSinceProgress > CHUNK_RETRIES) {
      throw new Error(`chunk upload made no progress after ${failuresSinceProgress} attempts (offset=${gap.offset})`);
    }
    if (verdict === 'retry') {
      sizer.onFailure();
      await new Promise((r) => setTimeout(r, 300 * 2 ** Math.min(failuresSinceProgress, 4)));
    } else {
      // resync：以服务端 missing 为准。
      const st = await fetchStatus(session, args.signal);
      if (st.completed) break;
      gaps = st.missing.slice().sort((a, b) => a.offset - b.offset);
      report();
    }
  }
  return complete(session, sealed.cek, args.businessId, args.signal);
}

/** claim 失败是不是「服务端拿不到那份内容」——只有它该退回实体上传。 */
export function claimMissShouldReupload(e: unknown): boolean {
  return e instanceof RpcError && e.response.code === RESOURCE_NOT_FOUND;
}

function sessionOf(
  r: { upload_token?: string; upload_url?: string; base_unit?: number; expires_at?: number },
): ChunkedUploadSession {
  if (!r.upload_token || !r.upload_url) {
    throw new Error('request_chunked_upload_token: missing upload_token/upload_url');
  }
  return {
    uploadToken: r.upload_token,
    uploadUrl: r.upload_url.replace(/\/+$/, ''),
    baseUnit: r.base_unit && r.base_unit > 0 ? r.base_unit : 64 * 1024,
    expiresAt: r.expires_at,
  };
}

/** 一份**已封装**附件的完整上传编排（与 Rust SDK `plan_attachment_upload` 同构）：
 *
 *  - 超过 [CHUNKED_UPLOAD_THRESHOLD] → 分片：命中 claim；claim 没成 → `force_upload=true`
 *    再申请一次（跳过预检，否则死循环）；会话没了 → 重新申请一次
 *  - 否则 → 整包：命中 claim；claim 没成 → 不带摘要再申请一张普通 token
 *
 *  返回 `{ result, token }`：`token` 是随后 `file/upload_callback` 要带的那张。 */
export async function uploadSealedAttachment(
  client: PrivchatClient,
  args: {
    sealed: SealedAttachment;
    filename: string;
    mime_type: string;
    file_type: 'image' | 'video' | 'voice' | 'file' | 'other';
    business_type?: string;
    businessId?: string;
    onProgress?: (event: UploadProgressEvent) => void;
    signal?: AbortSignal;
    /** 测试用；默认 [CHUNKED_UPLOAD_THRESHOLD]。 */
    chunkedThreshold?: number;
  },
): Promise<{ result: FileUploadResult; token: string }> {
  const { sealed, filename, mime_type, file_type } = args;
  const business_type = args.business_type ?? 'message';
  const size = sealed.blob.byteLength;
  const threshold = args.chunkedThreshold ?? CHUNKED_UPLOAD_THRESHOLD;

  if (size > threshold) {
    const request = (force_upload: boolean) =>
      client.fileRequestChunkedUploadToken({
        file_type,
        business_type,
        file_size: size,
        file_hash: sealed.sha256,
        mime_type,
        filename,
        force_upload,
      });
    let prepared = await request(false);
    if (prepared.already_exists && prepared.claim_token) {
      try {
        const result = await client.fileClaimExisting({ token: prepared.claim_token, sha256: sealed.sha256 });
        return { result, token: prepared.claim_token };
      } catch (e) {
        if (!claimMissShouldReupload(e)) throw e;
        prepared = await request(true);
      }
    }
    if (prepared.already_exists) {
      throw new Error('force_upload=true still reported already_exists');
    }
    let session = sessionOf(prepared);
    try {
      const result = await uploadSealedFileChunked({ sealed, session, businessId: args.businessId, onProgress: args.onProgress, signal: args.signal });
      return { result, token: session.uploadToken };
    } catch (e) {
      if (!(e instanceof UploadSessionGoneError)) throw e;
      const again = await request(false);
      if (again.already_exists && again.claim_token) {
        const result = await client.fileClaimExisting({ token: again.claim_token, sha256: sealed.sha256 });
        return { result, token: again.claim_token };
      }
      session = sessionOf(again);
      const result = await uploadSealedFileChunked({ sealed, session, businessId: args.businessId, onProgress: args.onProgress, signal: args.signal });
      return { result, token: session.uploadToken };
    }
  }

  // ---- 整包 ----
  let token = await client.fileRequestUploadToken({
    file_size: size,
    mime_type,
    file_type,
    business_type,
    filename,
    sha256: sealed.sha256,
  });
  if (token.already_exists === true) {
    try {
      const result = await client.fileClaimExisting({ token: token.token, sha256: sealed.sha256 });
      return { result, token: token.token };
    } catch (e) {
      if (!claimMissShouldReupload(e)) throw e;
      token = await client.fileRequestUploadToken({ file_size: size, mime_type, file_type, business_type, filename });
    }
  }
  const result = await uploadSealedFileViaToken({
    sealed,
    filename,
    uploadUrl: token.upload_url,
    token: token.token,
    businessId: args.businessId,
    onProgress: args.onProgress,
    signal: args.signal,
  });
  return { result, token: token.token };
}
