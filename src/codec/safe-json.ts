// Lossless-aware JSON parsing for RPC responses.
//
// `JSON.parse` rounds any integer above `Number.MAX_SAFE_INTEGER`
// (~9e15) to the nearest float64-representable value — which is fine
// for sequential primary keys but lethal for snowflake IDs (channel_id,
// server_message_id, message_seq, search_session_id, …) that are
// regularly 18 digits. We hit this in the wild as a silent rounding
// of `search_session_id` to a non-existent value, then a 10004 "Search
// record not found" from the server.
//
// `lossless-json` does the parsing safely and lets us plug in a custom
// per-token number coercer. Our policy:
//
//   - Plain integer that fits in `Number.MAX_SAFE_INTEGER`  → `number`
//     (so existing call sites that do `value + 0` keep working)
//   - Plain integer that DOES NOT fit                       → `string`
//     (caller can `BigInt(value)` if it wants math, otherwise pass
//      through to server / cache as-is)
//   - Floating-point / exponent literal                     → `number`
//     (no precision-preserving need; server doesn't emit floats for
//      ids, just for legitimate fractional fields)
//
// Trade-off: any `*Response` typing that says `: number` on a u64
// field is now "either number or string" at runtime. We keep the type
// declarations honest where the field is known to be snowflake-sized
// (see api-types.ts) and tolerate the soft mismatch elsewhere — the
// vast majority of u64 fields the SDK reads (auth uid, channel_id) are
// converted to `IdString` (string) downstream anyway.

import { parse as losslessParse } from 'lossless-json';

function parseNumberSafe(value: string): number | string {
  // Floats / scientific notation: just use Number. Server doesn't emit
  // 17-digit floats; if it ever does, the precision was already lost
  // before we got here.
  if (/[.eE]/.test(value)) return Number(value);
  // Plain integer. Quick path for small / negative numbers — Number()
  // is exact for anything in [-2^53, 2^53].
  const n = Number(value);
  if (Number.isSafeInteger(n)) return n;
  // Unsafe. Return the original literal as a string so the caller can
  // BigInt(...) or pass through to the next hop without losing digits.
  return value;
}

/** Drop-in replacement for `JSON.parse` that preserves precision for
 *  large integers as strings. Used by `rpcCallTyped` so every typed RPC
 *  response is precision-safe by default. */
export function parseRpcJson<T = unknown>(text: string): T {
  return losslessParse(text, null, parseNumberSafe) as T;
}
