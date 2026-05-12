// AuthErrorKind classification mirroring Rust `privchat_sdk::AuthErrorKind` /
// `classify_auth_error_code`. Frozen by `TOKEN_REFRESH_SPEC`:
//   10000 AuthRequired       → Recoverable (RPC saw missing/stale access token)
//   10002 TokenExpired       → Recoverable (refresh can save it)
//   10001 / 10003..10010     → Terminal   (forced logout territory)
//   any other auth-band code → Transient  (conservative default; retry)
//
// Business layer pattern:
//   try { await client.authenticate(...) }
//   catch (e) {
//     if (e.errorKind === 'recoverable') { /* call refreshAccessToken + retry */ }
//     else if (e.errorKind === 'terminal') { /* force logout */ }
//   }

export type AuthErrorKind = 'transient' | 'recoverable' | 'terminal';

const RECOVERABLE_CODES = new Set<number>([
  10000, // AuthRequired (RPC-side: missing / stale access token)
  10002, // TokenExpired (access token expired; refresh path)
]);

const TERMINAL_CODES = new Set<number>([
  10001, // InvalidToken
  10003, // TokenRevoked
  10004, // PermissionDenied
  10005, // SessionExpired
  10006, // SessionNotFound
  10007, // UserBanned
  10008, // IpNotAllowed
  10009, // RefreshTokenExpired
  10010, // RefreshTokenRevoked
]);

export function classifyAuthErrorCode(code: number): AuthErrorKind {
  if (RECOVERABLE_CODES.has(code)) return 'recoverable';
  if (TERMINAL_CODES.has(code)) return 'terminal';
  return 'transient';
}

/**
 * Extracts the leading `[<code>] ...` numeric prefix from an auth error
 * message string (Rust SDK convention). Returns `undefined` if absent so
 * callers can fall back to the explicit `error_code` field.
 */
export function parseAuthErrorPrefix(message: string | undefined): number | undefined {
  if (!message) return undefined;
  const m = /^\[(\d+)\]/.exec(message);
  return m ? Number(m[1]) : undefined;
}
