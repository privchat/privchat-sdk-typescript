import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RpcError } from '../src/client.js';
import { sha256Hex } from '../src/attachment-crypto.js';
import {
  uploadSealedAttachment,
  uploadSealedFileChunked,
  UploadSessionGoneError,
} from '../src/chunked-upload.js';

const UNIT = 64 * 1024;
const BASE = 'http://files.local/api/app/files';

/** 内存里的分片服务端：一片一条记录，status 回 received/missing。 */
class FakeChunkServer {
  parts = new Map<number, Uint8Array>();
  puts: Array<{ offset: number; len: number; digestOk: boolean }> = [];
  completes = 0;
  gone = false;
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
  afterEach(() => vi.unstubAllGlobals());

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
});

describe('uploadSealedAttachment (orchestration)', () => {
  let server: FakeChunkServer;
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn((i: RequestInfo | URL, init?: RequestInit) => server.handler(i, init)));
  });
  afterEach(() => vi.unstubAllGlobals());

  function fakeClient(opts: { hits: boolean[]; claimMiss?: boolean }) {
    const requests: Array<{ force: boolean }> = [];
    let claims = 0;
    const client = {
      fileRequestChunkedUploadToken: vi.fn(async (args: { force_upload?: boolean }) => {
        const n = requests.length;
        requests.push({ force: args.force_upload === true });
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
    expect(f.requests).toEqual([{ force: false }]);
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
    expect(f.requests).toEqual([{ force: false }, { force: true }]);
    expect(f.claims()).toBe(1);
    expect(token).toBe(TOKEN);
    expect(server.assembled()).toEqual(blob);
  });
});
