/**
 * P4.2 cross-client alignment tests — TS runtime layer must match the KMP app's
 * canonical semantics (display-name rule, avatar freshness, banner priority,
 * runtime state machine). Mirrors privchat-app ClientRuntimeTest (20 cases) where
 * the surfaces are equivalent.
 */
import { describe, expect, it } from 'vitest';

import { isSystemUser, userDisplayName } from '../../src/runtime/user-display.js';
import { resolveAvatarModel } from '../../src/runtime/avatar-model.js';
import {
  createClientRuntime,
  isServerBusySignal,
  resolveRuntimeBanner,
  type ConnectivityRuntimeState,
  type RuntimeClientLike,
  type SyncRuntimeState,
} from '../../src/runtime/client-runtime.js';
import type { ConnectionState } from '../../src/events.js';
import type { OutboxEntry } from '../../src/cache/types.js';

// ---------- user-display ----------

describe('userDisplayName (canonical rule: remark > nickname > username > uid)', () => {
  it('applies precedence', () => {
    expect(
      userDisplayName({ remark: '备注', nickname: '昵称', username: 'alice', userId: 7 }),
    ).toBe('备注');
    expect(userDisplayName({ nickname: '昵称', username: 'alice', userId: 7 })).toBe('昵称');
    expect(userDisplayName({ username: 'alice', userId: 7 })).toBe('alice');
    expect(userDisplayName({ userId: 7 })).toBe('7');
    expect(userDisplayName({ remark: '  ', nickname: '', username: 'alice' })).toBe('alice');
  });

  it('system user is detected by user_type (never uid) and localized', () => {
    expect(isSystemUser({ userType: 1 })).toBe(true);
    expect(isSystemUser({ username: 'system' })).toBe(true);
    expect(isSystemUser({ username: '__system_1__' })).toBe(true);
    expect(isSystemUser({ userType: 0, username: 'alice' })).toBe(false);
    // uid must NOT be a system signal
    expect(isSystemUser({ userType: 0, username: 'u1' })).toBe(false);
    expect(
      userDisplayName({ userType: 1, username: 'system', systemName: '系统消息', nickname: 'System Message' }),
    ).toBe('系统消息');
  });
});

// ---------- avatar model ----------

describe('resolveAvatarModel (freshness four-state)', () => {
  it('fresh_local when cachedUrl matches remote', () => {
    const m = resolveAvatarModel({
      userId: 42,
      remoteUrl: 'https://cdn/a.png',
      cachedUrl: 'https://cdn/a.png',
      localUrl: 'blob:x',
    });
    expect(m.freshness).toBe('fresh_local');
    expect(m.localUrl).toBe('blob:x');
    expect(m.seed).toBe('u:42');
  });

  it('stale_local keeps local display when remote changed', () => {
    const m = resolveAvatarModel({
      userId: 42,
      remoteUrl: 'https://cdn/b.png',
      cachedUrl: 'https://cdn/a.png',
      localUrl: 'blob:x',
    });
    expect(m.freshness).toBe('stale_local');
    expect(m.localUrl).toBe('blob:x');
  });

  it('remote_only / fallback', () => {
    expect(resolveAvatarModel({ userId: 1, remoteUrl: 'https://cdn/a.png' }).freshness).toBe(
      'remote_only',
    );
    expect(resolveAvatarModel({ userId: 1 }).freshness).toBe('fallback');
    expect(resolveAvatarModel({ userId: 1, remoteUrl: '  ' }).freshness).toBe('fallback');
  });
});

// ---------- server busy ----------

describe('isServerBusySignal', () => {
  it('matches protocol codes and busy text only', () => {
    expect(isServerBusySignal(2, null)).toBe(true); // SystemBusy
    expect(isServerBusySignal(10300, null)).toBe(true); // RateLimitExceeded
    expect(isServerBusySignal(null, 'System busy, please retry later')).toBe(true);
    expect(isServerBusySignal(null, 'Rate limit exceeded')).toBe(true);
    expect(isServerBusySignal(null, 'connection reset')).toBe(false);
    expect(isServerBusySignal(500, null)).toBe(false);
  });
});

