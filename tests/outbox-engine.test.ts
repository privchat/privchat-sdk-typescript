// Phase 5C-1c unit tests for OutboxEngine. Direct construction with
// mocked deps — same pattern as `sync-engine.test.ts`. Tests cover the
// 11 cases listed in the user-approved scope plus a few extras around
// state-skipping and FIFO ordering.

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CacheDB,
  MessageStore,
  getOutboxEntry,
  listOutboxEntries,
  putOutboxEntry,
  type OutboxEntry,
} from '../src/cache/index.js';
import {
  FROZEN_NEXT_ATTEMPT_AT,
  OutboxEngine,
  type OutboxEngineDeps,
} from '../src/outbox-engine.js';
import type {
  SendMessageRequest,
  SendMessageResponse,
} from '../src/index.js';

// ----- Setup -----

let dbCounter = 0;
const dbs: CacheDB[] = [];
afterEach(async () => {
  while (dbs.length > 0) {
    const db = dbs.pop()!;
    try {
      await db.close();
    } catch {
      /* ignore */
    }
  }
});

function newDb(): CacheDB {
  const db = new CacheDB(`outbox-engine-${++dbCounter}-${Math.random().toString(36).slice(2, 8)}`);
  dbs.push(db);
  return db;
}

const NOW = 1_700_000_000_000;

function row(
  outbox_id: string,
  overrides: Partial<OutboxEntry> = {},
): OutboxEntry {
  return {
    outbox_id,
    record_key: `l:${outbox_id}`,
    channel_id: '100',
    channel_type: 1,
    local_message_id: outbox_id,
    from_uid: '999',
    content_type: 'text',
    payload: new TextEncoder().encode(`body-${outbox_id}`),
    created_at: NOW,
    updated_at: NOW,
    attempt_count: 0,
    next_attempt_at: 0,
    status: 'pending',
    ...overrides,
  };
}

interface Harness {
  engine: OutboxEngine;
  store: MessageStore;
  db: CacheDB;
  sendCalls: SendMessageRequest[];
  setSendImpl: (impl: (req: SendMessageRequest) => Promise<SendMessageResponse>) => void;
  setState: (s: 'authenticated' | 'disconnected' | 'reconnecting') => void;
  setNow: (n: number) => void;
}

interface HarnessOpts {
  state?: 'authenticated' | 'disconnected' | 'reconnecting';
  initialDelayMs?: number;
  maxDelayMs?: number;
  maxAttempts?: number;
  now?: number;
}

function newHarness(opts: HarnessOpts = {}): Harness {
  const db = newDb();
  const store = new MessageStore();
  const sendCalls: SendMessageRequest[] = [];
  let sendImpl: (req: SendMessageRequest) => Promise<SendMessageResponse> = async () => {
    throw new Error('sendImpl not configured');
  };
  let state: 'authenticated' | 'disconnected' | 'reconnecting' = opts.state ?? 'authenticated';
  let nowValue = opts.now ?? NOW;

  const deps: OutboxEngineDeps = {
    db,
    store,
    sendMessage: (req) => {
      sendCalls.push(req);
      return sendImpl(req);
    },
    getConnectionState: () => state,
    now: () => nowValue,
    config: {
      initialDelayMs: opts.initialDelayMs,
      maxDelayMs: opts.maxDelayMs,
      maxAttempts: opts.maxAttempts,
    },
    warn: () => {
      /* swallow noise */
    },
  };
  const engine = new OutboxEngine(deps);

  return {
    engine,
    store,
    db,
    sendCalls,
    setSendImpl: (impl) => {
      sendImpl = impl;
    },
    setState: (s) => {
      state = s;
    },
    setNow: (n) => {
      nowValue = n;
    },
  };
}

const okResp = (
  server_message_id: string,
  message_seq = 0,
  client_seq = 0,
): SendMessageResponse => ({
  client_seq,
  server_message_id,
  message_seq,
  reason_code: 0,
});

const rejectedResp = (
  reason_code: number,
  client_seq = 0,
): SendMessageResponse => ({
  client_seq,
  server_message_id: '0',
  message_seq: 0,
  reason_code,
});

/** Poll until `pred` returns true or `deadlineMs` elapses. Yields via
 *  `setTimeout(0)` so real IndexedDB macrotasks settle between checks. */
async function waitFor(
  pred: () => Promise<boolean>,
  deadlineMs: number,
): Promise<boolean> {
  const stop = Date.now() + deadlineMs;
  while (Date.now() < stop) {
    if (await pred()) return true;
    await new Promise((r) => setTimeout(r, 5));
  }
  return false;
}

