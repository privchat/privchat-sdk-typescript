// 附件加密 v1（ATTACHMENT_ENCRYPTION_SPEC §3）：AES-256-GCM 整文件加密，浏览器 WebCrypto。
//
// 与 Rust SDK（crates/privchat-sdk/src/attachment_crypto.rs）**字节级互通**：
//   - blob = nonce(12B) || ciphertext || tag(16B)
//     WebCrypto 的 `crypto.subtle.encrypt({name:'AES-GCM'})` 输出已把 16B tag 拼在密文尾，
//     与 Rust `aes-gcm` 一致，故双方按此 blob 约定即可互解。
//   - cek = base64url(no-pad) 的 32 字节随机密钥。
//   - nonce 写进 blob 头部，不入库、不进 API。
//
// **CEK 绝不进日志 / URL / localStorage / IndexedDB。**

export const NONCE_LEN = 12;
export const TAG_LEN = 16;
export const CEK_LEN = 32;
/** 最小密文 blob：12 nonce + 16 tag（空明文边界）。 */
export const MIN_BLOB_LEN = NONCE_LEN + TAG_LEN;

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
export async function encryptAttachment(
  plaintext: Uint8Array,
): Promise<{ blob: Uint8Array; cek: string }> {
  const cekBytes = randomBytes(CEK_LEN);
  const nonce = randomBytes(NONCE_LEN);
  const key = await importKey(cekBytes, 'encrypt');
  const ctWithTag = new Uint8Array(
    await subtleCrypto().encrypt({ name: 'AES-GCM', iv: nonce as BufferSource }, key, plaintext as BufferSource),
  );
  const blob = new Uint8Array(NONCE_LEN + ctWithTag.length);
  blob.set(nonce, 0);
  blob.set(ctWithTag, NONCE_LEN);
  return { blob, cek: toBase64Url(cekBytes) };
}

/**
 * 解密 `blob (nonce||ct||tag)` + `cek(base64url)` → 明文。
 * GCM tag 校验失败（错 key / 篡改）抛错。
 */
export async function decryptAttachment(blob: Uint8Array, cekB64: string): Promise<Uint8Array> {
  if (blob.length < MIN_BLOB_LEN) {
    throw new Error(`attachment blob too short: ${blob.length} < ${MIN_BLOB_LEN}`);
  }
  const cek = fromBase64Url(cekB64);
  if (cek.length !== CEK_LEN) {
    throw new Error(`cek must be ${CEK_LEN} bytes, got ${cek.length}`);
  }
  const nonce = blob.subarray(0, NONCE_LEN);
  const ctWithTag = blob.subarray(NONCE_LEN);
  const key = await importKey(cek, 'decrypt');
  try {
    return new Uint8Array(
      await subtleCrypto().decrypt({ name: 'AES-GCM', iv: nonce as BufferSource }, key, ctWithTag as BufferSource),
    );
  } catch {
    throw new Error('attachment decrypt/auth failed');
  }
}

/**
 * 下载完成后按加密信息把 blob 还原成明文。
 *   - version=0（或缺失视为 0）→ legacy 明文，原样返回。
 *   - version=1 → cek **必须存在**，blob 校验 + 解密；缺 cek 或解密失败一律抛错，
 *     **绝不 fallback 成明文**（否则把密文当图片，UI 显示坏图并掩盖错误）。
 */
export async function decryptDownloadedAttachment(
  encryptionVersion: number,
  cek: string | null | undefined,
  blob: Uint8Array,
): Promise<Uint8Array> {
  if (encryptionVersion === 0) return blob;
  if (encryptionVersion === 1) {
    if (cek === null || cek === undefined || cek === '') {
      throw new Error('encryption_version=1 but cek missing');
    }
    return decryptAttachment(blob, cek);
  }
  throw new Error(`unsupported encryption_version: ${encryptionVersion}`);
}