// ---------- banner priority (locked, mirrors app RuntimeBannerPriorityTest) ----------

const conn = (over: Partial<ConnectivityRuntimeState>): ConnectivityRuntimeState => ({
  networkReachable: true,
  gatewayConnected: false,
  authenticated: false,
  reconnecting: false,
  reconnectAttempt: 0,
  serverBusy: false,
  lastConnectedAt: null,
  lastDisconnectedAt: null,
  lastError: null,
  ...over,
});
const syncState = (over: Partial<SyncRuntimeState> = {}): SyncRuntimeState => ({
  initialSyncCompleted: false,
  resumeSyncRunning: false,
  lastSyncAt: null,
  globalError: null,
  ...over,
});

describe('resolveRuntimeBanner priority', () => {
  it('auth expired beats everything', () => {
    expect(
      resolveRuntimeBanner(
        conn({ networkReachable: false, lastError: { kind: 'auth_expired' } }),
        syncState({ resumeSyncRunning: true }),
        true,
        false,
      ),
    ).toBe('auth_expired');
  });

  it('offline beats syncing and reconnecting', () => {
    expect(
      resolveRuntimeBanner(
        conn({ networkReachable: false, authenticated: true, reconnecting: true }),
        syncState({ resumeSyncRunning: true }),
        true,
        false,
      ),
    ).toBe('offline');
  });

  it('busy beats syncing when authenticated', () => {
    expect(
      resolveRuntimeBanner(
        conn({ authenticated: true, gatewayConnected: true, serverBusy: true }),
        syncState({ resumeSyncRunning: true }),
        true,
        false,
      ),
    ).toBe('server_busy');
  });

  it('syncing while authenticated; connected brief then hidden', () => {
    const c = conn({ authenticated: true, gatewayConnected: true });
    expect(resolveRuntimeBanner(c, syncState({ resumeSyncRunning: true }), true, false)).toBe(
      'syncing',
    );
    expect(resolveRuntimeBanner(c, syncState(), true, true)).toBe('connected');
    expect(resolveRuntimeBanner(c, syncState(), true, false)).toBe('hidden');
  });

  it('reconnecting beats connecting; pre-login noise suppressed; dropped shows offline', () => {
    expect(
      resolveRuntimeBanner(conn({ reconnecting: true, gatewayConnected: true }), syncState(), true, false),
    ).toBe('reconnecting');
    expect(resolveRuntimeBanner(conn({ gatewayConnected: true }), syncState(), false, false)).toBe(
      'connecting',
    );
    expect(resolveRuntimeBanner(conn({}), syncState(), false, false)).toBe('hidden');
    expect(resolveRuntimeBanner(conn({}), syncState(), true, false)).toBe('offline');
  });
});

// ---------- runtime state machine (fake client) ----------

class FakeClient implements RuntimeClientLike {
  private connCb: ((event: { state: ConnectionState }) => void) | null = null;
  private authCb: ((event: unknown) => void) | null = null;
  private outboxCb: ((entries: OutboxEntry[]) => void) | null = null;

  onConnectionStateChanged(cb: (event: { state: ConnectionState }) => void): () => void {
    this.connCb = cb;
    return () => {
      this.connCb = null;
    };
  }
  onAuthExpired(cb: (event: unknown) => void): () => void {
    this.authCb = cb;
    return () => {
      this.authCb = null;
    };
  }
  observeOutbox(cb: (entries: OutboxEntry[]) => void): () => void {
    this.outboxCb = cb;
    return () => {
      this.outboxCb = null;
    };
  }

  emitState(state: ConnectionState): void {
    this.connCb?.({ state });
  }
  emitAuthExpired(): void {
    this.authCb?.({ type: 'auth_expired' });
  }
  emitOutbox(entries: Array<Partial<OutboxEntry> & { status: OutboxEntry['status'] }>): void {
    this.outboxCb?.(entries as OutboxEntry[]);
  }
}

