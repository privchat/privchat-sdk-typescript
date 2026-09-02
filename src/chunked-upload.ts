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
import { decodeSiteKey, sealAttachment, sha256Hex, type SealedAttachment } from './attachment-crypto.js';
import type { UploadProgressEvent } from './api-methods.js';
import type { FileRequestChunkedUploadTokenResponse, FileUploadResult } from './api-types.js';

/** Legacy compatibility export. All uploads now use the resumable flow. */
export const CHUNKED_UPLOAD_THRESHOLD = 1024 * 1024;

/** 单次请求上限。 */
const MAX_REQUEST_SIZE = 2 * 1024 * 1024;
/** 单片重试预算（按「没有进展」计）。 */
const CHUNK_RETRIES = 2;

/** 服务端错误码（protocol `ErrorCode` 20610-20618）。 */
const CODE_RANGE_OVERLAP = 20610;
const CODE_UPLOAD_CHUNK_CHECKSUM_MISMATCH = 20611;
const CODE_SESSION_BUSY = 20612;
const CODE_SESSION_GONE = 20613;
const CODE_SESSION_COMPLETED = 20614;
const CODE_MISSING_RANGES = 20615;
/** 完成后校验失败（仅 S3 直传）：废弃会话从零重来（RESUMABLE §8）。 */
const CODE_UPLOAD_RESTART_REQUIRED = 20618;
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
  transport?: 'proxy_offset_v1' | 's3_multipart_v1';
  partSize?: number;
  totalParts?: number;
  expiresAt?: number;
}

type Range = { offset: number; length: number };

function assertSecureUploadUrl(value: string): void {
  const url = new URL(value);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const local = hostname === 'localhost' || hostname === '127.0.0.1' ||
    hostname === '::1' || hostname.endsWith('.local');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new Error(`refusing insecure upload URL: ${url.origin}`);
  }
}

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

interface SignedPart {
  part_number: number;
  url: string;
  required_headers: Record<string, string>;
}

function s3PartLength(session: ChunkedUploadSession, total: number, partNumber: number): number {
  const partSize = session.partSize;
  const totalParts = session.totalParts;
  if (!partSize || !totalParts || partNumber < 1 || partNumber > totalParts) {
    throw new Error('invalid S3 multipart session geometry');
  }
  return partNumber === totalParts ? total - partSize * (totalParts - 1) : partSize;
}

function missingS3Parts(session: ChunkedUploadSession, total: number, missing: Range[]): number[] {
  const totalParts = session.totalParts;
  const partSize = session.partSize;
  if (!totalParts || !partSize) throw new Error('missing S3 multipart session geometry');
  const parts: number[] = [];
  for (let partNumber = 1; partNumber <= totalParts; partNumber += 1) {
    const offset = (partNumber - 1) * partSize;
    const length = s3PartLength(session, total, partNumber);
    if (missing.some((gap) => gap.offset <= offset && gap.offset + gap.length >= offset + length)) {
      parts.push(partNumber);
    }
  }
  return parts;
}

async function requestPartUrls(
  session: ChunkedUploadSession,
  parts: Array<{ part_number: number; content_length: number; checksum_sha256_hex: string }>,
  signal?: AbortSignal,
): Promise<SignedPart[]> {
  const resp = await fetch(`${session.uploadUrl}/part-url`, {
    method: 'POST',
    headers: { 'X-Upload-Token': session.uploadToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ parts }),
    signal,
  });
  const env = await readEnvelope(resp);
  if (env.code === CODE_SESSION_GONE) throw new UploadSessionGoneError();
  if (env.code !== 0 || env.data === undefined) {
    throw new Error(`part URL request failed: code=${env.code} ${env.message ?? ''}`);
  }
  return (env.data as { parts?: SignedPart[] }).parts ?? [];
}

