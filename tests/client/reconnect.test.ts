// Auto-reconnect: replay last authenticate + re-subscribe channels.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  encodeAuthorizationResponse,
  encodeSubscribeResponse,
  PrivchatClient,
  SubscribeAction,
} from '../../src/index.js';
import { FakeTransport } from './fake-transport.js';

const SETTING = { need_receipt: false, signal: 0 };

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const advance = async (ms: number) => {
  await vi.advanceTimersByTimeAsync(ms);
};

describe('auto-reconnect', () => {
  it('replays last authenticate after unexpected close', async () => {
    const t = new FakeTransport();
    let authCount = 0;
    t.responder = () => {
      authCount++;
      return encodeAuthorizationResponse({ success: true });
    };

    const client = new PrivchatClient({
      transport: t,
      reconnect: { enabled: true, initialDelayMs: 100, maxDelayMs: 100, multiplier: 1 },
    });
    await client.connect();
    await client.authenticate('900710001', 'tok', 'dev-1');
    expect(authCount).toBe(1);

    // Simulate an unexpected close.
    t.fireClose();
    expect(client.connectionState()).toBe('reconnecting');

    await advance(150); // backoff fires
    await Promise.resolve(); // microtask: connect resolves
    await Promise.resolve(); // microtask: authenticate resolves

    expect(authCount).toBe(2);
    expect(client.connectionState()).toBe('authenticated');
  });

  it('does NOT reconnect when caller called disconnect()', async () => {
    const t = new FakeTransport();
    t.responder = () => encodeAuthorizationResponse({ success: true });

    const client = new PrivchatClient({
      transport: t,
      reconnect: { enabled: true, initialDelayMs: 100 },
    });
    await client.connect();
    await client.authenticate('1', 't', 'd');

    await client.disconnect();
    expect(client.connectionState()).toBe('disconnected');

    // Even if the transport later "fires close" again, no reconnect schedules.
    t.fireClose();
    await advance(1000);
    // Transport.connect was called twice in normal flow (initial + reconnect avoided).
    // We assert state stays disconnected.
    expect(client.connectionState()).toBe('disconnected');
  });

  it('respects reconnect.enabled = false', async () => {
    const t = new FakeTransport();
    t.responder = () => encodeAuthorizationResponse({ success: true });

    const client = new PrivchatClient({
      transport: t,
      reconnect: { enabled: false },
    });
    await client.connect();
    await client.authenticate('1', 't', 'd');
    t.fireClose();
    await advance(2000);
    expect(client.connectionState()).toBe('disconnected');
  });

  it('emits auth_expired and stops reconnecting when authenticate returns terminal', async () => {
    const t = new FakeTransport();
    let authCount = 0;
    t.responder = () => {
      authCount++;
      return encodeAuthorizationResponse({
        success: authCount === 1, // first OK, second terminal
        error_code: authCount === 2 ? 10009 : 0,
        error_message: authCount === 2 ? 'refresh expired' : undefined,
      });
    };

    const client = new PrivchatClient({
      transport: t,
      reconnect: { enabled: true, initialDelayMs: 50, maxDelayMs: 50, multiplier: 1 },
    });
    await client.connect();
    await client.authenticate('1', 't', 'd');

    const seen: Array<{ reason: string; code: number }> = [];
    client.onAuthExpired((e) => seen.push({ reason: e.reason, code: e.error_code }));

    t.fireClose();
    await advance(100);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(seen).toEqual([{ reason: 'terminal', code: 10009 }]);
    expect(client.connectionState()).toBe('disconnected');
  });

  it('replays active subscriptions after reconnect', async () => {
    const t = new FakeTransport();
    const subscribeCalls: number[] = [];
    let authBizCount = 0;
    t.responder = (pkt) => {
      // Distinguish auth vs subscribe by bizType.
      if (pkt.bizType === 1 /* AuthorizationRequest */) {
        authBizCount++;
        return encodeAuthorizationResponse({ success: true });
      }
      // SubscribeRequest = 13
      subscribeCalls.push(pkt.bizType);
      return encodeSubscribeResponse({
        local_message_id: '0',
        channel_id: '12345',
        channel_type: 1,
        action: SubscribeAction.Subscribe,
        reason_code: 0,
      });
    };

    const client = new PrivchatClient({
      transport: t,
      reconnect: { enabled: true, initialDelayMs: 50, maxDelayMs: 50, multiplier: 1 },
    });
    await client.connect();
    await client.authenticate('1', 't', 'd');
    await client.subscribeChannel('12345', 1);
    expect(subscribeCalls).toHaveLength(1);

    // Drop and reconnect.
    t.fireClose();
    await advance(80);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(authBizCount).toBe(2);
    // The first sub call is the original; second comes from replay.
    expect(subscribeCalls.length).toBeGreaterThanOrEqual(2);
  });
});

