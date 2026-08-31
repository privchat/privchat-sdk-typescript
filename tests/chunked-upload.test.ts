import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RpcError } from '../src/client.js';
import { sha256Hex } from '../src/attachment-crypto.js';
import {
  uploadSealedAttachment,
  uploadSealedFileChunked,
  UploadSessionGoneError,
  chunkVerdict,
} from '../src/chunked-upload.js';

const UNIT = 64 * 1024;
const BASE = 'http://files.local/api/app/files';

/** 内存里的分片服务端：一片一条记录，status 回 received/missing。 */
class FakeChunkServer {
  parts = new Map<number, Uint8Array>();
  puts: Array<{ offset: number; len: number; digestOk: boolean }> = [];
  completes = 0;
  gone = false;
  /** 第一次 complete 回 20618（完成后校验失败，仅 S3 直传）；后续正常。 */
  failFirstCompleteWith20618 = false;
  constructor(readonly total: number, readonly token: string) {}

  missing(): Array<{ offset: number; length: number }> {
    const sorted = [...this.parts.entries()].sort((a, b) => a[0] - b[0]);
    const out: Array<{ offset: number; length: number }> = [];
    let cursor = 0;
    for (const [off, bytes] of sorted) {
      if (off > cursor) out.push({ offset: cursor, length: off - cursor });
      cursor = Math.max(cursor, off + bytes.byteLength);
    }
    if (cursor < this.total) out.push({ offset: cursor, length: this.total - cursor });
    return out;
  }

  assembled(): Uint8Array {
    const out = new Uint8Array(this.total);
    for (const [off, bytes] of this.parts) out.set(bytes, off);
    return out;
  }

  handler = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const json = (code: number, data?: unknown, status = 200) =>
      new Response(JSON.stringify({ code, message: code === 0 ? 'OK' : 'err', data }), { status });
    if (this.gone || headers['X-Upload-Token'] !== this.token) return json(20613, undefined, 410);
    if (url.startsWith(`${BASE}/status`)) {
      return json(0, { received: [], missing: this.missing(), received_bytes: 0, total_size: this.total, completed: false });
    }
    if (url.startsWith(`${BASE}/chunk`)) {
      const offset = Number(new URL(url).searchParams.get('offset'));
      const bytes = new Uint8Array(init!.body as ArrayBuffer);
      const digestOk = (await sha256Hex(bytes)) === headers['X-Chunk-SHA256'];
      this.puts.push({ offset, len: bytes.byteLength, digestOk });
      if (!digestOk) return json(20611, undefined, 422);
      if (offset % UNIT !== 0 || (offset + bytes.byteLength !== this.total && bytes.byteLength % UNIT !== 0)) {
        return json(20617, undefined, 400);
      }
      this.parts.set(offset, bytes);
      return json(0, { outcome: 'written', received_bytes: 0, total_size: this.total, complete: this.missing().length === 0 });
    }
    if (url.startsWith(`${BASE}/complete`)) {
      this.completes += 1;
      if (this.failFirstCompleteWith20618 && this.completes === 1) return json(20618, undefined, 422);
      if (this.missing().length > 0) return json(20615, undefined, 409);
      const body = JSON.parse(String(init!.body)) as { cek?: string; encryption_version?: number };
      if (body.encryption_version !== 1 || !body.cek) return json(1, undefined, 400);
      return json(0, { file_id: 4242, file_url: 'http://x/f', file_size: this.total, mime_type: 'application/octet-stream', uploaded_at: 0, storage_source_id: 0 });
    }
    return json(1, undefined, 404);
  };
}

function payload(n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (i * 31 + 7) & 0xff;
  return out;
}

const TOKEN = `${'a'.repeat(32)}.${'b'.repeat(64)}`;