async function uploadS3Parts(args: {
  sealed: SealedAttachment;
  session: ChunkedUploadSession;
  missing: Range[];
  onProgress?: (event: UploadProgressEvent) => void;
  signal?: AbortSignal;
}): Promise<void> {
  const { sealed, session } = args;
  const total = sealed.blob.byteLength;
  const partSize = session.partSize;
  if (!partSize) throw new Error('missing S3 part_size');
  const numbers = missingS3Parts(session, total, args.missing);
  let loaded = total - args.missing.reduce((sum, gap) => sum + gap.length, 0);

  for (let batchStart = 0; batchStart < numbers.length; batchStart += 100) {
    const batch = numbers.slice(batchStart, batchStart + 100);
    const declarations = await Promise.all(batch.map(async (partNumber) => {
      const offset = (partNumber - 1) * partSize;
      const length = s3PartLength(session, total, partNumber);
      const bytes = sealed.blob.subarray(offset, offset + length);
      return {
        part_number: partNumber,
        content_length: length,
        checksum_sha256_hex: await sha256Hex(bytes),
      };
    }));
    const signed = await requestPartUrls(session, declarations, args.signal);
    const byNumber = new Map(signed.map((part) => [part.part_number, part]));

    for (const declaration of declarations) {
      const part = byNumber.get(declaration.part_number);
      if (!part) throw new Error(`part URL response omitted part ${declaration.part_number}`);
      assertSecureUploadUrl(part.url);
      const offset = (declaration.part_number - 1) * partSize;
      const bytes = sealed.blob.subarray(offset, offset + declaration.content_length);
      let uploaded = false;
      let lastError: unknown;
      for (let attempt = 0; attempt <= CHUNK_RETRIES && !uploaded; attempt += 1) {
        try {
          const response = await fetch(part.url, {
            method: 'PUT',
            headers: part.required_headers,
            body: bytes.slice().buffer as ArrayBuffer,
            signal: args.signal,
            credentials: 'omit',
          });
          if (!response.ok) throw new Error(`object storage returned HTTP ${response.status}`);
          uploaded = true;
        } catch (error) {
          if ((error as Error)?.name === 'AbortError') throw error;
          lastError = error;
          if (attempt < CHUNK_RETRIES) {
            await new Promise((resolve) => setTimeout(resolve, 300 * 2 ** attempt));
          }
        }
      }
      if (!uploaded) {
        throw new Error(`S3 part ${declaration.part_number} upload failed: ${String(lastError)}`);
      }
      loaded = Math.min(loaded + declaration.content_length, total);
      args.onProgress?.({ loaded, total, percent: Math.round((loaded / total) * 100) });
    }
  }
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
    case CODE_UPLOAD_CHUNK_CHECKSUM_MISMATCH:
    case CODE_SESSION_BUSY:
      return 'retry';
    case CODE_RANGE_OVERLAP:
    case CODE_MISSING_RANGES:
      return 'resync';
    case CODE_SESSION_GONE:
      return 'gone';
    case CODE_UPLOAD_RESTART_REQUIRED:
      return 'restart';
    default:
      return isServerError ? 'retry' : 'fatal';
  }
}

async function complete(
  session: ChunkedUploadSession,
  businessId?: string,
  signal?: AbortSignal,
): Promise<FileUploadResult> {
  const resp = await fetch(`${session.uploadUrl}/complete`, {
    method: 'POST',
    headers: { 'X-Upload-Token': session.uploadToken, 'Content-Type': 'application/json' },
    // 🔴 只带业务字段：加密参数与身份全部由 token 冻结，客户端在这里自报什么都
    // 不作数（服务端已经删掉了那些入参）。
    body: JSON.stringify({ business_id: businessId }),
    signal,
  });
  const env = await readEnvelope(resp);
  // 🔴 20618（完成后校验失败，仅 S3 直传，RESUMABLE §8）与 20613 动作相同：废弃
  // 会话从零重新申请。漏掉这条，20618 会被包成普通 Error，编排层进不了重新
  // prepare 分支，真实 S3 complete 失败后永远无法自愈。
  if (env.code === CODE_SESSION_GONE || env.code === CODE_UPLOAD_RESTART_REQUIRED) {
    throw new UploadSessionGoneError();
  }
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

  assertSecureUploadUrl(session.uploadUrl);
  const first = await fetchStatus(session, args.signal);
  if (first.completed) return complete(session, args.businessId, args.signal);
  if (session.transport === 's3_multipart_v1') {
    let missing = first.missing;
    for (let round = 0; missing.length > 0 && round <= CHUNK_RETRIES; round += 1) {
      await uploadS3Parts({ ...args, missing });
      const after = await fetchStatus(session, args.signal);
      missing = after.missing;
    }
    if (missing.length > 0) {
      throw new Error(`S3 upload still has ${missing.length} missing range(s)`);
    }
    return complete(session, args.businessId, args.signal);
  }
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
  return complete(session, args.businessId, args.signal);
}


/** 用 token 响应里下发的密钥与块大小封装，并核对长度。
 *
 * 🔴 三项缺一不可：没有密钥封不出服务端认的密文；没有块大小封出来的长度与 token
 * 冻结的对不上；`total_size` 是服务端算的密文长度，封完先比一次——不一致说明两边
 * 几何不同，此刻失败远好过传完再被拒。
 */
async function sealForSession(
  prepared: FileRequestChunkedUploadTokenResponse,
  plaintext: Uint8Array,
): Promise<SealedAttachment> {
  const key = prepared.attachment_key;
  if (key == null) throw new Error('upload token did not carry an attachment key');
  const chunk = prepared.chunk_plain_size;
  if (chunk == null || chunk <= 0) throw new Error('upload token did not carry chunk_plain_size');
  const sealed = await sealAttachment(plaintext, decodeSiteKey(key.key), key.key_id, chunk);
  const expected = prepared.total_size;
  if (expected != null && expected !== sealed.blob.byteLength) {
    throw new Error(
      `sealed length ${sealed.blob.byteLength} != server-frozen ${expected}`,
    );
  }
  return sealed;
}

