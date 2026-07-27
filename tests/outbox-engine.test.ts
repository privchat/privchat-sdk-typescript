// Phase 5C-1c unit tests for OutboxEngine. Direct construction with
// mocked deps — same pattern as `sync-engine.test.ts`. Tests cover the
// 11 cases listed in the user-approved scope plus a few extras around
// state-skipping and FIFO ordering.

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CacheDB,
  MessageStore,
  getMessageWindow,
  getOutboxEntry,
  listOutboxEntries,
  putOutboxEntry,
  upsertMessage,
  type OutboxEntry,
} from '../src/cache/index.js';
import {
  FROZEN_NEXT_ATTEMPT_AT,
  OutboxEngine,
  type OutboxEngineDeps,
} from '../src/outbox-engine.js';
import { claimOutboxEntry, updateOutboxStatus } from '../src/cache/index.js';
import { encodeMessagePayloadEnvelope } from '../src/codec/payload.js';
import type { OutboxStateChangedEvent } from '../src/events.js';
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

describe('OutboxEngine — message link is the stable id', () => {
  // record_key is derived from local_message_id before the ACK and from
  // server_message_id after, so a command that outlives its own ACK finds the
  // key it stored pointing at nothing. message_id is MessageRecord.id and
  // never moves (SDK_ENTITY_MODEL_SPEC §2.6.1) — that is the link the engine
  // must use.
  it('resolves the pending record after record_key has already moved on', async () => {
    const h = newHarness();
    // The row as it looks *after* an ack rekeyed it: same stable id, but the
    // key the outbox row was written with no longer matches.
    h.store.upsertMessage(
      {
        id: 'stable-1',
        channel_id: '100',
        channel_type: 1,
        local_message_id: 'A',
        server_message_id: 's-earlier',
        from_uid: '999',
        message_type: '0',
        content: 'body-A',
        payload: new Uint8Array(),
        timestamp: NOW,
        status: 'sent',
      },
      false,
    );
    h.setSendImpl(async () => okResp('s-A', 42));
    await putOutboxEntry(h.db, row('A', { message_id: 'stable-1' }));

    const result = await h.engine.flushOutbox();
    expect(result.sent).toBe(1);

    // Found and updated in place — not resurrected as a second row under a
    // freshly minted identity, which is what a record_key-only join does when
    // the key has moved.
    const rows = h.store.getMessages('100', 1);
    expect(rows.filter((m) => m.local_message_id === 'A')).toHaveLength(1);
    expect(rows.find((m) => m.local_message_id === 'A')?.id).toBe('stable-1');
  });

  it('refuses to claim an inbound message that was never a local send', async () => {
    const h = newHarness();
    // The reachable corruption. An ordinary inbound message has no
    // local_message_id at all, so a rule that waves those through lets a
    // damaged link claim it. Nothing collides -- there is only one row -- so
    // the unique id index cannot see this, and the ACK rewrites someone
    // else's received message into our sent one, content and all.
    await h.db.messages.put({
      id: 'foreign',
      record_key: 's:inbound-1',
      channel_id: '100',
      channel_type: 1,
      server_message_id: 'inbound-1',
      from_uid: '555',
      message_type: '0',
      content: 'a message somebody else sent us',
      payload: new Uint8Array(),
      timestamp: NOW,
      status: 'received',
    });
    h.setSendImpl(async () => okResp('s-A', 42));
    await putOutboxEntry(h.db, row('A', { message_id: 'foreign' }));

    await h.engine.flushOutbox();

    // The inbound row is untouched either way — applyAckRekey refuses to
    // overwrite a row held under another key. What the strict rule changes is
    // the cost of the damaged link: claiming the inbound row sends the
    // command into integrity_error, so the user's message is quarantined and
    // never sent. Refusing to claim it lets the send complete normally.
    const foreign = await h.db.messages.where('id').equals('foreign').first();
    expect(foreign?.content).toBe('a message somebody else sent us');
    expect(foreign?.from_uid).toBe('555');
    expect(foreign?.status).toBe('received');
    expect(foreign?.local_message_id).toBeUndefined();
    expect(foreign?.server_message_id).toBe('inbound-1');

    // The send went through: outbox drained, not quarantined.
    expect(await getOutboxEntry(h.db, 'A')).toBeUndefined();
    const mine = (await h.db.messages.toArray()).find(
      (m) => m.local_message_id === 'A',
    );
    expect(mine?.server_message_id).toBe('s-A');
    expect(mine?.id).not.toBe('foreign');
  });

  it('rebuilds a lost reply/mention text row from its envelope, not as raw bytes', async () => {
    const h = newHarness();
    h.setSendImpl(async () => okResp('s-RPL', 44));
    // Text carrying a reply or a mention is NOT raw UTF-8 — the send path
    // encodes it into the same FlatBuffers envelope media uses, because the
    // server only decodes the typed envelope. Treating every text payload as
    // UTF-8 turns exactly these into mojibake on a cold-start rebuild.
    const envelope = encodeMessagePayloadEnvelope({
      content: 'replying to you',
      mentioned_user_ids: ['4242'],
      reply_to_message_id: '777',
    });
    await putOutboxEntry(h.db, row('RPL', { content_type: 'text', payload: envelope }));

    const result = await h.engine.flushOutbox();
    expect(result.sent).toBe(1);

    const rebuilt = (await h.db.messages.toArray()).find(
      (m) => m.local_message_id === 'RPL',
    );
    expect(rebuilt?.content).toBe('replying to you');
    // And the bytes that go on the wire are still the envelope, so the reply
    // reference survives the rebuild.
    expect(rebuilt?.payload).toEqual(envelope);
  });

  it('sends a lost media row to repair instead of rebuilding it as text', async () => {
    const h = newHarness();
    h.setSendImpl(async () => okResp('s-IMG', 42));
    // Cold start, cache row gone, image command still queued. Its payload is
    // structured bytes; decoding them as UTF-8 gives a garbled bubble, and
    // the attachment's local file is not in the outbox row at all.
    await putOutboxEntry(
      h.db,
      row('IMG', {
        content_type: 'image',
        payload: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]),
      }),
    );

    await h.engine.flushOutbox();

    const after = await getOutboxEntry(h.db, 'IMG');
    expect(after?.status).toBe('integrity_error');
    // A missing row is not a contested id. Recording identity_conflict here
    // would send the repair actor off to re-mint an identity, discarding the
    // only link the command still has instead of re-hydrating the row.
    expect(after?.repair_kind).toBe('message_rehydrate');
    // Above all: no half-built message on screen.
    expect(await h.db.messages.toArray()).toHaveLength(0);
    expect(h.store.getMessages('100', 1)).toHaveLength(0);
  });

  it('still rebuilds a lost text row, whose payload really is the body', async () => {
    const h = newHarness();
    h.setSendImpl(async () => okResp('s-TXT', 43));
    await putOutboxEntry(h.db, row('TXT'));

    const result = await h.engine.flushOutbox();
    expect(result.sent).toBe(1);
    const rebuilt = (await h.db.messages.toArray())[0];
    expect(rebuilt?.content).toBe('body-TXT');
  });

  it('still joins on record_key for rows written before v11', async () => {
    const h = newHarness();
    h.store.upsertMessage(
      {
        id: 'legacy-1',
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
    // No message_id: exactly what an upgraded-but-not-backfilled row looks
    // like. Dropping these on the floor would strand queued sends.
    await putOutboxEntry(h.db, row('A'));

    const result = await h.engine.flushOutbox();
    expect(result.sent).toBe(1);
    const rows = h.store.getMessages('100', 1);
    expect(rows.find((m) => m.local_message_id === 'A')?.id).toBe('legacy-1');
  });
});

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
        id: 'r-A',
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

  it('Case 5: sending entry with a live lease is excluded (attempt in flight)', async () => {
    const h = newHarness();
    h.setSendImpl(async () => okResp('s'));
    await putOutboxEntry(
      h.db,
      row('IN-FLIGHT', {
        status: 'sending',
        lease_token: 'another-tab',
        lease_until: NOW + 30_000,
      }),
    );

    const result = await h.engine.flushOutbox();
    expect(result.attempted).toBe(0);
    expect(h.sendCalls).toHaveLength(0);
    // Row stays sending, still owned by the other attempt.
    const after = await getOutboxEntry(h.db, 'IN-FLIGHT');
    expect(after?.status).toBe('sending');
    expect(after?.lease_token).toBe('another-tab');
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

/**
 * A cache integrity fault is permanent — quarantine, never retry.
 *
 * `MessageIdentityConflictError` means a broken migration, a corrupted
 * database, or a reused id. Retrying cannot fix any of those, and the
 * message is already delivered, so the row must stop moving entirely
 * rather than loop forever or go back on the wire.
 */
describe('OutboxEngine — permanent integrity fault quarantines the row', () => {
  async function seedConflict(h: Harness): Promise<void> {
    h.store.upsertMessage(
      {
        id: 'r-A',
        channel_id: '100',
        channel_type: 1,
        local_message_id: 'A',
        from_uid: '999',
        message_type: 'text',
        content: 'body-A',
        payload: new Uint8Array(),
        timestamp: NOW,
        status: 'pending',
      },
      false,
    );
    // Park the pending row's identity on an unrelated row: the rekey then
    // refuses to overwrite it and raises the integrity error.
    await upsertMessage(h.db, {
      id: 'r-A',
      channel_id: 'someone-elses-channel',
      channel_type: 1,
      server_message_id: 'foreign-1',
      from_uid: '1',
      message_type: 'text',
      content: 'unrelated message',
      payload: new Uint8Array(),
      timestamp: NOW,
      status: 'received',
    });
    h.setSendImpl(async () => okResp('s-A', 42));
    await putOutboxEntry(h.db, row('A'));
  }

  it('freezes the row and records the delivered ACK', async () => {
    const h = newHarness();
    await seedConflict(h);

    await h.engine.flushOutbox();

    const entry = await getOutboxEntry(h.db, 'A');
    expect(entry?.status).toBe('integrity_error');
    expect(entry?.next_attempt_at).toBe(FROZEN_NEXT_ATTEMPT_AT);
    expect(entry?.last_error).toMatch(/^integrity:/);
    // The message IS delivered — the ACK is kept so repair never has to
    // ask the network again.
    expect(entry?.acked_server_message_id).toBe('s-A');
    expect(entry?.acked_message_seq).toBe(42);
  });

  it('never touches the network again', async () => {
    const h = newHarness();
    await seedConflict(h);

    for (let i = 0; i < 4; i += 1) {
      h.setNow(NOW + i * 3_600_000);
      await h.engine.flushOutbox();
    }

    // Exactly one send, on the first pass. Frozen rows are not even due.
    expect(h.sendCalls).toHaveLength(1);
  });

  it('reports integrity_error rather than a plain send failure', async () => {
    const db = newDb();
    const store = new MessageStore();
    const events: string[] = [];
    const engine = new OutboxEngine({
      db,
      store,
      sendMessage: async () => okResp('s-A', 42),
      getConnectionState: () => 'authenticated',
      now: () => NOW,
      warn: () => {},
      hooks: { onStateChanged: (e) => events.push(e.status) },
    });
    store.upsertMessage(
      {
        id: 'r-A',
        channel_id: '100',
        channel_type: 1,
        local_message_id: 'A',
        from_uid: '999',
        message_type: 'text',
        content: 'body-A',
        payload: new Uint8Array(),
        timestamp: NOW,
        status: 'pending',
      },
      false,
    );
    await upsertMessage(db, {
      id: 'r-A',
      channel_id: 'someone-elses-channel',
      channel_type: 1,
      server_message_id: 'foreign-1',
      from_uid: '1',
      message_type: 'text',
      content: 'unrelated message',
      payload: new Uint8Array(),
      timestamp: NOW,
      status: 'received',
    });
    await putOutboxEntry(db, row('A'));

    await engine.flushOutbox();

    // Never `sent` (untrue locally) and never plain `failed` (which a UI
    // renders with a retry button — and a retry would double-send).
    expect(events).not.toContain('sent');
    expect(events).not.toContain('failed');
    expect(events.at(-1)).toBe('integrity_error');
    db.close();
  });

  it('does not destroy the unrelated row that held the identity', async () => {
    const h = newHarness();
    await seedConflict(h);

    await h.engine.flushOutbox();

    const foreign = await getMessageWindow(h.db, 'someone-elses-channel', 1, 10);
    expect(foreign).toHaveLength(1);
    expect(foreign[0]!.content).toBe('unrelated message');
  });

  it('leaves the in-memory row pending rather than publishing sent', async () => {
    const h = newHarness();
    await seedConflict(h);

    await h.engine.flushOutbox();

    const cached = h.store.getMessages('100', 1);
    expect(cached).toHaveLength(1);
    expect(cached[0]!.status).toBe('pending');
    expect(cached[0]!.server_message_id).toBeUndefined();
  });
});

/**
 * `sending` must be a state the row can always leave.
 *
 * The due query is the only path back, and it skips leased rows — so a
 * process that dies mid-attempt would strand the message there forever
 * without an expiry. The same lease is what keeps two tabs from sending
 * one message twice.
 */
describe('OutboxEngine — sending lease', () => {
  it('claims the row with a lease before sending', async () => {
    const h = newHarness();
    let observed: OutboxEntry | undefined;
    h.setSendImpl(async () => {
      // Read the row as it stands *during* the send.
      observed = await getOutboxEntry(h.db, 'A');
      return okResp('s-A', 42);
    });
    await putOutboxEntry(h.db, row('A'));

    await h.engine.flushOutbox();

    expect(observed?.status).toBe('sending');
    expect(observed?.lease_token).toMatch(/^[0-9a-f]{32}$/);
    expect(observed?.lease_until).toBeGreaterThan(NOW);
  });

  it('recovers a row stranded in sending by a crash', async () => {
    // What a tab killed between claiming and finishing leaves behind.
    const h = newHarness();
    h.setSendImpl(async () => okResp('s-A', 42));
    await putOutboxEntry(
      h.db,
      row('A', {
        status: 'sending',
        lease_token: 'dead-tab',
        lease_until: NOW - 1,
      }),
    );

    const result = await h.engine.flushOutbox();

    expect(result.sent).toBe(1);
    // Retried under the SAME local_message_id, so a send the server already
    // saw is deduped rather than delivered a second time.
    expect(h.sendCalls.map((c) => c.local_message_id)).toEqual(['A']);
    expect(await getOutboxEntry(h.db, 'A')).toBeUndefined();
  });

  it('recovers a row whose server ACK landed before the crash', async () => {
    // Killed after the server accepted but before `ack_pending` was
    // written: the row is still `sending` with no stored ACK, so recovery
    // has to go through the network again — and the server dedupes on the
    // unchanged local_message_id.
    const h = newHarness();
    h.setSendImpl(async () => okResp('s-A', 42));
    await putOutboxEntry(
      h.db,
      row('A', { status: 'sending', lease_token: 'dead-tab', lease_until: NOW - 1 }),
    );
    h.store.upsertMessage(
      {
        id: 'r-A',
        channel_id: '100',
        channel_type: 1,
        local_message_id: 'A',
        from_uid: '999',
        message_type: 'text',
        content: 'body-A',
        payload: new Uint8Array(),
        timestamp: NOW,
        status: 'pending',
      },
      false,
    );

    await h.engine.flushOutbox();

    const cached = h.store.getMessages('100', 1);
    expect(cached).toHaveLength(1);
    expect(cached[0]!.status).toBe('sent');
    expect(cached[0]!.server_message_id).toBe('s-A');
    expect(cached[0]!.id).toBe('r-A');
  });

  // Same caveat as the sync-engine cross-tab case: under fake-indexeddb the
  // two flushes end up serialised, so this passes against the pre-lease
  // implementation too (verified) — it does not reproduce a real race. Kept
  // as a regression guard on the single-send outcome. The guarantee itself
  // is `claimOutboxEntry`'s compare-and-set inside one transaction.
  it('two engines on one row send it exactly once', async () => {
    // Two tabs, one account, one shared database.
    const dbName = `outbox-race-${Math.random().toString(36).slice(2, 8)}`;
    const dbA = new CacheDB(dbName);
    const dbB = new CacheDB(dbName);
    const sends: string[] = [];
    const mk = (db: CacheDB) =>
      new OutboxEngine({
        db,
        store: new MessageStore(),
        sendMessage: async (req) => {
          sends.push(req.local_message_id);
          // Hold the wire open so both engines are inside the send window.
          await new Promise((r) => setTimeout(r, 20));
          return okResp('s-A', 42);
        },
        getConnectionState: () => 'authenticated',
        now: () => NOW,
        warn: () => {},
      });
    await putOutboxEntry(dbA, row('A'));

    await Promise.all([mk(dbA).flushOutbox(), mk(dbB).flushOutbox()]);

    expect(sends).toEqual(['A']);
    dbA.close();
    dbB.close();
  });
});

/**
 * An integrity fault has to reach someone who can act on it.
 *
 * The row stops moving by design, so if nothing else happens the message
 * is stuck showing "syncing" indefinitely — a worse outcome than saying
 * plainly that local data is broken.
 */
describe('OutboxEngine — integrity faults are escalated', () => {
  it('reports the fault from the repair pass, with enough context to fix it', async () => {
    const db = newDb();
    const store = new MessageStore();
    const faults: Array<Record<string, unknown>> = [];
    const engine = new OutboxEngine({
      db,
      store,
      sendMessage: async () => okResp('s-A', 42),
      getConnectionState: () => 'authenticated',
      now: () => NOW,
      warn: () => {},
      hooks: {
        onIntegrityFault: (f) => {
          faults.push({ ...f });
        },
      },
    });
    store.upsertMessage(
      {
        id: 'r-A',
        channel_id: '100',
        channel_type: 1,
        local_message_id: 'A',
        from_uid: '999',
        message_type: 'text',
        content: 'body-A',
        payload: new Uint8Array(),
        timestamp: NOW,
        status: 'pending',
      },
      false,
    );
    await upsertMessage(db, {
      id: 'r-A',
      channel_id: 'someone-elses-channel',
      channel_type: 1,
      server_message_id: 'foreign-1',
      from_uid: '1',
      message_type: 'text',
      content: 'unrelated message',
      payload: new Uint8Array(),
      timestamp: NOW,
      status: 'received',
    });
    await putOutboxEntry(db, row('A'));

    // First flush quarantines the row; repair is the actor's job, so the
    // fault is reported by the next pass — one driver, not two.
    await engine.flushOutbox();
    expect(faults).toEqual([]);
    await engine.flushOutbox();

    expect(faults).toHaveLength(1);
    expect(faults[0]).toMatchObject({
      outbox_id: 'A',
      local_message_id: 'A',
      channel_id: '100',
      // The message IS delivered — repair must not re-send it.
      server_message_id: 's-A',
      // Which id collided, and where the row holding it lives. Without
      // these a restarted repair cannot tell what to fix.
      conflicting_id: 'r-A',
      conflicting_channel_id: 'someone-elses-channel',
      repair_attempt: 1,
    });
    db.close();
  });

  it('a throwing hook does not break the flush', async () => {
    const db = newDb();
    const store = new MessageStore();
    const engine = new OutboxEngine({
      db,
      store,
      sendMessage: async () => okResp('s-A', 42),
      getConnectionState: () => 'authenticated',
      now: () => NOW,
      warn: () => {},
      hooks: {
        onIntegrityFault: () => {
          throw new Error('host blew up');
        },
      },
    });
    store.upsertMessage(
      {
        id: 'r-A',
        channel_id: '100',
        channel_type: 1,
        local_message_id: 'A',
        from_uid: '999',
        message_type: 'text',
        content: 'body-A',
        payload: new Uint8Array(),
        timestamp: NOW,
        status: 'pending',
      },
      false,
    );
    await upsertMessage(db, {
      id: 'r-A',
      channel_id: 'someone-elses-channel',
      channel_type: 1,
      server_message_id: 'foreign-1',
      from_uid: '1',
      message_type: 'text',
      content: 'unrelated',
      payload: new Uint8Array(),
      timestamp: NOW,
      status: 'received',
    });
    await putOutboxEntry(db, row('A'));

    const result = await engine.flushOutbox();
    expect(result.failed).toBe(1);
    expect((await getOutboxEntry(db, 'A'))?.status).toBe('integrity_error');
    db.close();
  });
});

/**
 * `integrity_error` has to reach a real end state.
 *
 * Repair runs off the row's status, not off a one-shot callback: a fault
 * announced once and then forgotten leaves the row frozen forever if the
 * page dies before the host acts. And when repair genuinely cannot work,
 * the row must say so — a permanent "syncing" spinner is a worse lie than
 * an error.
 */
describe('OutboxEngine — integrity repair closes the loop', () => {
  async function seedQuarantined(h: Harness): Promise<void> {
    h.store.upsertMessage(
      {
        id: 'r-A',
        channel_id: '100',
        channel_type: 1,
        local_message_id: 'A',
        from_uid: '999',
        message_type: 'text',
        content: 'body-A',
        payload: new Uint8Array(),
        timestamp: NOW,
        status: 'pending',
      },
      false,
    );
    await upsertMessage(h.db, {
      id: 'r-A',
      channel_id: 'someone-elses-channel',
      channel_type: 1,
      server_message_id: 'foreign-1',
      from_uid: '1',
      message_type: 'text',
      content: 'unrelated message',
      payload: new Uint8Array(),
      timestamp: NOW,
      status: 'received',
    });
    h.setSendImpl(async () => okResp('s-A', 42));
    await putOutboxEntry(h.db, row('A'));
    await h.engine.flushOutbox(); // → integrity_error
  }

  it('re-attempts repair on a later flush, after a reload', async () => {
    const h = newHarness();
    const attempts: number[] = [];
    await seedQuarantined(h);
    // A fresh engine, as a reloaded page would build. The frozen row is not
    // due, so only a status-driven pass can find it.
    const reborn = new OutboxEngine({
      db: h.db,
      store: h.store,
      sendMessage: async () => okResp('s-A', 42),
      getConnectionState: () => 'authenticated',
      now: () => NOW + 60_000,
      warn: () => {},
      hooks: {
        onIntegrityFault: (f) => {
          attempts.push(f.repair_attempt ?? 0);
        },
      },
    });

    await reborn.flushOutbox();

    // Quarantining is not itself a repair pass, so this is attempt 1 — the
    // point is that a brand-new engine finds the frozen row at all.
    expect(attempts).toEqual([1]);
  });

  it('converges to sent by re-minting, with no host repair at all', async () => {
    const h = newHarness();
    await seedQuarantined(h);

    const repairing = new OutboxEngine({
      db: h.db,
      store: h.store,
      sendMessage: async () => {
        throw new Error('repair must not touch the network');
      },
      getConnectionState: () => 'authenticated',
      now: () => NOW + 600_000,
      warn: () => {},
    });

    await repairing.flushOutbox();

    // Replayed the stored ACK — no network — and the row is done.
    expect(await getOutboxEntry(h.db, 'A')).toBeUndefined();
    const cached = h.store.getMessages('100', 1);
    expect(cached).toHaveLength(1);
    expect(cached[0]!.status).toBe('sent');
    expect(cached[0]!.server_message_id).toBe('s-A');
    // A replacement identity, because the old one was taken.
    expect(cached[0]!.id).not.toBe('r-A');
    expect(cached[0]!.id).toMatch(/^\d+$/);
  });

  it('recoverLocalState repairs without a connection', async () => {
    const h = newHarness();
    await seedQuarantined(h);

    const offline = new OutboxEngine({
      db: h.db,
      store: h.store,
      sendMessage: async () => {
        throw new Error('must not touch the network');
      },
      getConnectionState: () => 'disconnected',
      now: () => NOW + 600_000,
      warn: () => {},
    });

    await offline.recoverLocalState();

    expect(await getOutboxEntry(h.db, 'A')).toBeUndefined();
    expect(h.store.getMessages('100', 1)[0]!.status).toBe('sent');
  });
});

/**
 * Fencing: a lease that expired mid-flight must not let the old owner
 * write over its successor.
 *
 * Deterministic here — A's send is held open by hand, the clock is pushed
 * past the lease, B takes over, and only then is A released.
 */
describe('OutboxEngine — expired owner cannot clobber the new owner', () => {
  interface Rig {
    db: CacheDB;
    store: MessageStore;
    releaseA: (outcome: 'ok' | 'fail') => void;
    engineA: OutboxEngine;
    engineB: OutboxEngine;
    events: OutboxStateChangedEvent[];
    setNow: (n: number) => void;
  }

  function rig(): Rig {
    const db = newDb();
    const store = new MessageStore();
    const events: OutboxStateChangedEvent[] = [];
    let now = NOW;
    let release!: (outcome: 'ok' | 'fail') => void;
    const aInFlight = new Promise<'ok' | 'fail'>((resolve) => {
      release = resolve;
    });

    const engineA = new OutboxEngine({
      db,
      store,
      sendMessage: async () => {
        const outcome = await aInFlight;
        if (outcome === 'fail') throw new Error('A: transport died');
        return okResp('s-A', 42);
      },
      getConnectionState: () => 'authenticated',
      now: () => now,
      warn: () => {},
      config: { leaseMs: 1_000, sendTimeoutMs: 500 },
      hooks: { onStateChanged: (e) => events.push(e) },
    });
    const engineB = new OutboxEngine({
      db,
      store,
      sendMessage: async () => okResp('s-B', 43),
      getConnectionState: () => 'authenticated',
      now: () => now,
      warn: () => {},
      config: { leaseMs: 1_000, sendTimeoutMs: 500 },
      hooks: { onStateChanged: (e) => events.push(e) },
    });

    return {
      db,
      store,
      releaseA: release,
      engineA,
      engineB,
      events,
      setNow: (n) => {
        now = n;
      },
    };
  }

  it('the stale owner cannot write failed over the new owner state', async () => {
    const r = rig();
    await putOutboxEntry(r.db, row('A'));

    const aFlush = r.engineA.flushOutbox();
    await waitFor(async () => (await getOutboxEntry(r.db, 'A'))?.status === 'sending', 500);
    const tokenA = (await getOutboxEntry(r.db, 'A'))!.lease_token;

    // A's lease expires and B takes over — B's own attempt is still in
    // progress, so the row is present and owned by B. (If B had already
    // finished and deleted the row, A would be blocked simply by its
    // absence, which would prove nothing about fencing.)
    r.setNow(NOW + 5_000);
    const claimed = await claimOutboxEntry(r.db, 'A', 'token-B', NOW + 5_000, 1_000);
    expect(claimed?.lease_token).toBe('token-B');
    expect(tokenA).not.toBe('token-B');

    // Now A comes back and fails; it would write `failed` + backoff.
    r.releaseA('fail');
    await aFlush;

    const after = await getOutboxEntry(r.db, 'A');
    expect(after?.lease_token).toBe('token-B');
    expect(after?.status).toBe('sending');
    expect(after?.attempt_count).toBe(0);
    // And A published nothing — the state it would have described is no
    // longer the truth about this row.
    expect(r.events.filter((e) => e.status === 'failed')).toEqual([]);
  });

  it('the stale owner cannot delete the row the new owner is working on', async () => {
    const r = rig();
    await putOutboxEntry(r.db, row('A'));
    r.store.upsertMessage(
      {
        id: 'r-A',
        channel_id: '100',
        channel_type: 1,
        local_message_id: 'A',
        from_uid: '999',
        message_type: 'text',
        content: 'body-A',
        payload: new Uint8Array(),
        timestamp: NOW,
        status: 'pending',
      },
      false,
    );

    const aFlush = r.engineA.flushOutbox();
    await waitFor(async () => (await getOutboxEntry(r.db, 'A'))?.status === 'sending', 500);

    // A's lease expires and B claims it, but B's own attempt is not
    // finished yet — simulate by claiming directly.
    r.setNow(NOW + 5_000);
    const claimed = await claimOutboxEntry(r.db, 'A', 'token-B', NOW + 5_000, 1_000);
    expect(claimed?.lease_token).toBe('token-B');

    // A returns successfully and would delete the row + publish `sent`.
    r.releaseA('ok');
    await aFlush;

    // The row still belongs to B.
    const after = await getOutboxEntry(r.db, 'A');
    expect(after?.lease_token).toBe('token-B');
    expect(after?.status).toBe('sending');
    // And A published nothing about it.
    expect(r.events.filter((e) => e.status === 'sent')).toEqual([]);
  });
});

/**
 * Claiming is a strict state transition, not "is the lease free?".
 *
 * A caller's `due` snapshot can be stale by the time it claims: another tab
 * may have sent the message and moved the row to a delivered state in
 * between. Trusting the snapshot sends that message a second time.
 */
describe('OutboxEngine — claim refuses already-delivered rows', () => {
  it('cannot claim ack_pending, even with no live lease', async () => {
    const db = newDb();
    await putOutboxEntry(
      db,
      row('A', {
        status: 'ack_pending',
        acked_server_message_id: 's-A',
        acked_message_seq: 42,
        next_attempt_at: 0,
      }),
    );

    const claimed = await claimOutboxEntry(db, 'A', 'token-B', NOW, 60_000);

    expect(claimed).toBeUndefined();
    const after = await getOutboxEntry(db, 'A');
    expect(after?.status).toBe('ack_pending');
  });

  it('cannot claim integrity_error', async () => {
    const db = newDb();
    await putOutboxEntry(
      db,
      row('A', { status: 'integrity_error', acked_server_message_id: 's-A' }),
    );

    expect(await claimOutboxEntry(db, 'A', 'token-B', NOW, 60_000)).toBeUndefined();
    expect((await getOutboxEntry(db, 'A'))?.status).toBe('integrity_error');
  });

  it('does not re-send a row another tab moved to ack_pending mid-flush', async () => {
    // The exact stale-snapshot race: this engine picked the row up as
    // `pending`, and by the time it claims, the row is delivered.
    const db = newDb();
    const store = new MessageStore();
    const sends: string[] = [];
    const engine = new OutboxEngine({
      db,
      store,
      sendMessage: async (req) => {
        sends.push(req.local_message_id);
        return okResp('s-A', 42);
      },
      getConnectionState: () => 'authenticated',
      now: () => NOW,
      warn: () => {},
    });
    await putOutboxEntry(db, row('A'));
    const stale = (await getOutboxEntry(db, 'A'))!;

    // Another tab: sent it, local commit failed, row is now delivered.
    await updateOutboxStatus(db, 'A', {
      status: 'ack_pending',
      acked_server_message_id: 's-A',
      acked_message_seq: 42,
      next_attempt_at: NOW + 60_000,
    });

    // Now this engine acts on its stale snapshot.
    await engine['processRow'](stale, { attempted: 0, sent: 0, failed: 0, skipped: 0 });

    expect(sends).toEqual([]);
    expect((await getOutboxEntry(db, 'A'))?.status).toBe('ack_pending');
    db.close();
  });
});

/**
 * The repair for an id collision is to re-mint OUR id — never to delete
 * the row that holds it. That row belongs to another conversation and may
 * be a perfectly good message; freeing an arbitrary number by destroying
 * it trades a recoverable fault for real data loss.
 */
describe('OutboxEngine — identity conflict repairs by re-minting', () => {
  async function seedQuarantinedRow(h: Harness): Promise<void> {
    h.store.upsertMessage(
      {
        id: 'r-A',
        channel_id: '100',
        channel_type: 1,
        local_message_id: 'A',
        from_uid: '999',
        message_type: 'text',
        content: 'body-A',
        payload: new Uint8Array(),
        timestamp: NOW,
        status: 'pending',
      },
      false,
    );
    await upsertMessage(h.db, {
      id: 'r-A',
      channel_id: 'someone-elses-channel',
      channel_type: 1,
      server_message_id: 'foreign-1',
      from_uid: '1',
      message_type: 'text',
      content: 'a real message in another conversation',
      payload: new Uint8Array(),
      timestamp: NOW,
      status: 'received',
    });
    h.setSendImpl(async () => okResp('s-A', 42));
    await putOutboxEntry(h.db, row('A'));
    await h.engine.flushOutbox(); // → integrity_error
  }

  it('persists what collided so a restarted repair knows what to fix', async () => {
    const h = newHarness();
    await seedQuarantinedRow(h);

    const entry = await getOutboxEntry(h.db, 'A');
    expect(entry?.repair_kind).toBe('identity_conflict');
    expect(entry?.conflicting_id).toBe('r-A');
    expect(entry?.conflicting_channel_id).toBe('someone-elses-channel');
  });

  it('repairs with no host hook at all, and keeps the other message', async () => {
    const h = newHarness();
    await seedQuarantinedRow(h);

    // No onIntegrityFault: the SDK must be able to fix an id collision on
    // its own. A resync of our channel could never clear a row that lives
    // in a different one.
    const repairing = new OutboxEngine({
      db: h.db,
      store: h.store,
      sendMessage: async () => {
        throw new Error('repair must not touch the network');
      },
      getConnectionState: () => 'authenticated',
      now: () => NOW + 600_000,
      warn: () => {},
    });

    await repairing.flushOutbox();

    // Converged.
    expect(await getOutboxEntry(h.db, 'A')).toBeUndefined();
    const ours = await getMessageWindow(h.db, '100', 1, 10);
    expect(ours).toHaveLength(1);
    expect(ours[0]!.server_message_id).toBe('s-A');
    expect(ours[0]!.id).not.toBe('r-A'); // re-minted

    // The other conversation is untouched.
    const foreign = await getMessageWindow(h.db, 'someone-elses-channel', 1, 10);
    expect(foreign).toHaveLength(1);
    expect(foreign[0]!.id).toBe('r-A');
    expect(foreign[0]!.content).toBe('a real message in another conversation');
  });
});