// ----- Phase 5B-1d: post-reconnect sync wiring -----

describe('reconnect → syncOnReconnect', () => {
  let dbCounter = 0;
  let warnSpy: { mockRestore: () => void } | null = null;

  beforeEach(() => {
    // Silence the per-channel warning so the rejection-path test doesn't
    // pollute test output. We assert on syncChannel call shape, not on log.
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy?.mockRestore();
    warnSpy = null;
  });

  /** Build a cache-enabled client whose transport handles auth + subscribe.
   *  syncChannel is spied on (real engine never runs); tests assert on the
   *  spy to verify the wiring. */
  const buildClient = () => {
    const t = new FakeTransport();
    t.responder = (pkt) => {
      if (pkt.bizType === 1 /* AuthorizationRequest */) {
        return encodeAuthorizationResponse({ success: true });
      }
      // SubscribeRequest
      return encodeSubscribeResponse({
        local_message_id: '0',
        channel_id: '0',
        channel_type: 0,
        action: SubscribeAction.Subscribe,
        reason_code: 0,
      });
    };
    const client = new PrivchatClient({
      transport: t,
      cache: { enabled: true, dbName: `reconnect-sync-${++dbCounter}` },
      reconnect: { enabled: true, initialDelayMs: 50, maxDelayMs: 50, multiplier: 1 },
    });
    return { t, client };
  };

  /** Drain the microtask queue enough times to let
   *  reconnect → auth → replay-subs → syncOnReconnect → allSettled all
   *  settle. The numbers were tuned empirically against the existing
   *  reconnect tests' pattern. */
  const drainReconnect = async () => {
    await advance(80); // backoff fires
    for (let i = 0; i < 8; i++) await Promise.resolve();
  };

  it('calls syncChannel for the active subscription after reconnect', async () => {
    const { t, client } = buildClient();
    await client.connect();
    await client.authenticate('1', 't', 'd');
    await client.subscribeChannel('100', 1);

    const sync = vi
      .spyOn(client, 'syncChannel')
      .mockResolvedValue({
        channel_id: '100',
        channel_type: 1,
        status: 'current',
        commits_applied: 0,
        pages_fetched: 1,
        latest_pts_before: '0',
        latest_pts_after: '0',
      });

    t.fireClose();
    await drainReconnect();

    expect(sync).toHaveBeenCalledTimes(1);
    expect(sync).toHaveBeenCalledWith('100', 1);
    expect(client.connectionState()).toBe('authenticated');
  });

  it('syncs every active subscription after reconnect (parallel)', async () => {
    const { t, client } = buildClient();
    await client.connect();
    await client.authenticate('1', 't', 'd');
    await client.subscribeChannel('100', 1);
    await client.subscribeChannel('200', 1);
    await client.subscribeChannel('300', 2);

    const sync = vi
      .spyOn(client, 'syncChannel')
      .mockImplementation(async (cid, ct) => ({
        channel_id: cid,
        channel_type: ct,
        status: 'current',
        commits_applied: 0,
        pages_fetched: 1,
        latest_pts_before: '0',
        latest_pts_after: '0',
      }));

    t.fireClose();
    await drainReconnect();

    expect(sync).toHaveBeenCalledTimes(3);
    const callPairs = sync.mock.calls.map(([cid, ct]) => `${cid}::${ct}`).sort();
    expect(callPairs).toEqual(['100::1', '200::1', '300::2']);
  });

  it('one channel sync failure does NOT regress reconnect state', async () => {
    const { t, client } = buildClient();
    await client.connect();
    await client.authenticate('1', 't', 'd');
    await client.subscribeChannel('100', 1);
    await client.subscribeChannel('200', 1);

    const sync = vi
      .spyOn(client, 'syncChannel')
      .mockImplementation(async (cid, ct) => {
        if (cid === '100') throw new Error('boom: channel 100 sync failed');
        return {
          channel_id: cid,
          channel_type: ct,
          status: 'current',
          commits_applied: 0,
          pages_fetched: 1,
          latest_pts_before: '0',
          latest_pts_after: '0',
        };
      });

    t.fireClose();
    await drainReconnect();

    // Both channels were tried (the failing one didn't short-circuit the other).
    expect(sync).toHaveBeenCalledTimes(2);
    // Reconnect succeeded despite the failure.
    expect(client.connectionState()).toBe('authenticated');
  });

  it('no active subscriptions → no syncChannel calls', async () => {
    const { t, client } = buildClient();
    await client.connect();
    await client.authenticate('1', 't', 'd');

    const sync = vi.spyOn(client, 'syncChannel');

    t.fireClose();
    await drainReconnect();

    expect(sync).not.toHaveBeenCalled();
    expect(client.connectionState()).toBe('authenticated');
  });

  it('cache disabled → reconnect still completes; no syncChannel attempts', async () => {
    const t = new FakeTransport();
    t.responder = (pkt) => {
      if (pkt.bizType === 1) return encodeAuthorizationResponse({ success: true });
      return encodeSubscribeResponse({
        local_message_id: '0',
        channel_id: '0',
        channel_type: 0,
        action: SubscribeAction.Subscribe,
        reason_code: 0,
      });
    };
    const client = new PrivchatClient({
      transport: t,
      // cache NOT enabled
      reconnect: { enabled: true, initialDelayMs: 50, maxDelayMs: 50, multiplier: 1 },
    });
    await client.connect();
    await client.authenticate('1', 't', 'd');
    await client.subscribeChannel('100', 1);

    // syncChannel would throw CacheDisabledError if invoked. The wiring
    // must short-circuit before reaching it (engine === null branch).
    const sync = vi.spyOn(client, 'syncChannel');

    t.fireClose();
    await drainReconnect();

    expect(sync).not.toHaveBeenCalled();
    expect(client.connectionState()).toBe('authenticated');
  });
});