// ----- Tests -----

describe('OutboxEngine — happy path', () => {
  it('Case 1: due pending entry → ACK → outbox row deleted', async () => {
    const h = newHarness();
    h.setSendImpl(async () => okResp('s-1', 100));
    await putOutboxEntry(h.db, row('A'));

    const result = await h.engine.flushOutbox();
    expect(result.attempted).toBe(1);
    expect(result.sent).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.remaining).toBe(0);
    expect(await getOutboxEntry(h.db, 'A')).toBeUndefined();
  });

  it('Case 2: ACK swaps the in-memory pending record to sent', async () => {
    const h = newHarness();
    // Pre-seed the cache with the matching pending MessageRecord (as
    // sendTextMessage would have done).
    h.store.upsertMessage(
      {
        channel_id: '100',
        channel_type: 1,
        local_message_id: 'A',
        from_uid: '999',
        message_type: '0',
        content: 'body-A',
        payload: new Uint8Array(),
        timestamp: NOW,
        status: 'pending',
      },
      false,
    );
    h.setSendImpl(async () => okResp('s-A', 42));
    await putOutboxEntry(h.db, row('A'));

    const result = await h.engine.flushOutbox();
    expect(result.sent).toBe(1);

    const cached = h.store.getMessages('100', 1);
    expect(cached).toHaveLength(1);
    expect(cached[0]!.status).toBe('sent');
    expect(cached[0]!.server_message_id).toBe('s-A');
    expect(cached[0]!.local_message_id).toBe('A');
    expect(cached[0]!.pts).toBe('42');
  });

  it('Case 3: due failed entry is retried (treated like pending)', async () => {
    const h = newHarness();
    h.setSendImpl(async () => okResp('s-1'));
    await putOutboxEntry(
      h.db,
      row('R', { status: 'failed', attempt_count: 2, last_error: 'transient: prev' }),
    );

    const result = await h.engine.flushOutbox();
    expect(result.attempted).toBe(1);
    expect(result.sent).toBe(1);
    expect(await getOutboxEntry(h.db, 'R')).toBeUndefined();
  });

  it('Case 11: empty outbox returns attempted=0', async () => {
    const h = newHarness();
    const result = await h.engine.flushOutbox();
    expect(result).toEqual({
      attempted: 0,
      sent: 0,
      failed: 0,
      skipped: 0,
      remaining: 0,
    });
    expect(h.sendCalls).toHaveLength(0);
  });
});

describe('OutboxEngine — gating', () => {
  it('Case 4: not-due entry (next_attempt_at > now) is excluded', async () => {
    const h = newHarness({ now: NOW });
    h.setSendImpl(async () => okResp('s'));
    await putOutboxEntry(
      h.db,
      row('FUTURE', { next_attempt_at: NOW + 5_000 }),
    );

    const result = await h.engine.flushOutbox();
    expect(result.attempted).toBe(0);
    expect(result.remaining).toBe(1);
    expect(h.sendCalls).toHaveLength(0);
  });

  it('Case 5: sending entry is excluded (caller already in-flight)', async () => {
    const h = newHarness();
    h.setSendImpl(async () => okResp('s'));
    await putOutboxEntry(h.db, row('IN-FLIGHT', { status: 'sending' }));

    const result = await h.engine.flushOutbox();
    expect(result.attempted).toBe(0);
    // Row stays sending; nothing changed.
    const after = await getOutboxEntry(h.db, 'IN-FLIGHT');
    expect(after?.status).toBe('sending');
  });

  it('frozen entry (next_attempt_at = MAX_SAFE_INTEGER) is excluded', async () => {
    const h = newHarness();
    h.setSendImpl(async () => okResp('s'));
    await putOutboxEntry(
      h.db,
      row('FROZEN', {
        status: 'failed',
        attempt_count: 5,
        next_attempt_at: FROZEN_NEXT_ATTEMPT_AT,
        last_error: 'rejected: code=403',
      }),
    );

    const result = await h.engine.flushOutbox();
    expect(result.attempted).toBe(0);
    expect(result.remaining).toBe(1);
  });

  it('skips rows when state !== authenticated', async () => {
    const h = newHarness({ state: 'reconnecting' });
    h.setSendImpl(async () => okResp('s'));
    await putOutboxEntry(h.db, row('OFF'));

    const result = await h.engine.flushOutbox();
    expect(result.attempted).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.sent).toBe(0);
    expect(h.sendCalls).toHaveLength(0);
    // Row stays pending, unchanged.
    const after = await getOutboxEntry(h.db, 'OFF');
    expect(after?.status).toBe('pending');
    expect(after?.attempt_count).toBe(0);
  });
});

