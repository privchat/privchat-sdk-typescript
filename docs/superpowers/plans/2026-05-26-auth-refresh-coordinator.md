# Auth Refresh Coordinator (SDK-owned, Web-injected) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** When the IM access token is rejected as expired — at `authenticate()`, at auto-reconnect replay, or implicitly — the SDK transparently refreshes via a Web-injected, mode-aware callback and retries once; only a terminal refresh failure surfaces a "session expired" signal that Web turns into a "登录已过期，请重新登录" dialog → login.

**Root cause being fixed:** `refreshAccessToken` exists in the SDK but is **never called in production** (only in `mock-adapter`). `connectAccount`/auto-login and `attemptReconnect` (client.ts:3097, replays stale `lastAuth`) drop the user to login on expiry instead of refreshing. Proximate trigger of the reported incident: a privchat-server restart dropped the live WS, forcing `attemptReconnect` to replay an expired token.

**Architecture (approved — option A):** SDK owns refresh orchestration; Web injects the mode-aware refresh implementation and persists rotated tokens; server unchanged (dev-verify only).

**Tech Stack:** TypeScript, vitest (SDK), React/i18next (Web). Web has no unit harness — Web verification is typecheck + the test matrix run manually + (optional) Playwright smoke.

---

## Locked contract (per user)

```ts
// src/auth-refresh.ts (SDK)
export interface AuthRefreshContext {
  reason: 'token_expired' | 'auth_failed_reconnect';
  accessToken?: string;
  refreshToken?: string;
  deviceId?: string;
  userId?: string;
  attempt: number;
}
export interface AuthRefreshResult {
  accessToken: string;
  refreshToken?: string;
  deviceId?: string;
  userId?: string;
}
export interface AuthRefreshConfig {
  refreshAuth: (ctx: AuthRefreshContext) => Promise<AuthRefreshResult>;
  onTokensRefreshed?: (tokens: AuthRefreshResult) => void | Promise<void>;
  onSessionExpired?: (error: SessionExpiredError) => void;
}
```

Configured at **client level** (not per-`authenticate()` call) so it covers SDK-internal auto-reconnect:

```ts
client.configureAuthRefresh({ refreshAuth, onTokensRefreshed, onSessionExpired });
```

### SDK behavior rules (per user — non-negotiable)
1. **Refresh once per expiry.** expired → `refreshAuth` once → replay `authenticate` once → success continue / failure → session expired. No loops.
2. **Single-flight.** Concurrent expiries share one in-flight `refreshAuth` promise (avoid parallel refreshes rotating the refresh token against each other).
3. **Terminal → `sessionExpired`.** Treat as terminal: `RefreshTokenError` 10009 (refresh expired) / 10010 (revoked), platform HTTP 401/403, or any `refreshAuth` throw classified terminal. Emit `sessionExpired`.
4. **On refresh success, update `lastAuth`** (client.ts:609): `access_token` (+ `device_id`/`user_id` if returned). Otherwise the next auto-reconnect replays the stale token and the bug recurs.
5. **Persist ordering:** refresh success → update `lastAuth` → `await onTokensRefreshed` → replay `authenticate`. If `onTokensRefreshed` throws, **do not** abort the live connection (in-memory token is already fresh); `console.warn` only — cold-start persistence is degraded, not the session.

