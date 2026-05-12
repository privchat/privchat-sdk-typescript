// Boundary helpers: business u64 IDs cross between FlatBuffers `bigint`
// and the SDK public API `string`. JS `number` cannot safely represent
// values above 2^53 - 1, so user_id / channel_id / message_id MUST be
// strings at the API surface even when they originate from u64.

/** Decode a u64 from FB to the public API string form. 0n → "0". */
export function bigintToIdString(v: bigint): string {
  return v.toString();
}

/** Encode a public API string ID back to bigint for FlatBuffers. */
export function idStringToBigint(s: string): bigint {
  if (s.length === 0) return 0n;
  return BigInt(s);
}

/** Optional version: empty / "0" / 0n is treated as "absent". */
export function bigintToOptionalIdString(v: bigint): string | undefined {
  return v === 0n ? undefined : v.toString();
}

/** Inverse of bigintToOptionalIdString. */
export function optionalIdStringToBigint(s: string | undefined): bigint {
  if (!s) return 0n;
  return BigInt(s);
}

/** Convert i64 (timestamp) bigint → number. Safe up to ~year 285,425. */
export function bigintToNumber(v: bigint): number {
  return Number(v);
}

/** Convert number → i64 bigint for FlatBuffers writes. */
export function numberToBigint(n: number): bigint {
  return BigInt(Math.trunc(n));
}