describe('OutboxEngine — failure paths', () => {
  it('Case 6: transport throw → status=failed, attempt_count++, backoff scheduled', async () => {
    const h = newHarness({
      now: NOW,
      initialDelayMs: 1_000,
      maxDelayMs: 30_000,
      maxAttempts: 8,
    });
    h.setSendImpl(async () => {
      throw new Error('boom: socket closed');
    });
    await putOutboxEntry(h.db, row('T1', { attempt_count: 0 }));

    const result = await h.engine.flushOutbox();
    expect(result.attempted).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.sent).toBe(0);

    const after = await getOutboxEntry(h.db, 'T1');
    expect(after?.status).toBe('failed');
    expect(after?.attempt_count).toBe(1);
    // Delay = min(1000 * 2^0, 30000) = 1000.
    expect(after?.next_attempt_at).toBe(NOW + 1_000);
    expect(after?.last_error).toMatch(/^transient: /);
    expect(after?.last_error).toContain('boom: socket closed');
  });

  it('Case 7: reason_code !== 0 → status=failed, frozen (no auto-retry)', async () => {
    const h = newHarness({ now: NOW });
    h.setSendImpl(async () => rejectedResp(503));
    await putOutboxEntry(h.db, row('REJ', { attempt_count: 0 }));

    await h.engine.flushOutbox();
    const after = await getOutboxEntry(h.db, 'REJ');
    expect(after?.status).toBe('failed');
    expect(after?.attempt_count).toBe(1);
    expect(after?.next_attempt_at).toBe(FROZEN_NEXT_ATTEMPT_AT);
    expect(after?.last_error).toBe('rejected: code=503');

    // Subsequent flush picks NOTHING up — frozen row excluded.
    const second = await h.engine.flushOutbox();
    expect(second.attempted).toBe(0);
  });

  it('Case 8: maxAttempts reached → frozen with descriptive last_error', async () => {
    const h = newHarness({
      now: NOW,
      initialDelayMs: 100,
      maxDelayMs: 1_000,
      maxAttempts: 2,
    });
    h.setSendImpl(async () => {
      throw new Error('still failing');
    });
    await putOutboxEntry(h.db, row('MAX', { attempt_count: 1 })); // one prior failure

    await h.engine.flushOutbox();
    const after = await getOutboxEntry(h.db, 'MAX');
    expect(after?.status).toBe('failed');
    expect(after?.attempt_count).toBe(2);
    expect(after?.next_attempt_at).toBe(FROZEN_NEXT_ATTEMPT_AT);
    expect(after?.last_error).toMatch(/^transient: max attempts \(2\) exceeded:/);

    // Confirm: stays excluded from subsequent flushes.
    const second = await h.engine.flushOutbox();
    expect(second.attempted).toBe(0);
  });

  it('exponential backoff caps at maxDelayMs', async () => {
    const h = newHarness({
      now: NOW,
      initialDelayMs: 1_000,
      maxDelayMs: 5_000,
      maxAttempts: 100, // don't trip max in this test
    });
    h.setSendImpl(async () => {
      throw new Error('transient');
    });
    // Start with attempt_count=4 → next delay = min(1000 * 2^4, 5000) = min(16000, 5000) = 5000.
    await putOutboxEntry(h.db, row('CAP', { attempt_count: 4 }));

    await h.engine.flushOutbox();
    const after = await getOutboxEntry(h.db, 'CAP');
    expect(after?.next_attempt_at).toBe(NOW + 5_000);
  });
});

