// SDK-owned auth-refresh coordinator.
//
// The SDK detects an expired access token (recoverable auth failure) at
// `authenticate()` and at auto-reconnect replay, then asks the host app —
// via an injected, transport/mode-agnostic `refreshAuth` callback — for a
// fresh token and retries authentication ONCE. The host owns HOW to
// refresh (platform HTTP `/auth/refresh-token`, or the SDK's own
// `account/auth/refresh` RPC for builtin); the SDK owns WHEN and the
// single-flight + retry-once + terminal semantics.
//
// This module is pure (no client/transport/bus deps) so it is unit
// testable in isolation. The client wires it to `authenticate` /
// `attemptReconnect` and emits the L1 events.

export interface AuthRefreshContext {
  /** Which path hit the expiry. */
  reason: 'token_expired' | 'auth_failed_reconnect';
  /** The expired access token (what the SDK currently holds), if any. */
  accessToken?: string;
  /** The SDK does NOT persist refresh tokens; present only if the host
   *  threaded one through. Web's `refreshAuth` reads its own session. */
  refreshToken?: string;
  deviceId?: string;
  userId?: string;
  /** 1 for the first (and only) refresh attempt of this expiry. */
  attempt: number;
}

export interface AuthRefreshResult {
  accessToken: string;
  /** Present only when the server rotated it; otherwise the host keeps
   *  the previous refresh token (merge semantics live in the host). */
  refreshToken?: string;
  deviceId?: string;
  userId?: string;
}

export interface AuthRefreshConfig {
  /** Host-provided refresh. MUST throw (ideally a terminal-classified
   *  error) when refresh is impossible — the SDK then fires
   *  `session_expired`. */
  refreshAuth: (ctx: AuthRefreshContext) => Promise<AuthRefreshResult>;
  /** Called after a successful refresh so the host can persist the new
   *  tokens. Failures here MUST NOT abort the live session (the in-memory
   *  token is already fresh) — the coordinator swallows + warns. */
  onTokensRefreshed?: (tokens: AuthRefreshResult) => void | Promise<void>;
  /** Called at most once when the session is terminally expired. */
  onSessionExpired?: (error: SessionExpiredError) => void;
}

/** Terminal: refresh rejected or impossible; the host must re-login. */
export class SessionExpiredError extends Error {
  readonly code?: number;
  constructor(message: string, code?: number) {
    super(message);
    this.name = 'SessionExpiredError';
    this.code = code;
  }
}

/**
 * Single-flight refresh. Stateless w.r.t. the connection — the client
 * applies the returned tokens by re-authenticating, and owns the (once-only)
 * `session_expired` signalling.
 */
export class AuthRefreshCoordinator {
  private inflight: Promise<AuthRefreshResult> | null = null;

  constructor(private readonly cfg: AuthRefreshConfig) {}

  /**
   * Run `refreshAuth` (single-flight: concurrent callers share one
   * in-flight promise) and persist via `onTokensRefreshed`. Resolves with
   * the new tokens; rejects (propagating the refresh error) when refresh
   * fails — the caller decides terminal handling.
   */
  refresh(ctx: AuthRefreshContext): Promise<AuthRefreshResult> {
    if (this.inflight !== null) return this.inflight;
    this.inflight = (async () => {
      const result = await this.cfg.refreshAuth(ctx);
      if (this.cfg.onTokensRefreshed) {
        try {
          await this.cfg.onTokensRefreshed(result);
        } catch (e) {
          // Rule 5: persistence failure must not abort the live session —
          // the in-memory token is already fresh. Cold-start persistence
          // is degraded; warn and continue.
          console.warn(
            '[privchat] onTokensRefreshed failed; in-memory token is fresh, ' +
              'but persisted session was not updated (cold-start will need re-auth)',
            e,
          );
        }
      }
      return result;
    })();
    return this.inflight.finally(() => {
      this.inflight = null;
    });
  }
}
