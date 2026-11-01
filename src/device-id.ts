/**
 * The device id every PrivChat / Weey client and server uses: a random UUID v4 (RFC 4122 variant),
 * lowercase and hyphenated. A host creates it once with [newDeviceId], persists it, and passes the
 * same value on every later login, authenticate and refresh. Mirrors the Rust SDK.
 */
const CANONICAL_DEVICE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isCanonicalDeviceId(id: string): boolean {
  return CANONICAL_DEVICE_ID.test(id);
}

/** A new device id from the platform's secure random source. */
export function newDeviceId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Thrown before anything is sent when a device id is not in the canonical form. */
export class InvalidDeviceIdError extends Error {
  constructor(readonly deviceId: string) {
    super(`device_id must be a lowercase hyphenated UUID v4: ${deviceId}`);
    this.name = 'InvalidDeviceIdError';
  }
}

export function requireCanonicalDeviceId(id: string): void {
  if (!isCanonicalDeviceId(id)) throw new InvalidDeviceIdError(id);
}