/** claim 失败是不是「服务端拿不到那份内容」——只有它该退回实体上传。 */
export function claimMissShouldReupload(e: unknown): boolean {
  return e instanceof RpcError && e.response.code === RESOURCE_NOT_FOUND;
}

function sessionOf(
  r: {
    upload_token?: string;
    upload_url?: string;
    base_unit?: number;
    expires_at?: number;
    transport?: 'proxy_offset_v1' | 's3_multipart_v1';
    part_size?: number;
    total_parts?: number;
  },
): ChunkedUploadSession {
  if (!r.upload_token || !r.upload_url) {
    throw new Error('request_chunked_upload_token: missing upload_token/upload_url');
  }
  const transport = r.transport ?? 'proxy_offset_v1';
  if (transport === 's3_multipart_v1' && (!r.part_size || !r.total_parts)) {
    throw new Error('request_chunked_upload_token: missing S3 multipart geometry');
  }
  const uploadUrl = r.upload_url.replace(/\/+$/, '');
  assertSecureUploadUrl(uploadUrl);
  return {
    uploadToken: r.upload_token,
    uploadUrl,
    baseUnit: r.base_unit && r.base_unit > 0 ? r.base_unit : 64 * 1024,
    transport,
    partSize: r.part_size,
    totalParts: r.total_parts,
    expiresAt: r.expires_at,
  };
}

/** 一份**已封装**附件的完整上传编排（与 Rust SDK `plan_attachment_upload` 同构）：
 *
 *  - every payload uses a resumable token; the server selects its configured data plane
 *  - claim miss → `force_upload=true` once; a gone session starts a fresh session
 *
 *  返回 `{ result, token }`：`token` 是随后 `file/upload_callback` 要带的那张。 */
export async function uploadSealedAttachment(
  client: PrivchatClient,
  args: {
    /** 🔴 明文进来，封装在这条流程**内部**发生——因为密钥要等 token 响应。 */
    plaintext: Uint8Array;
    filename: string;
    mime_type: string;
    file_type: 'image' | 'video' | 'voice' | 'file' | 'other';
    business_type?: string;
    businessId?: string;
    onProgress?: (event: UploadProgressEvent) => void;
    signal?: AbortSignal;
    /** @deprecated All uploads use the resumable token flow. */
    chunkedThreshold?: number;
  },
): Promise<{ result: FileUploadResult; token: string }> {
  // 🔴 顺序：**先申请 token，再封装**。
  //
  // 封装要用的全站密钥在 token 响应里——申请之前客户端手上根本没有它，所以
  // "先封装再申请"（旧实现那样自造随机 CEK）在这套设计里走不通。
  // 判重键也换成了**明文**摘要：每块都用新的随机 nonce，同一份明文封两次得到
  // 两串不同的密文，密文摘要按定义无法跨用户命中。
  const { plaintext, filename, mime_type, file_type } = args;
  const business_type = args.business_type ?? 'message';
  const plaintextSha = await sha256Hex(plaintext);
  {
    const request = (force_upload: boolean) =>
      client.fileRequestChunkedUploadToken({
        file_type,
        business_type,
        plaintext_size: plaintext.byteLength,
        plaintext_sha256: plaintextSha,
        mime_type,
        filename,
        force_upload,
        supported_upload_transports: ['proxy_offset_v1', 's3_multipart_v1'],
      });
    let prepared = await request(false);
    if (prepared.already_exists && prepared.claim_token) {
      try {
        const result = await client.fileClaimExisting({ token: prepared.claim_token, sha256: plaintextSha });
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
    let sealed = await sealForSession(prepared, plaintext);
    try {
      const result = await uploadSealedFileChunked({ sealed, session, businessId: args.businessId, onProgress: args.onProgress, signal: args.signal });
      return { result, token: session.uploadToken };
    } catch (e) {
      if (!(e instanceof UploadSessionGoneError)) throw e;
      const again = await request(false);
      if (again.already_exists && again.claim_token) {
        const result = await client.fileClaimExisting({ token: again.claim_token, sha256: plaintextSha });
        return { result, token: again.claim_token };
      }
      session = sessionOf(again);
      // 新会话可能换了密钥/块大小，必须按它重新封。
      sealed = await sealForSession(again, plaintext);
      const result = await uploadSealedFileChunked({ sealed, session, businessId: args.businessId, onProgress: args.onProgress, signal: args.signal });
      return { result, token: session.uploadToken };
    }
  }

}