describe('uploadSealedFileChunked (wire)', () => {
  let server: FakeChunkServer;
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn((i: RequestInfo | URL, init?: RequestInit) => server.handler(i, init)));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('uploads on the grid, first chunk is one base_unit, bytes reassemble exactly', async () => {
    const blob = payload(UNIT * 3 + 999);
    server = new FakeChunkServer(blob.byteLength, TOKEN);
    const progress: number[] = [];
    const result = await uploadSealedFileChunked({
      sealed: { blob, cek: 'cek', sha256: await sha256Hex(blob) },
      session: { uploadToken: TOKEN, uploadUrl: BASE, baseUnit: UNIT },
      onProgress: (e) => progress.push(e.loaded),
    });
    expect(result.file_id).toBe(4242);
    expect(server.puts[0]!.len).toBe(UNIT);
    expect(server.puts.every((p) => p.digestOk)).toBe(true);
    expect(server.assembled()).toEqual(blob);
    expect(progress.at(-1)).toBe(blob.byteLength);
    expect(server.completes).toBe(1);
  });

  it('resumes by sending only what the server says is missing', async () => {
    const blob = payload(UNIT * 4);
    server = new FakeChunkServer(blob.byteLength, TOKEN);
    server.parts.set(0, blob.subarray(0, UNIT));
    server.parts.set(UNIT * 2, blob.subarray(UNIT * 2, UNIT * 3));
    await uploadSealedFileChunked({
      sealed: { blob, cek: 'cek', sha256: await sha256Hex(blob) },
      session: { uploadToken: TOKEN, uploadUrl: BASE, baseUnit: UNIT },
    });
    const sent = server.puts.reduce((n, p) => n + p.len, 0);
    expect(sent).toBe(UNIT * 2);
    expect(server.puts.map((p) => p.offset).sort((a, b) => a - b)).toEqual([UNIT, UNIT * 3]);
    expect(server.assembled()).toEqual(blob);
  });

  it('a gone session surfaces as UploadSessionGoneError', async () => {
    const blob = payload(UNIT * 2);
    server = new FakeChunkServer(blob.byteLength, TOKEN);
    server.gone = true;
    await expect(
      uploadSealedFileChunked({
        sealed: { blob, cek: 'cek', sha256: 'x' },
        session: { uploadToken: TOKEN, uploadUrl: BASE, baseUnit: UNIT },
      }),
    ).rejects.toBeInstanceOf(UploadSessionGoneError);
  });

  it('rejects a public insecure upload URL before sending bytes', async () => {
    const blob = payload(UNIT);
    server = new FakeChunkServer(blob.byteLength, TOKEN);
    await expect(
      uploadSealedFileChunked({
        sealed: { blob, cek: 'cek', sha256: await sha256Hex(blob) },
        session: {
          uploadToken: TOKEN,
          uploadUrl: 'http://203.0.113.1/api/app/files',
          baseUnit: UNIT,
        },
      }),
    ).rejects.toThrow('refusing insecure upload URL');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('a 20618 complete surfaces as UploadSessionGoneError (restart from zero)', async () => {
    const blob = payload(UNIT * 2);
    server = new FakeChunkServer(blob.byteLength, TOKEN);
    server.failFirstCompleteWith20618 = true;
    await expect(
      uploadSealedFileChunked({
        sealed: { blob, cek: 'cek', sha256: await sha256Hex(blob) },
        session: { uploadToken: TOKEN, uploadUrl: BASE, baseUnit: UNIT },
      }),
    ).rejects.toBeInstanceOf(UploadSessionGoneError);
    expect(server.completes).toBe(1);
  });
});

describe('uploadSealedAttachment (orchestration)', () => {
  let server: FakeChunkServer;
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn((i: RequestInfo | URL, init?: RequestInit) => server.handler(i, init)));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  function fakeClient(opts: { hits: boolean[]; claimMiss?: boolean }) {
    const requests: Array<{ force: boolean; transports: string[] | undefined }> = [];
    let claims = 0;
    const client = {
      fileRequestChunkedUploadToken: vi.fn(async (args: { force_upload?: boolean; supported_upload_transports?: string[] }) => {
        const n = requests.length;
        requests.push({ force: args.force_upload === true, transports: args.supported_upload_transports });
        const hit = !args.force_upload && (opts.hits[n] ?? false);
        return hit
          ? { already_exists: true, claim_token: `claim-${n}` }
          : { already_exists: false, upload_token: TOKEN, upload_url: BASE, base_unit: UNIT, expires_at: 0 };
      }),
      fileClaimExisting: vi.fn(async () => {
        claims += 1;
        if (opts.claimMiss) {
          throw new RpcError('file/claim_existing', { code: 10201, message: 'no', data: null } as never);
        }
        return { file_id: 7, file_url: '', file_size: 1, mime_type: '', uploaded_at: 0, storage_source_id: 0 };
      }),
      fileRequestUploadToken: vi.fn(async () => {
        throw new Error('large payload must not take the whole-package path');
      }),
    };
    return { client: client as never, requests, claims: () => claims };
  }

  it('large payload: miss → chunked upload; token is the chunked token', async () => {
    const blob = payload(UNIT * 2);
    server = new FakeChunkServer(blob.byteLength, TOKEN);
    const f = fakeClient({ hits: [false] });
    const { result, token } = await uploadSealedAttachment(f.client, {
      sealed: { blob, cek: 'cek', sha256: await sha256Hex(blob) },
      filename: 'a.bin', mime_type: 'application/octet-stream', file_type: 'file',
      chunkedThreshold: 1024,
    });
    expect(result.file_id).toBe(4242);
    expect(token).toBe(TOKEN);
    expect(f.requests).toEqual([{
      force: false,
      transports: ['proxy_offset_v1', 's3_multipart_v1'],
    }]);
  });

  it('hit → claim, nothing uploaded', async () => {
    const blob = payload(UNIT * 2);
    server = new FakeChunkServer(blob.byteLength, TOKEN);
    const f = fakeClient({ hits: [true] });
    const { result, token } = await uploadSealedAttachment(f.client, {
      sealed: { blob, cek: 'cek', sha256: 'x' },
      filename: 'a.bin', mime_type: 'application/octet-stream', file_type: 'file',
      chunkedThreshold: 1024,
    });
    expect(result.file_id).toBe(7);
    expect(token).toBe('claim-0');
    expect(server.puts).toHaveLength(0);
  });

  it('claim miss → second request has force_upload=true (no precheck loop)', async () => {
    const blob = payload(UNIT * 2);
    server = new FakeChunkServer(blob.byteLength, TOKEN);
    const f = fakeClient({ hits: [true, true], claimMiss: true });
    const { token } = await uploadSealedAttachment(f.client, {
      sealed: { blob, cek: 'cek', sha256: await sha256Hex(blob) },
      filename: 'a.bin', mime_type: 'application/octet-stream', file_type: 'file',
      chunkedThreshold: 1024,
    });
    expect(f.requests.map((r) => r.force)).toEqual([false, true]);
    expect(f.claims()).toBe(1);
    expect(token).toBe(TOKEN);
    expect(server.assembled()).toEqual(blob);
  });

  it('complete fails with 20618 → fresh token on an empty server, every byte re-uploaded from zero', async () => {
    const blob = payload(UNIT * 2);
    const TOKEN1 = TOKEN;
    const TOKEN2 = `${'c'.repeat(32)}.${'d'.repeat(64)}`;
    const first = new FakeChunkServer(blob.byteLength, TOKEN1);
    const second = new FakeChunkServer(blob.byteLength, TOKEN2);
    first.failFirstCompleteWith20618 = true;
    // 🔴 fetch 按 token 分流到各自的 fake server：两个会话物理隔离，第二个
    // server 是全空的——若第二轮没从零重传（比如只重新 complete），这里的
    // puts 断言必然穿帮。
    vi.stubGlobal('fetch', vi.fn((i: RequestInfo | URL, init?: RequestInit) => {
      const t = ((init?.headers ?? {}) as Record<string, string>)['X-Upload-Token'];
      return (t === TOKEN2 ? second : first).handler(i, init);
    }));
    const requests: Array<{ force: boolean }> = [];
    let sessionNo = 0;
    const client = {
      fileRequestChunkedUploadToken: vi.fn(async (args: { force_upload?: boolean }) => {
        requests.push({ force: args.force_upload === true });
        const token = sessionNo++ === 0 ? TOKEN1 : TOKEN2;
        return { already_exists: false, upload_token: token, upload_url: BASE, base_unit: UNIT, expires_at: 0 };
      }),
      fileClaimExisting: vi.fn(async () => { throw new Error('这条路径不该 claim'); }),
      fileRequestUploadToken: vi.fn(async () => { throw new Error('大文件不该走整包'); }),
    };
    const { result, token } = await uploadSealedAttachment(client as never, {
      sealed: { blob, cek: 'cek', sha256: await sha256Hex(blob) },
      filename: 'a.bin', mime_type: 'application/octet-stream', file_type: 'file',
      chunkedThreshold: 1024,
    });
    // 旧会话被废弃、重新申请了一次（不带 force：这不是 claim miss）。
    expect(requests).toEqual([{ force: false }, { force: false }]);
    // 第一会话：字节全传过一遍，complete 被 20618 作废（仅一次）。
    expect(first.puts.reduce((n, p) => n + p.len, 0)).toBe(blob.byteLength);
    expect(first.completes).toBe(1);
    // 🔴 第二会话（新 token + 空 server）：完整字节从零重传，不是只重新 complete。
    expect(second.puts.reduce((n, p) => n + p.len, 0)).toBe(blob.byteLength);
    expect(second.puts.every((p) => p.digestOk)).toBe(true);
    expect(second.assembled()).toEqual(blob);
    expect(second.completes).toBe(1);
    expect(result.file_id).toBe(4242);
    expect(token).toBe(TOKEN2);
  });
});