### Events (SDK)
Add to the event bus: `auth_refresh_started`, `auth_refresh_succeeded`, `auth_refresh_failed` (debug/log) and `session_expired` (terminal; Web's only hard dependency). Reuse existing `auth_expired` classification (`auth-error.ts` `errorKind`, `events.ts` `auth_expired`).

---

## Integration points (verified in code)
- `authenticate()` — client.ts:996-1032. Already emits `auth_expired` with `errorKind` terminal/recoverable; sets state. Wrap with the coordinator.
- `attemptReconnect()` — client.ts:3097-3137. Replays `lastAuth` via `authenticate(...)`; on failure `cancelReconnect()`. This is where the incident occurred — must go through the coordinator.
- `refreshAccessToken(refreshToken, deviceId)` — client.ts:1051. Pure RPC (`account/auth/refresh`), throws `RefreshTokenError` on 10009/10010. Reused by the BUILTIN refresh path.
- `lastAuth` — client.ts:609. Update on refresh success.
- `AuthErrorKind` — auth-error.ts:15 (`transient|recoverable|terminal`); `RECOVERABLE_CODES`/`TERMINAL_CODES` classify 10002 (expired) as recoverable.

---

## File structure
- **Create** `privchat-sdk-typescript/src/auth-refresh.ts` — contract types + `SessionExpiredError` + the single-flight `AuthRefreshCoordinator` (pure, testable: takes the refresh config + a "do authenticate" thunk + a "get/set lastAuth" accessor).
- **Modify** `privchat-sdk-typescript/src/client.ts` — `configureAuthRefresh()`; route `authenticate()` recoverable failures and `attemptReconnect()` through the coordinator; emit new events; update `lastAuth` on refresh.
- **Modify** `privchat-sdk-typescript/src/events.ts` — add the 4 event types.
- **Modify** `privchat-sdk-typescript/src/index.ts` — export the new public types.
- **Create** `privchat-sdk-typescript/tests/client/auth-refresh.test.ts` — SDK test matrix.
- **Modify** `privchat-web/src/lib/connect-account.ts` (+ `privchat-client.ts` / wherever the client is built) — call `configureAuthRefresh` with the mode-aware `refreshAuth`, `onTokensRefreshed` (persist), `onSessionExpired`.
- **Create** `privchat-web/src/lib/auth-refresh-provider.ts` — `refreshAuth` dispatch: platform → `platform-auth-provider.refreshToken`; builtin → `client.refreshAccessToken` (RPC). Persist via session storage.
- **Create** `privchat-web/src/features/auth/session-expired-dialog.tsx` — the "登录已过期，请重新登录" dialog.
- **Modify** `privchat-web/src/App.tsx` — subscribe to `session_expired` → show dialog → confirm → `clearSession()` + route to login.
- **Modify** `privchat-web/src/i18n/locales/{en,zh-CN,vi}.ts` — dialog strings.

---

## Stage 1 — SDK coordinator  ·  commit `feat(ts-sdk): auth refresh coordinator`

### Task 1: contract types + `SessionExpiredError`
- [ ] Create `src/auth-refresh.ts` with the interfaces above + `export class SessionExpiredError extends Error { code?: number }`.
- [ ] Export them from `src/index.ts`.
- [ ] Run `npm run typecheck` → no errors. Commit.

### Task 2: single-flight coordinator (pure, TDD)
- [ ] Test `tests/client/auth-refresh.test.ts`: a `Coordinator` given a stub `refreshAuth` and a stub `reauth` thunk:
  - expired → calls `refreshAuth` once → calls `reauth` once with the new token → resolves success.
  - two concurrent `handleExpiry()` calls → `refreshAuth` invoked **once** (single-flight); both resolve.
  - `refreshAuth` throws terminal → `onSessionExpired` called once, result is terminal.
- [ ] Run tests → fail.
- [ ] Implement `AuthRefreshCoordinator` in `auth-refresh.ts`: holds an in-flight `Promise | null`; `handleExpiry(ctx)` reuses it; on success calls `onTokensRefreshed` then the injected `applyTokens`/`reauth`; classifies terminal vs retryable.
- [ ] Run tests → pass. Commit.

### Task 3: wire into `client.ts`
- [ ] Add `configureAuthRefresh(cfg: AuthRefreshConfig)` storing `this.authRefresh`.
- [ ] In `authenticate()` (996): on `AuthorizationError` with `errorKind === 'recoverable'` AND `authRefresh` configured AND not already inside a refresh-retry → invoke coordinator (`reason: 'token_expired'`); on coordinator success the retried `authenticate` resolves; on terminal → emit `session_expired`, rethrow/settle disconnected. Guard against infinite recursion with an internal `isRetrying` flag (rule 1: once).
- [ ] In `attemptReconnect()` (3097): when the replay `authenticate` throws recoverable, route through the coordinator (`reason: 'auth_failed_reconnect'`) before giving up; on success continue the reconnect (subscriptions/sync/outbox); on terminal → `session_expired` + settle disconnected.
- [ ] On coordinator success, update `this.lastAuth` (rule 4) with new access token (+ device/user if present).
- [ ] Emit `auth_refresh_started/succeeded/failed` + `session_expired` (events.ts additions).
- [ ] `npm run typecheck`. Commit.

### Task 4: SDK test matrix (`tests/client/auth-refresh.test.ts`)
- [ ] 1. `authenticate` token expired → refresh success → authenticate retry success (state ends `authenticated`).
- [ ] 2. auto-reconnect replay expired token → refresh success → reconnect ends `authenticated` (simulate via `simulateReconnect`/transport close; client.ts:838 has a reconnect-trigger helper).
- [ ] 3. refresh fails 10009 → `session_expired` emitted, state disconnected.
- [ ] 4. concurrent 10002 (two parallel auth-needing calls) → `refreshAuth` called once.
- [ ] 5. refresh success updates `lastAuth` (assert a subsequent reconnect replays the NEW token).
- [ ] Run full SDK suite `npx vitest run` → all pass. `npm run build`. Commit.

---

## Stage 2 — Web wiring + dialog  ·  commit `feat(web): mode-aware auth refresh + session-expired dialog`

### Task 5: i18n dialog strings (en/zh-CN/vi + LocaleSchema)
- [ ] zh-CN: `session_expired: { title: '登录已过期', body: '请重新登录', confirm: '重新登录' }`. en/vi parallel. Add to `LocaleSchema`. `npm run check:i18n`. Commit.

### Task 6: `auth-refresh-provider.ts` (mode-aware `refreshAuth`)
- [ ] `buildAuthRefresh(session, client)`: platform → `platformAuthProvider.refreshToken(session)` (HTTP `/auth/refresh-token`); builtin → `client.refreshAccessToken(session.refresh_token, session.device_id)`. Map results to `AuthRefreshResult`. Classify HTTP 401/403 and `RefreshTokenError` terminal → rethrow as terminal so SDK fires `session_expired`.
- [ ] Confirm `client.refreshAccessToken` works with an expired access token (it's an RPC over the connected-but-unauthenticated transport; verify against `connected` state — refresh-token.test.ts:74 shows it does not require `authenticated`).
- [ ] `npm run typecheck`. Commit.

### Task 7: wire `configureAuthRefresh` at client construction
- [ ] In `connect-account.ts` (or `privchat-client.ts`), after building the client and before/around `authenticate`, call `client.configureAuthRefresh({ refreshAuth: buildAuthRefresh(session, client), onTokensRefreshed: persist→session-storage, onSessionExpired: emit to App })`.
- [ ] `onTokensRefreshed` writes the new access (+ rotated refresh) token into the persisted session for the active account (rule 5: warn on failure, don't abort).
- [ ] auto-login path uses the same config (so a stale token on cold-start refreshes instead of bouncing to login).
- [ ] `npm run typecheck`. Commit.

### Task 8: `session-expired-dialog.tsx` + App wiring
- [ ] Dialog (Radix, matching existing dialogs): title/body/confirm from i18n; confirm → `clearSession()` + route to login.
- [ ] App.tsx: subscribe to `session_expired` (via the handle's event bus); show the dialog; on confirm dispose handle + go to login. Valid-token path never shows it.
- [ ] `npm run typecheck` + `npm run check:i18n`. Commit.

### Web test matrix (manual / typecheck)
- [ ] 1. BUILTIN refresh success persists new access token.
- [ ] 2. PLATFORM refresh success persists new access + rotated refresh token.
- [ ] 3. refresh terminal failure → expired-login dialog shows.
- [ ] 4. dialog confirm clears session and returns to LoginPage.
- [ ] 5. normal valid token path → no dialog.

---

## Stage 3 — Server dev-verify (only if needed)  ·  commit `chore(server): dev log token exp/iat`
- [ ] Add a dev-only log (or use the existing connect handler) to print decoded `iat`/`exp` of the presented token vs server `now`, to confirm whether a genuinely-fresh token is being rejected. Current evidence (clock OK, 2h TTL, signature valid) says no server bug; this step only fires if Stage 1/2 testing shows a fresh token expiring early. If confirmed, open a follow-up to fix the TTL/exp computation.

---

## Self-review notes
- **Spec coverage:** contract (Task 1), single-flight (Task 2/4#4), refresh-once (Task 3 guard), update lastAuth (Task 3/4#5), terminal→session_expired (Task 3/4#3), reconnect path (Task 3/4#2), persist ordering (Task 7 rule 5), mode-aware web refresh (Task 6), dialog+route (Task 8), server dev-verify (Stage 3). All user test-matrix items mapped.
- **Naming:** `refreshAuth` / `onTokensRefreshed` / `onSessionExpired`; events `auth_refresh_started|succeeded|failed` + `session_expired`; error `SessionExpiredError`. Consistent across SDK + Web.
- **Scope:** SDK is the load-bearing change; Web injects + UX; server untouched unless dev-verify proves a TTL bug.
