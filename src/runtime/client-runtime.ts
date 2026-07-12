/**
 * Client runtime reliability layer (CLIENT_GLOBAL_STATE §17, P4.2 cross-client alignment).
 *
 * The single runtime truth for the three stability chains — connectivity / sync / send —
 * mirroring the KMP app's `ClientRuntime` semantics on the TS stack. UI (react/web/h5)
 * subscribes to these slices; pages must not judge SDK connection/sync/send state
 * themselves. Banner display is decided solely by [resolveRuntimeBanner] with a locked
 * priority identical to the app.
 *
 * Event sources are the real TS SDK surfaces (no fabricated events):
 *  - `onConnectionStateChanged` — 7-state lifecycle incl. an explicit `reconnecting`
 *  - `onAuthExpired` — terminal auth loss
 *  - `observeOutbox` — persistent outbox snapshots (queue depth / failed count)
 *  - `navigator.onLine` + window online/offline — device reachability
 *
 * Honest gap (documented, not faked): the TS SDK runs post-reconnect sync inline and
 * emits no resume_sync_started/completed events, so `sync.resumeSyncRunning` only changes
 * via [markSyncStarted]/[markSyncCompleted] fed by the integration layer, and
 * `initialSyncCompleted` is set on the first `authenticated` (the TS connect flow
 * completes its sync inside that transition).
 */

import type { ConnectionState } from '../events.js';
import type { OutboxEntry } from '../cache/types.js';

// ========== Unified error model ==========

export type ClientRuntimeError =
  | { kind: 'network_unavailable' }
  | { kind: 'gateway_disconnected' }
  | { kind: 'auth_expired' }
  | { kind: 'server_busy' }
  | { kind: 'sync_failed'; rawReason: string }
  | { kind: 'unknown'; rawReason: string };

/**
 * Server busy / rate-limit detection — the single entry (same rule as the app):
 * protocol `ErrorCode.SystemBusy = 2` / `RateLimitExceeded = 10300`, or reason text.
 */
export function isServerBusySignal(errorCode?: number | null, reason?: string | null): boolean {
  if (errorCode === 2 || errorCode === 10300) return true;
  if (typeof reason !== 'string') return false;
  const m = reason.toLowerCase();
  return (
    m.includes('system busy') ||
    m.includes('server busy') ||
    m.includes('rate limit') ||
    m.includes('too many requests')
  );
}

// ========== State slices ==========

export interface ConnectivityRuntimeState {
  networkReachable: boolean;
  gatewayConnected: boolean;
  authenticated: boolean;
  reconnecting: boolean;
  reconnectAttempt: number;
  serverBusy: boolean;
  lastConnectedAt: number | null;
  lastDisconnectedAt: number | null;
  lastError: ClientRuntimeError | null;
}

export interface SyncRuntimeState {
  initialSyncCompleted: boolean;
  resumeSyncRunning: boolean;
  lastSyncAt: number | null;
  globalError: ClientRuntimeError | null;
}

/**
 * Send-queue runtime **summary** over the persisted outbox (the outbox itself — IDB
 * entries, per-message status, retry — remains the send-state source of truth).
 */
export interface SendQueueRuntimeState {
  outboundQueued: number;
  failedCount: number;
  lastFailureAt: number | null;
}

const initialConnectivity: ConnectivityRuntimeState = {
  networkReachable: true,
  gatewayConnected: false,
  authenticated: false,
  reconnecting: false,
  reconnectAttempt: 0,
  serverBusy: false,
  lastConnectedAt: null,
  lastDisconnectedAt: null,
  lastError: null,
};

const initialSync: SyncRuntimeState = {
  initialSyncCompleted: false,
  resumeSyncRunning: false,
  lastSyncAt: null,
  globalError: null,
};

const initialSend: SendQueueRuntimeState = {
  outboundQueued: 0,
  failedCount: 0,
  lastFailureAt: null,
};

// ========== Minimal framework-agnostic store (useSyncExternalStore-compatible) ==========

export interface RuntimeSlice<T> {
  getState(): T;
  subscribe(listener: () => void): () => void;
}