describe('S3 multipart data plane', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('requests signed parts, forwards required headers, and completes', async () => {
    const partSize = UNIT;
    const blob = payload(partSize * 2 + 17);
    const uploaded = new Map<number, Uint8Array>();
    const required = 'checksum-from-server';
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      const envelope = (data: unknown) => new Response(JSON.stringify({ code: 0, data }));
      if (url === `${BASE}/status`) {
        const missing = [1, 2, 3]
          .filter((n) => !uploaded.has(n))
          .map((n) => ({ offset: (n - 1) * partSize, length: n === 3 ? 17 : partSize }));
        return envelope({ missing, completed: false });
      }
      if (url === `${BASE}/part-url`) {
        const body = JSON.parse(String(init?.body)) as { parts: Array<{ part_number: number }> };
        return envelope({ parts: body.parts.map((p) => ({
          part_number: p.part_number,
          url: `https://cos.example/part/${p.part_number}`,
          required_headers: { 'x-amz-checksum-sha256': required },
        })) });
      }
      if (url.startsWith('https://cos.example/part/')) {
        expect((init?.headers as Record<string, string>)['x-amz-checksum-sha256']).toBe(required);
        expect(init?.credentials).toBe('omit');
        const part = Number(url.split('/').at(-1));
        uploaded.set(part, new Uint8Array(init?.body as ArrayBuffer));
        return new Response('', { status: 200 });
      }
      if (url === `${BASE}/complete`) {
        return envelope({ file_id: 99, file_url: '', file_size: blob.length, mime_type: '', uploaded_at: 0, storage_source_id: 1 });
      }
      throw new Error(`unexpected URL ${url}`);
    }));

    const result = await uploadSealedFileChunked({
      sealed: { blob, cek: 'cek', sha256: await sha256Hex(blob) },
      session: {
        uploadToken: TOKEN,
        uploadUrl: BASE,
        baseUnit: UNIT,
        transport: 's3_multipart_v1',
        partSize,
        totalParts: 3,
      },
    });

    expect(result.file_id).toBe(99);
    expect([...uploaded.keys()]).toEqual([1, 2, 3]);
    expect(uploaded.get(3)?.byteLength).toBe(17);
    expect(calls).not.toContain(`${BASE}/chunk`);
  });

  it('uses the resumable token flow even for small payloads', async () => {
    const blob = payload(128);
    const server = new FakeChunkServer(blob.length, TOKEN);
    vi.stubGlobal('fetch', vi.fn((i: RequestInfo | URL, init?: RequestInit) => server.handler(i, init)));
    const request = vi.fn(async (args: { supported_upload_transports?: string[] }) => ({
      already_exists: false,
      upload_token: TOKEN,
      upload_url: BASE,
      base_unit: UNIT,
      transport: 'proxy_offset_v1' as const,
      echoed: args.supported_upload_transports,
    }));
    const whole = vi.fn();
    await uploadSealedAttachment({
      fileRequestChunkedUploadToken: request,
      fileClaimExisting: vi.fn(),
      fileRequestUploadToken: whole,
    } as never, {
      sealed: { blob, cek: 'cek', sha256: await sha256Hex(blob) },
      filename: 'small.bin',
      mime_type: 'application/octet-stream',
      file_type: 'file',
    });
    expect(request).toHaveBeenCalledOnce();
    expect(whole).not.toHaveBeenCalled();
    expect(request.mock.calls[0]?.[0].supported_upload_transports).toEqual([
      'proxy_offset_v1',
      's3_multipart_v1',
    ]);
  });
});