describe('createClientRuntime state machine', () => {
  it('first connect is not reconnecting; authenticated resets attempts and completes initial sync', () => {
    const fake = new FakeClient();
    const rt = createClientRuntime(fake);
    fake.emitState('connecting');
    expect(rt.connectivity.getState().reconnecting).toBe(false);
    fake.emitState('connected');
    fake.emitState('authenticating');
    fake.emitState('authenticated');
    const c = rt.connectivity.getState();
    expect(c.authenticated).toBe(true);
    expect(c.reconnectAttempt).toBe(0);
    expect(c.lastError).toBeNull();
    expect(rt.sync.getState().initialSyncCompleted).toBe(true);
    rt.dispose();
  });

  it('drop after session reconnects with attempt counting', () => {
    const fake = new FakeClient();
    const rt = createClientRuntime(fake);
    fake.emitState('authenticated');
    fake.emitState('disconnected');
    expect(rt.connectivity.getState().reconnecting).toBe(true);
    expect(rt.connectivity.getState().lastError?.kind).toBe('gateway_disconnected');
    fake.emitState('reconnecting');
    fake.emitState('reconnecting');
    expect(rt.connectivity.getState().reconnectAttempt).toBe(2);
    fake.emitState('authenticated');
    expect(rt.connectivity.getState().reconnecting).toBe(false);
    expect(rt.connectivity.getState().reconnectAttempt).toBe(0);
    rt.dispose();
  });

  it('auth expired is terminal (not reconnecting)', () => {
    const fake = new FakeClient();
    const rt = createClientRuntime(fake);
    fake.emitState('authenticated');
    fake.emitAuthExpired();
    const c = rt.connectivity.getState();
    expect(c.authenticated).toBe(false);
    expect(c.reconnecting).toBe(false);
    expect(c.lastError?.kind).toBe('auth_expired');
    rt.dispose();
  });

  it('outbox snapshots drive send queue summary', () => {
    const fake = new FakeClient();
    const rt = createClientRuntime(fake);
    fake.emitOutbox([{ status: 'pending' }, { status: 'sending' }, { status: 'failed' }]);
    expect(rt.send.getState().outboundQueued).toBe(2);
    expect(rt.send.getState().failedCount).toBe(1);
    expect(rt.send.getState().lastFailureAt).not.toBeNull();
    fake.emitOutbox([]);
    expect(rt.send.getState().outboundQueued).toBe(0);
    rt.dispose();
  });

  it('server busy set by sync failure signal and cleared by success signals', () => {
    const fake = new FakeClient();
    const rt = createClientRuntime(fake);
    rt.markSyncFailed('System busy, please retry later');
    expect(rt.connectivity.getState().serverBusy).toBe(true);
    expect(rt.sync.getState().globalError?.kind).toBe('sync_failed');
    rt.markSyncCompleted();
    expect(rt.connectivity.getState().serverBusy).toBe(false);

    rt.onServerBusySignal();
    fake.emitState('authenticated'); // 成功信号清 busy
    expect(rt.connectivity.getState().serverBusy).toBe(false);
    rt.dispose();
  });

  it('reset clears everything and forgets the session', () => {
    const fake = new FakeClient();
    const rt = createClientRuntime(fake);
    fake.emitState('authenticated');
    rt.markSyncStarted();
    fake.emitOutbox([{ status: 'pending' }]);
    rt.reset();
    expect(rt.connectivity.getState().authenticated).toBe(false);
    expect(rt.sync.getState().resumeSyncRunning).toBe(false);
    expect(rt.sync.getState().initialSyncCompleted).toBe(false);
    expect(rt.send.getState().outboundQueued).toBe(0);
    fake.emitState('disconnected');
    expect(rt.connectivity.getState().reconnecting).toBe(false); // hadSession 已清
    rt.dispose();
  });
});
