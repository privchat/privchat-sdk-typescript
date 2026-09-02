// 附件加密（ATTACHMENT_ENCRYPTION_SPEC）：全站密钥 + **分块** AES-256-GCM，浏览器 WebCrypto。
//
// 与 Rust（privchat-protocol/src/attachment_crypto.rs）**字节级互通**。线格式：
//
//   header(36B) || chunk[0] || chunk[1] || ...
//   header = magic("PC") || format_version(1) || key_id(1) || object_id(16)
//            || chunk_plain_size(4, BE) || chunk_count(4, BE) || plaintext_size(8, BE)
//   chunk  = nonce(12) || plaintext_len(4, BE) || ciphertext || tag(16)
//   AAD    = sha256(header) || index(4, BE) || plaintext_len(4, BE)
//
// 🔴 **每块一个独立随机 nonce**，不是"对象前缀 + 序号"：全站共用一把密钥时，
//    前缀碰撞会导致 GCM nonce 重用——那是灾难性的（泄露明文异或、可伪造）。
//
// 🔴 **AAD 绑定 header 摘要 + 块序号 + 块长度**：独立 tag 只能证明某块没被改，
//    证明不了它属于这个文件、在这个位置。绑上之后乱序、跨对象嫁接、截断全部变成认证失败。
//
// 🔴 密钥是**服务端下发的全站密钥**，不是 per-file CEK：申请 token 时才拿得到，
//    所以封装只能发生在 prepare 之后。判重键是**明文**摘要（密文每次封装都不同）。
//
// **密钥绝不进日志 / URL / localStorage / IndexedDB。**

export const NONCE_LEN = 12;
export const TAG_LEN = 16;
export const KEY_LEN = 32;
export const OBJECT_ID_LEN = 16;
/** magic(2)+ver(1)+key_id(1)+object_id(16)+chunk_size(4)+chunk_count(4)+plain_size(8) */
export const HEADER_LEN = 36;
/** 每块定长开销：nonce(12) + plaintext_len(4) + tag(16)。 */
export const CHUNK_OVERHEAD = NONCE_LEN + 4 + TAG_LEN;
export const FORMAT_VERSION = 1;
const MAGIC = [0x50, 0x43]; // "PC"

/** 封装之后的总字节数——必须与服务端 `sealed_len` 逐字节一致。 */
export function sealedLen(plaintextSize: number, chunkPlainSize: number): number {
  if (chunkPlainSize <= 0) throw new Error('chunk_plain_size must be > 0');
  const chunks = plaintextSize === 0 ? 1 : Math.ceil(plaintextSize / chunkPlainSize);
  return HEADER_LEN + chunks * CHUNK_OVERHEAD + plaintextSize;
}

function chunkCountFor(plaintextSize: number, chunkPlainSize: number): number {
  return plaintextSize === 0 ? 1 : Math.ceil(plaintextSize / chunkPlainSize);
}

/** 浏览器 + Node 通用的 WebCrypto 句柄。 */
function subtleCrypto(): SubtleCrypto {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.subtle === undefined) {
    throw new Error('WebCrypto (crypto.subtle) unavailable in this environment');
  }
  return c.subtle;
}

function randomBytes(len: number): Uint8Array {
  const out = new Uint8Array(len);
  // 禁用 Math.random — 必须 CSPRNG。
  (globalThis.crypto as Crypto).getRandomValues(out);
  return out;
}

/** Uint8Array → base64url(no-pad)。浏览器/Node 通用（不依赖 Buffer）。 */
export function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** base64url(no-pad) → Uint8Array。容忍标准 base64 与 padding。 */
export function fromBase64Url(s: string): Uint8Array {
  let b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4 !== 0) b64 += '=';
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function importKey(cek: Uint8Array, usage: KeyUsage): Promise<CryptoKey> {
  return subtleCrypto().importKey('raw', cek as BufferSource, { name: 'AES-GCM' }, false, [usage]);
}

/**
 * 加密明文 → `{ blob, cek }`。CSPRNG 生成 cek + nonce。
 * blob 直接上传对象存储；cek 走 file 表 / 鉴权后的 get_url 响应。
 */
function be32(v: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, v, false);
  return b;
}

function buildHeader(
  keyId: number,
  objectId: Uint8Array,
  chunkPlainSize: number,
  chunkCount: number,
  plaintextSize: number,
): Uint8Array {
  const h = new Uint8Array(HEADER_LEN);
  h[0] = MAGIC[0]!;
  h[1] = MAGIC[1]!;
  h[2] = FORMAT_VERSION;
  h[3] = keyId;
  h.set(objectId, 4);
  const dv = new DataView(h.buffer);
  dv.setUint32(20, chunkPlainSize, false);
  dv.setUint32(24, chunkCount, false);
  // plaintext_size 是 u64 BE；JS 用 BigInt 写，避免 >2^53 时静默失真。
  dv.setBigUint64(28, BigInt(plaintextSize), false);
  return h;
}

async function sha256Bytes(bytes: Uint8Array): Promise<Uint8Array> {
  const d = await subtleCrypto().digest('SHA-256', bytes.slice().buffer as ArrayBuffer);
  return new Uint8Array(d);
}

/** AAD = sha256(header) || index(4 BE) || plaintext_len(4 BE)。 */
function chunkAad(headerDigest: Uint8Array, index: number, plaintextLen: number): Uint8Array {
  const aad = new Uint8Array(headerDigest.length + 8);
  aad.set(headerDigest, 0);
  aad.set(be32(index), headerDigest.length);
  aad.set(be32(plaintextLen), headerDigest.length + 4);
  return aad;
}