describe('chunkVerdict (must match Rust chunk_verdict byte-for-byte)', () => {
  it('known codes are decided regardless of HTTP status', () => {
    expect(chunkVerdict(0, true)).toBe('ok');
    expect(chunkVerdict(20614, false)).toBe('ok');
    expect(chunkVerdict(20611, true)).toBe('retry');
    expect(chunkVerdict(20612, false)).toBe('retry');
    expect(chunkVerdict(20610, true)).toBe('resync');
    expect(chunkVerdict(20615, false)).toBe('resync');
    expect(chunkVerdict(20613, true)).toBe('gone');
    // 20618 完成后校验失败：废弃会话从零重来，HTTP 状态无关（RESUMABLE §8）。
    expect(chunkVerdict(20618, false)).toBe('restart');
    expect(chunkVerdict(20618, true)).toBe('restart');
  });
  it('unknown / unparseable bodies fall back on HTTP 5xx → retry, else fatal', () => {
    expect(chunkVerdict(99999, true)).toBe('retry');
    expect(chunkVerdict(99999, false)).toBe('fatal');
    expect(chunkVerdict(-1, true)).toBe('retry'); // readEnvelope sets code=-1 on non-JSON
    expect(chunkVerdict(-1, false)).toBe('fatal');
    // 20616/20617 are 400-class; non-5xx → fatal, but a 5xx carrying them retries (parity).
    expect(chunkVerdict(20617, false)).toBe('fatal');
    expect(chunkVerdict(20617, true)).toBe('retry');
  });
});