// ----- Phase 5C-1d: post-reconnect outbox flush wiring -----

describe('reconnect → flushOutboxOnReconnect', () => {
  let dbCounter = 0;
  let warnSpy: { mockRestore: () => void } | null = null;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy?.mockRestore();
    warnSpy = null;
  });

  const buildCacheClient = () => {
    const t = new FakeTransport();
    t.responder = (pkt) => {
      if (pkt.bizType === 1) return encodeAuthorizationResponse({ success: true });
      return encodeSubscribeResponse({
        local_message_id: '0',
        channel_id: '0',
        channel_type: 0,
        action: SubscribeAction.Subscribe,
        reason_code: 0,
      });
    };
    const c = new PrivchatClient({
      transport: t,
      cache: { enabled: true, dbName: `reconnect-flush-${++dbCounter}` },
      reconnect: { enabled: true, initialDelayMs: 50, maxDelayMs: 50, multiplier: 1 },
    });
    return { t, client: c };
  };

  const drainReconnect = async () => {
    await advance(80);
    for (let i = 0; i < 8; i++) await Promise.resolve();
  };

  it('calls flushOutbox after reconnect lands', async () => {
    const { t, client } = buildCacheClient();
    await client.connect();
    await client.authenticate('1', 't', 'd');

    const flush = vi
      .spyOn(client, 'flushOutbox')
      .mockResolvedValue({ attempted: 0, sent: 0, failed: 0, skipped: 0, remaining: 0 });
    // syncChannel needs a no-op spy too; without it the real engine
    // would try to call sync/get_difference and the FakeTransport
    // doesn't have a route handler.
    vi.spyOn(client, 'syncChannel').mockResolvedValue({
      channel_id: '_',
      channel_type: 0,
      status: 'current',
      commits_applied: 0,
      pages_fetched: 1,
      latest_pts_before: '0',
      latest_pts_after: '0',
    });

    t.fireClose();
    await drainReconnect();

    expect(flush).toHaveBeenCalledTimes(1);
    expect(client.connectionState()).toBe('authenticated');
  });

  it('flushOutbox runs AFTER syncOnReconnect', async () => {
    const { t, client } = buildCacheClient();
    await client.connect();
    await client.authenticate('1', 't', 'd');
    await client.subscribeChannel('100', 1);

    // Capture the call order. syncChannel is per-channel; flushOutbox
    // is top-level. Both must complete during reconnect.
    const order: string[] = [];
    vi.spyOn(client, 'syncChannel').mockImplementation(async (cid, ct) => {
      order.push('sync');
      return {
        channel_id: cid,
        channel_type: ct,
        status: 'current',
        commits_applied: 0,
        pages_fetched: 1,
        latest_pts_before: '0',
        latest_pts_after: '0',
      };
    });
    vi.spyOn(client, 'flushOutbox').mockImplementation(async () => {
      order.push('flush');
      return { attempted: 0, sent: 0, failed: 0, skipped: 0, remaining: 0 };
    });

    t.fireClose();
    await drainReconnect();

    // sync (called per-channel) must precede flush.
    const lastSyncIdx = order.lastIndexOf('sync');
    const flushIdx = order.indexOf('flush');
    expect(lastSyncIdx).toBeGreaterThanOrEqual(0);
    expect(flushIdx).toBeGreaterThanOrEqual(0);
    expect(flushIdx).toBeGreaterThan(lastSyncIdx);
  });

  it('flushOutbox rejection does NOT regress reconnect state', async () => {
    const { t, client } = buildCacheClient();
    await client.connect();
    await client.authenticate('1', 't', 'd');

    vi.spyOn(client, 'syncChannel').mockResolvedValue({
      channel_id: '_',
      channel_type: 0,
      status: 'current',
      commits_applied: 0,
      pages_fetched: 1,
      latest_pts_before: '0',
      latest_pts_after: '0',
    });
    vi.spyOn(client, 'flushOutbox').mockRejectedValue(new Error('boom: outbox flush'));

    t.fireClose();
    await drainReconnect();

    // Reconnect still settles authenticated; the flush failure was
    // swallowed by `flushOutboxOnReconnect`.
    expect(client.connectionState()).toBe('authenticated');
  });

  it('cache disabled → reconnect still completes; no flushOutbox attempts', async () => {
    const t = new FakeTransport();
    t.responder = (pkt) => {
      if (pkt.bizType === 1) return encodeAuthorizationResponse({ success: true });
      return encodeSubscribeResponse({
        local_message_id: '0',
        channel_id: '0',
        channel_type: 0,
        action: SubscribeAction.Subscribe,
        reason_code: 0,
      });
    };
    const client = new PrivchatClient({
      transport: t,
      // cache NOT enabled → outbox engine is null
      reconnect: { enabled: true, initialDelayMs: 50, maxDelayMs: 50, multiplier: 1 },
    });
    await client.connect();
    await client.authenticate('1', 't', 'd');

    // flushOutbox would throw CacheDisabledError if invoked. The wiring
    // must short-circuit before reaching it (engine === null branch).
    const flush = vi.spyOn(client, 'flushOutbox');

    t.fireClose();
    await drainReconnect();

    expect(flush).not.toHaveBeenCalled();
    expect(client.connectionState()).toBe('authenticated');
  });
});