class Slice<T> implements RuntimeSlice<T> {
  private state: T;
  private listeners = new Set<() => void>();
  constructor(initial: T) {
    this.state = initial;
  }
  getState(): T {
    return this.state;
  }
  set(next: T): void {
    if (next === this.state) return;
    this.state = next;
    for (const l of [...this.listeners]) l();
  }
  update(fn: (cur: T) => T): void {
    this.set(fn(this.state));
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

// ========== Banner resolver (locked priority — do not reorder without review) ==========

export type RuntimeBannerKind =
  | 'auth_expired'
  | 'offline'
  | 'reconnecting'
  | 'connecting'
  | 'server_busy'
  | 'syncing'
  | 'connected'
  | 'hidden';

/**
 * The single banner decision function (pure; identical priority to the app):
 *
 *   AuthExpired > NetworkUnavailable(offline)
 *     > [authenticated: ServerBusy > ResumeSyncRunning(syncing) > Connected(brief) > Hidden]
 *     > Reconnecting > Connecting > Offline(red) > Hidden
 */
export function resolveRuntimeBanner(
  connectivity: ConnectivityRuntimeState,
  sync: SyncRuntimeState,
  hasStartedConnectionFlow: boolean,
  showConnectedBanner: boolean,
): RuntimeBannerKind {
  if (connectivity.lastError?.kind === 'auth_expired' && hasStartedConnectionFlow) {
    return 'auth_expired';
  }
  if (!connectivity.networkReachable && hasStartedConnectionFlow) return 'offline';
  if (connectivity.authenticated) {
    if (connectivity.serverBusy) return 'server_busy';
    if (sync.resumeSyncRunning) return 'syncing';
    return showConnectedBanner ? 'connected' : 'hidden';
  }
  if (connectivity.reconnecting && hasStartedConnectionFlow) return 'reconnecting';
  if (connectivity.gatewayConnected) return 'connecting';
  if (hasStartedConnectionFlow) return 'offline';
  return 'hidden';
}

// ========== Runtime object ==========

/** Minimal structural view of PrivchatClient (only public APIs that exist today). */
export interface RuntimeClientLike {
  onConnectionStateChanged(cb: (event: { state: ConnectionState }) => void): () => void;
  onAuthExpired?(cb: (event: unknown) => void): () => void;
  observeOutbox?(cb: (entries: OutboxEntry[]) => void): () => void;
}

export interface ClientRuntime {
  connectivity: RuntimeSlice<ConnectivityRuntimeState>;
  sync: RuntimeSlice<SyncRuntimeState>;
  send: RuntimeSlice<SendQueueRuntimeState>;
  /**
   * Seed connectivity/sync from the CURRENT connection state — for consumers
   * that construct the runtime AFTER the client already reached a stable state
   * (e.g. a chat page mounting post auto-login, which never sees the
   * `authenticated` transition event). Idempotent; safe to call with any state.
   */
  seedConnectionState(state: ConnectionState): void;
  /** Integration-layer feeds (TS SDK has no resume-sync events; see module doc). */
  markSyncStarted(): void;
  markSyncCompleted(): void;
  markSyncFailed(rawReason: string, errorCode?: number | null): void;
  onServerBusySignal(): void;
  /** Logout / account switch — clears everything (anti cross-account bleed). */
  reset(): void;
  /** Detach all SDK/browser listeners. */
  dispose(): void;
}

export function createClientRuntime(client: RuntimeClientLike): ClientRuntime {
  const connectivity = new Slice(initialConnectivity);
  const sync = new Slice(initialSync);
  const send = new Slice(initialSend);
  let hadSession = false;
  const unsubs: Array<() => void> = [];

  const clearServerBusy = (): void => {
    connectivity.update((c) =>
      c.serverBusy || c.lastError?.kind === 'server_busy'
        ? {
            ...c,
            serverBusy: false,
            lastError: c.lastError?.kind === 'server_busy' ? null : c.lastError,
          }
        : c,
    );
  };

  // Connectivity/sync mapping for one connection state. Extracted so it can
  // be driven both by live `connection_state_changed` events AND by an initial
  // seed (`seedConnectionState`) — a component that mounts AFTER the client is
  // already `authenticated` never receives the transition event, so without a
  // seed the connectivity slice would stay `authenticated:false` and the banner
  // would wrongly show "offline/已断开" over a fully working connection.
  const applyConnectionState = (state: ConnectionState): void => {
    const now = Date.now();
    connectivity.update((c) => {
      switch (state) {
          case 'authenticated':
            hadSession = true;
            return {
              ...c,
              gatewayConnected: true,
              authenticated: true,
              reconnecting: false,
              reconnectAttempt: 0,
              serverBusy: false,
              lastConnectedAt: now,
              lastError: null,
            };
          case 'connected':
          case 'authenticating':
            return { ...c, gatewayConnected: true, authenticated: false, reconnecting: hadSession };
          case 'connecting':
            return {
              ...c,
              gatewayConnected: false,
              authenticated: false,
              reconnecting: hadSession,
              reconnectAttempt: hadSession ? c.reconnectAttempt + 1 : c.reconnectAttempt,
            };
          case 'reconnecting':
            return {
              ...c,
              gatewayConnected: false,
              authenticated: false,
              reconnecting: true,
              reconnectAttempt: c.reconnectAttempt + 1,
            };
          default: // disconnected / closing
            return {
              ...c,
              gatewayConnected: false,
              authenticated: false,
              reconnecting: hadSession,
              lastDisconnectedAt: now,
              lastError: c.networkReachable
                ? { kind: 'gateway_disconnected' }
                : { kind: 'network_unavailable' },
            };
        }
      });
      // TS SDK 的连接流程在 authenticated 前已完成同步（无独立 resume 事件）：
      // 首次 authenticated 即标记初始同步完成。
      if (state === 'authenticated') {
        sync.update((s) =>
          s.initialSyncCompleted ? s : { ...s, initialSyncCompleted: true, lastSyncAt: Date.now() },
        );
      }
  };

  // ---- connectivity ← connection_state_changed ----
  unsubs.push(client.onConnectionStateChanged(({ state }) => applyConnectionState(state)));

  // ---- connectivity ← auth_expired ----
  if (client.onAuthExpired) {
    unsubs.push(
      client.onAuthExpired(() => {
        connectivity.update((c) => ({
          ...c,
          authenticated: false,
          reconnecting: false,
          lastError: { kind: 'auth_expired' },
        }));
      }),
    );
  }

  // ---- send ← outbox snapshots ----
  if (client.observeOutbox) {
    unsubs.push(
      client.observeOutbox((entries) => {
        const queued = entries.filter(
          (e) => e.status === 'pending' || e.status === 'sending',
        ).length;
        const failed = entries.filter((e) => e.status === 'failed').length;
        send.update((s) => ({
          outboundQueued: queued,
          failedCount: failed,
          lastFailureAt: failed > s.failedCount ? Date.now() : s.lastFailureAt,
        }));
        if (queued === 0 && failed === 0 && entries.length === 0) clearServerBusy();
      }),
    );
  }

  // ---- connectivity ← browser reachability ----
  if (typeof window !== 'undefined' && typeof navigator !== 'undefined') {
    const setReachable = (reachable: boolean): void => {
      connectivity.update((c) => ({
        ...c,
        networkReachable: reachable,
        lastError: reachable ? c.lastError : { kind: 'network_unavailable' },
      }));
    };
    if (navigator.onLine === false) setReachable(false);
    const onOnline = (): void => setReachable(true);
    const onOffline = (): void => setReachable(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    unsubs.push(() => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    });
  }

  return {
    connectivity,
    sync,
    send,
    seedConnectionState: applyConnectionState,
    markSyncStarted(): void {
      sync.update((s) => ({ ...s, resumeSyncRunning: true, globalError: null }));
    },
    markSyncCompleted(): void {
      sync.update((s) => ({
        ...s,
        resumeSyncRunning: false,
        initialSyncCompleted: true,
        lastSyncAt: Date.now(),
        globalError: null,
      }));
      clearServerBusy();
    },
    markSyncFailed(rawReason: string, errorCode?: number | null): void {
      if (isServerBusySignal(errorCode ?? null, rawReason)) {
        connectivity.update((c) => ({
          ...c,
          serverBusy: true,
          lastError: { kind: 'server_busy' },
        }));
      }
      sync.update((s) => ({
        ...s,
        resumeSyncRunning: false,
        globalError: { kind: 'sync_failed', rawReason },
      }));
    },
    onServerBusySignal(): void {
      connectivity.update((c) => ({ ...c, serverBusy: true, lastError: { kind: 'server_busy' } }));
    },
    reset(): void {
      hadSession = false;
      connectivity.set({
        ...initialConnectivity,
        networkReachable: connectivity.getState().networkReachable,
      });
      sync.set(initialSync);
      send.set(initialSend);
    },
    dispose(): void {
      for (const u of unsubs.splice(0)) u();
    },
  };
}