/** 服务端下发的密钥是 base64url(no-pad) 的 32 字节。 */
export function decodeSiteKey(encoded: string): Uint8Array {
  const raw = fromBase64Url(encoded.trim());
  if (raw.length !== KEY_LEN) {
    throw new Error(`attachment key must be ${KEY_LEN} bytes, got ${raw.length}`);
  }
  return raw;
}

/**
 * 明文 → 待上传密文，用**服务端下发的**全站密钥与冻结的块大小。
 *
 * 🔴 顺序是"先申请 token、后封装"，不能反：密钥在 token 响应里。块大小也必须原样
 * 用服务端给的——token 冻结的密文长度是按它算的，用别的值封出来的对象在 complete
 * 的长度核对上必然被拒。
 */
export async function sealAttachment(
  plaintext: Uint8Array,
  siteKey: Uint8Array,
  keyId: number,
  chunkPlainSize: number,
): Promise<SealedAttachment> {
  if (siteKey.length !== KEY_LEN) throw new Error('site key must be 32 bytes');
  const chunkCount = chunkCountFor(plaintext.length, chunkPlainSize);
  const objectId = randomBytes(OBJECT_ID_LEN);
  const header = buildHeader(keyId, objectId, chunkPlainSize, chunkCount, plaintext.length);
  const headerDigest = await sha256Bytes(header);
  const key = await importKey(siteKey, 'encrypt');

  const out = new Uint8Array(sealedLen(plaintext.length, chunkPlainSize));
  out.set(header, 0);
  let off = HEADER_LEN;
  for (let index = 0; index < chunkCount; index++) {
    const start = index * chunkPlainSize;
    const part = plaintext.subarray(start, Math.min(start + chunkPlainSize, plaintext.length));
    const nonce = randomBytes(NONCE_LEN);
    const sealed = new Uint8Array(
      await subtleCrypto().encrypt(
        { name: 'AES-GCM', iv: nonce as BufferSource, additionalData: chunkAad(headerDigest, index, part.length) as BufferSource },
        key,
        part.slice().buffer as ArrayBuffer,
      ),
    );
    out.set(nonce, off);
    out.set(be32(part.length), off + NONCE_LEN);
    out.set(sealed, off + NONCE_LEN + 4);
    off += CHUNK_OVERHEAD + part.length;
  }
  if (off !== out.length) {
    throw new Error(`sealed length mismatch: wrote ${off}, expected ${out.length}`);
  }
  return { blob: out, sha256: await sha256Hex(out) };
}

/** 这段字节是不是本格式的密文（自描述文件头）。 */
export function looksLikeAttachment(bytes: Uint8Array): boolean {
  return bytes.length >= HEADER_LEN && bytes[0] === MAGIC[0] && bytes[1] === MAGIC[1]
    && bytes[2] === FORMAT_VERSION;
}

/**
 * 密文 → 明文。逐块验证 AAD：乱序、嫁接、截断都会在这里认证失败。
 *
 * 🔴 解不开就抛，绝不退回"把密文当明文返回"——那产出的是一张坏图，
 * 错误被藏起来只在用户眼前显形。
 */
export async function decryptAttachment(blob: Uint8Array, siteKey: Uint8Array): Promise<Uint8Array> {
  if (!looksLikeAttachment(blob)) throw new Error('not an encrypted attachment blob');
  const dv = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  const keyIdInBlob = blob[3]!;
  const chunkPlainSize = dv.getUint32(20, false);
  const chunkCount = dv.getUint32(24, false);
  const plaintextSize = Number(dv.getBigUint64(28, false));
  if (chunkPlainSize === 0 || chunkCount === 0) throw new Error('invalid attachment geometry');
  if (blob.length !== sealedLen(plaintextSize, chunkPlainSize)) {
    throw new Error('attachment length does not match its header');
  }
  void keyIdInBlob; // 选钥匙由调用方按 key_id 做；这里只解。

  const headerDigest = await sha256Bytes(blob.subarray(0, HEADER_LEN));
  const key = await importKey(siteKey, 'decrypt');
  const out = new Uint8Array(plaintextSize);
  let off = HEADER_LEN;
  let written = 0;
  for (let index = 0; index < chunkCount; index++) {
    const nonce = blob.subarray(off, off + NONCE_LEN);
    const plainLen = dv.getUint32(off + NONCE_LEN, false);
    const body = blob.subarray(off + NONCE_LEN + 4, off + CHUNK_OVERHEAD + plainLen);
    const opened = new Uint8Array(
      await subtleCrypto().decrypt(
        { name: 'AES-GCM', iv: nonce.slice() as BufferSource, additionalData: chunkAad(headerDigest, index, plainLen) as BufferSource },
        key,
        body.slice().buffer as ArrayBuffer,
      ),
    );
    out.set(opened, written);
    written += opened.length;
    off += CHUNK_OVERHEAD + plainLen;
  }
  if (written !== plaintextSize) throw new Error('plaintext length does not match the header');
  return out;
}

/** 下载完成后把字节还原成明文。没有密钥 = 明文对象，原样返回。 */
export async function decryptDownloadedAttachment(
  blob: Uint8Array,
  attachmentKey: string | null | undefined,
): Promise<Uint8Array> {
  if (attachmentKey === null || attachmentKey === undefined || attachmentKey === '') {
    // 🔴 分流由**票据**说了算（服务端按对象行的 key_id 决定发不发密钥），
    // 不看字节的 magic——那只是一段可以被构造出来的前缀。
    return blob;
  }
  return decryptAttachment(blob, decodeSiteKey(attachmentKey));
}

/** 已封装好、可以直接上传的最终 blob。 */
export interface SealedAttachment {
  /** 要上传的那串字节。 */
  blob: Uint8Array;
  /** 上面那串字节的 SHA-256（hex）。**不是判重键**，只用于本地缓存自检。 */
  sha256: string;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes.slice().buffer as ArrayBuffer);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