describe('OutboxEngine — ordering', () => {
  it('Case 9: same-channel rows ship in created_at FIFO order', async () => {
    const h = newHarness();
    let sendOrder: string[] = [];
    h.setSendImpl(async (req) => {
      sendOrder.push(req.local_message_id);
      return okResp(`s-${req.local_message_id}`);
    });
    // Insert out of natural order to ensure the engine sorts by created_at.
    await putOutboxEntry(h.db, row('B', { created_at: NOW + 200 }));
    await putOutboxEntry(h.db, row('A', { created_at: NOW + 100 }));
    await putOutboxEntry(h.db, row('C', { created_at: NOW + 300 }));

    const result = await h.engine.flushOutbox();
    expect(result.sent).toBe(3);
    expect(sendOrder).toEqual(['A', 'B', 'C']);
  });

  it('Case 10: cross-channel rows fan out (per-channel mutex independence)', async () => {
    const h = newHarness();
    // Channel-1's first send blocks until we explicitly release it;
    // channel-2's send resolves freely. The mutex is per-channel, so
    // channel-2 must complete while channel-1 is still pending.
    let firstSendRelease!: () => void;
    const firstSendBlocked = new Promise<void>((resolve) => {
      firstSendRelease = resolve;
    });

    h.setSendImpl(async (req) => {
      if (req.channel_id === '100' && req.local_message_id === 'C1-1') {
        await firstSendBlocked;
      }
      return okResp(`s-${req.local_message_id}`);
    });

    await putOutboxEntry(h.db, row('C1-1', { channel_id: '100', created_at: NOW + 100 }));
    await putOutboxEntry(h.db, row('C1-2', { channel_id: '100', created_at: NOW + 200 }));
    await putOutboxEntry(
      h.db,
      row('C2-1', {
        outbox_id: 'C2-1',
        local_message_id: 'C2-1',
        record_key: 'l:C2-1',
        channel_id: '200',
        created_at: NOW + 100,
      }),
    );

    const flushPromise = h.engine.flushOutbox();
    // Wait for channel-2 to drain. Polling on the outbox so we settle
    // through real IndexedDB macrotasks, not just microtasks.
    const c2Drained = await waitFor(
      async () => (await getOutboxEntry(h.db, 'C2-1')) === undefined,
      500,
    );
    expect(c2Drained).toBe(true);
    // Channel-1's second row must NOT have shipped yet (FIFO blocked
    // by C1-1 still in-flight).
    expect(await getOutboxEntry(h.db, 'C1-2')).toBeDefined();

    // Release C1-1 → both channel-1 rows should drain.
    firstSendRelease();
    const result = await flushPromise;
    expect(result.sent).toBe(3);
    expect(await listOutboxEntries(h.db)).toEqual([]);
  });
});

describe('OutboxEngine — options', () => {
  it('limit caps the number of rows attempted', async () => {
    const h = newHarness();
    h.setSendImpl(async (req) => okResp(`s-${req.local_message_id}`));
    await putOutboxEntry(h.db, row('A', { created_at: NOW + 100 }));
    await putOutboxEntry(h.db, row('B', { created_at: NOW + 200 }));
    await putOutboxEntry(h.db, row('C', { created_at: NOW + 300 }));

    const result = await h.engine.flushOutbox({ limit: 2 });
    expect(result.attempted).toBe(2);
    expect(result.sent).toBe(2);
    expect(result.remaining).toBe(1);
  });

  it('channel_id filter restricts the flush to one channel', async () => {
    const h = newHarness();
    h.setSendImpl(async (req) => okResp(`s-${req.local_message_id}`));
    await putOutboxEntry(h.db, row('A', { channel_id: '100' }));
    await putOutboxEntry(
      h.db,
      row('B', {
        channel_id: '200',
        local_message_id: 'B',
        record_key: 'l:B',
      }),
    );

    const result = await h.engine.flushOutbox({ channel_id: '100', channel_type: 1 });
    expect(result.attempted).toBe(1);
    expect(h.sendCalls.map((c) => c.local_message_id)).toEqual(['A']);
    expect(await getOutboxEntry(h.db, 'B')).toBeDefined(); // untouched
  });
});

describe('OutboxEngine — sendMessage request shape', () => {
  it('reconstructs SendMessageRequest from the persisted outbox row', async () => {
    const h = newHarness();
    h.setSendImpl(async () => okResp('s-1'));
    await putOutboxEntry(
      h.db,
      row('REQ', {
        channel_id: '12345',
        channel_type: 2,
        from_uid: '777',
        local_message_id: 'REQ',
        payload: new TextEncoder().encode('hello world'),
      }),
    );

    await h.engine.flushOutbox();
    expect(h.sendCalls).toHaveLength(1);
    const req = h.sendCalls[0]!;
    expect(req.channel_id).toBe('12345');
    expect(req.from_uid).toBe('777');
    expect(req.local_message_id).toBe('REQ');
    expect(req.message_type).toBe(0); // text
    expect(new TextDecoder().decode(req.payload)).toBe('hello world');
  });
});