describe('reconnect storm control (P0-12 parity with the Rust SDK)', () => {
  it('applies ±30% jitter to the backoff delay', async () => {
    const t = new FakeTransport();
    let authCount = 0;
    t.responder = () => {
      authCount++;
      return encodeAuthorizationResponse({ success: true });
    };
    const client = new PrivchatClient({
      transport: t,
      reconnect: { enabled: true, initialDelayMs: 100, maxDelayMs: 100, multiplier: 1 },
    });
    await client.connect();
    await client.authenticate('1', 't', 'd');

    // random=0 → factor 0.7 → 70ms delay.
    const rand = vi.spyOn(Math, 'random').mockReturnValue(0);
    t.fireClose();
    await advance(69);
    expect(authCount).toBe(1); // not fired yet
    await advance(2);
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(authCount).toBe(2);
    expect(client.connectionState()).toBe('authenticated');

    // random≈1 → factor ~1.3 → ~130ms delay: 100ms (the old fixed value)
    // must NOT be enough.
    rand.mockReturnValue(0.9999);
    t.fireClose();
    await advance(110);
    expect(authCount).toBe(2); // still waiting
    await advance(25);
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(authCount).toBe(3);
    rand.mockRestore();
  });

  it('keeps the backoff cycle alive after a transient authenticate failure', async () => {
    const t = new FakeTransport();
    let authCount = 0;
    t.responder = () => {
      authCount++;
      // 2nd auth (first reconnect attempt) fails transiently; 3rd succeeds.
      return encodeAuthorizationResponse({
        success: authCount !== 2,
        error_code: authCount === 2 ? 50000 : 0,
        error_message: authCount === 2 ? 'server busy' : undefined,
      });
    };
    const client = new PrivchatClient({
      transport: t,
      reconnect: { enabled: true, initialDelayMs: 50, maxDelayMs: 50, multiplier: 1 },
    });
    await client.connect();
    await client.authenticate('1', 't', 'd');

    t.fireClose();
    await advance(80);
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(authCount).toBe(2);
    // Old behaviour: cancelReconnect() → stuck. New behaviour: still cycling.
    expect(client.connectionState()).toBe('reconnecting');

    await advance(120);
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(authCount).toBe(3);
    expect(client.connectionState()).toBe('authenticated');
  });
});
