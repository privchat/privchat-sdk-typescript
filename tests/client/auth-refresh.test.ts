// SDK-owned auth-refresh coordinator: refresh-on-expiry + retry-once across
// the authenticate path and the auto-reconnect replay path, single-flight,
// terminal → session_expired, lastAuth update.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AuthRefreshCoordinator,
  decodeAuthorizationRequest,
  encodeAuthorizationResponse,
  PrivchatClient,
  RefreshTokenError,
} from '../../src/index.js';
import { FakeTransport } from './fake-transport.js';

const fail10002 = () =>
  encodeAuthorizationResponse({
    success: false,
    error_code: 10002,
    error_message: '[10002] Token 已过期',
  });
const ok = () => encodeAuthorizationResponse({ success: true });

const hasEvent = (client: PrivchatClient, type: string) =>
  client.recentEvents(50).some((e) => e.event.type === type);

describe('AuthRefreshCoordinator (pure single-flight)', () => {
  it('coalesces concurrent refreshes into ONE refreshAuth call', async () => {
    let calls = 0;
    let release!: (r: { accessToken: string }) => void;
    const coord = new AuthRefreshCoordinator({
      refreshAuth: () => {
        calls++;
        return new Promise((r) => {
          release = r;
        });
      },
    });
    const ctx = { reason: 'token_expired' as const, attempt: 1 };
    const p1 = coord.refresh(ctx);
    const p2 = coord.refresh(ctx);
    expect(calls).toBe(1); // single-flight
    release({ accessToken: 'NEW' });
    expect(await p1).toEqual({ accessToken: 'NEW' });
    expect(await p2).toEqual({ accessToken: 'NEW' });
    // After settle, a new refresh starts a fresh call.
    const p3 = coord.refresh(ctx);
    expect(calls).toBe(2);
    release({ accessToken: 'NEW2' });
    await p3;
  });

  it('still resolves when onTokensRefreshed throws (rule 5: warn, do not abort)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const coord = new AuthRefreshCoordinator({
      refreshAuth: async () => ({ accessToken: 'NEW' }),
      onTokensRefreshed: () => {
        throw new Error('localStorage blew up');
      },
    });
    const res = await coord.refresh({ reason: 'token_expired', attempt: 1 });
    expect(res.accessToken).toBe('NEW');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('authenticate(): refresh-on-expiry + retry once', () => {
  it('expired access token → refresh → retry authenticate → authenticated', async () => {
    const t = new FakeTransport();
    let authCalls = 0;
    t.responder = () => {
      authCalls++;
      return authCalls === 1 ? fail10002() : ok();
    };
    const client = new PrivchatClient({ transport: t });
    let refreshCalls = 0;
    client.configureAuthRefresh({
      refreshAuth: async () => {
        refreshCalls++;
        return { accessToken: 'NEW' };
      },
    });
    await client.connect();
    const resp = await client.authenticate('u', 'OLD', 'dev');
    expect(resp.success).toBe(true);
    expect(refreshCalls).toBe(1);
    expect(authCalls).toBe(2); // original + one retry
    expect(client.connectionState()).toBe('authenticated');
    expect(hasEvent(client, 'auth_refresh_succeeded')).toBe(true);
    expect(hasEvent(client, 'session_expired')).toBe(false);
  });

  it('refresh fails (10009) → session_expired fired once, state disconnected', async () => {
    const t = new FakeTransport();
    t.responder = () => fail10002();
    const client = new PrivchatClient({ transport: t });
    let onSessionExpired = 0;
    client.configureAuthRefresh({
      refreshAuth: async () => {
        throw new RefreshTokenError(10009, '[10009] refresh expired');
      },
      onSessionExpired: () => {
        onSessionExpired++;
      },
    });
    await client.connect();
    await expect(client.authenticate('u', 'OLD', 'dev')).rejects.toMatchObject({
      name: 'SessionExpiredError',
    });
    expect(onSessionExpired).toBe(1);
    expect(client.connectionState()).toBe('disconnected');
    expect(hasEvent(client, 'session_expired')).toBe(true);
    expect(hasEvent(client, 'auth_refresh_failed')).toBe(true);
  });

  it('no refresh config → legacy behavior (throws AuthorizationError, no session_expired)', async () => {
    const t = new FakeTransport();
    t.responder = () => fail10002();
    const client = new PrivchatClient({ transport: t });
    await client.connect();
    await expect(client.authenticate('u', 'OLD', 'dev')).rejects.toMatchObject({
      name: 'AuthorizationError',
      errorKind: 'recoverable',
    });
    expect(hasEvent(client, 'session_expired')).toBe(false);
    expect(hasEvent(client, 'auth_expired')).toBe(true);
  });

  it('updates lastAuth with the refreshed token (next reconnect replays NEW, no 2nd refresh)', async () => {
    vi.useFakeTimers();
    try {
      const t = new FakeTransport();
      // Server accepts ONLY the refreshed token 'NEW'; 'OLD' is expired.
      t.responder = (packet) => {
        const req = decodeAuthorizationRequest(packet.payload);
        return req.auth_token === 'NEW' ? ok() : fail10002();
      };
      const client = new PrivchatClient({
        transport: t,
        reconnect: { enabled: true, initialDelayMs: 100, maxDelayMs: 100, multiplier: 1 },
      });
      let refreshCalls = 0;
      client.configureAuthRefresh({
        refreshAuth: async () => {
          refreshCalls++;
          return { accessToken: 'NEW' };
        },
      });
      await client.connect();
      await client.authenticate('u', 'OLD', 'dev'); // OLD→refresh→NEW→authenticated
      expect(refreshCalls).toBe(1);
      expect(client.connectionState()).toBe('authenticated');

      // Unexpected close → reconnect replays lastAuth. If lastAuth holds
      // 'NEW', the replay authenticates directly with no second refresh.
      t.fireClose();
      await vi.advanceTimersByTimeAsync(150);
      await Promise.resolve();
      await Promise.resolve();
      expect(client.connectionState()).toBe('authenticated');
      expect(refreshCalls).toBe(1); // lastAuth was updated → no re-refresh
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('auto-reconnect: refresh-on-expiry during replay', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('replay hits expired token → refresh → reconnect ends authenticated', async () => {
    const t = new FakeTransport();
    let authCalls = 0;
    // 1: initial OK. 2: reconnect replay → expired. 3: post-refresh retry → OK.
    t.responder = () => {
      authCalls++;
      return authCalls === 2 ? fail10002() : ok();
    };
    const client = new PrivchatClient({
      transport: t,
      reconnect: { enabled: true, initialDelayMs: 100, maxDelayMs: 100, multiplier: 1 },
    });
    let refreshCalls = 0;
    client.configureAuthRefresh({
      refreshAuth: async () => {
        refreshCalls++;
        return { accessToken: 'NEW' };
      },
    });
    await client.connect();
    await client.authenticate('u', 'OLD', 'dev');
    expect(client.connectionState()).toBe('authenticated');

    t.fireClose();
    expect(client.connectionState()).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(150); // backoff → connect
    await Promise.resolve(); // connect resolves
    await Promise.resolve(); // replay authenticate → 10002
    await Promise.resolve(); // refresh resolves
    await Promise.resolve(); // retry authenticate → ok

    expect(refreshCalls).toBe(1);
    expect(authCalls).toBe(3);
    expect(client.connectionState()).toBe('authenticated');
  });
});
