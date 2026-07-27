// The server accepted the message but the local ACK commit failed
// (CONVERSATION_DEPENDENCY_READINESS §3.3).
//
// That state is `ack_pending`, and it has one rule above all others: the
// message must never go back on the wire. It is already delivered.
// Re-sending it relies on the server's idempotency record still being
// around, and those expire — when one does, the user sees their message
// twice. So the ACK itself is persisted on the outbox row and recovery
// replays it locally.
//
// A *transient* storage failure is injected here; the permanent case
// (`ProjectionRehydrateRequiredError` → quarantine) lives in
// outbox-engine.test.ts. `vi.mock` is module-scoped, hence the own file.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ackRekeyShouldFail = { value: false };
/** Simulates damage that re-minting cannot fix — the rekey refuses no
 *  matter what identity it is handed. */
const ackAlwaysUnrecoverable = { value: false };

vi.mock('../src/cache/index.js', async () => {
  const actual = await vi.importActual<typeof import('../src/cache/index.js')>(
    '../src/cache/index.js',
  );
  return {
    ...actual,
    applyAck: async (...args: Parameters<typeof actual.applyAck>) => {
      if (ackAlwaysUnrecoverable.value) {
        throw new actual.ProjectionRehydrateRequiredError('m-A', '100', 'image');
      }
      if (ackRekeyShouldFail.value) {
        // Transient: the kind of failure a retry can actually resolve.
        throw new Error('injected: IndexedDB write failed');
      }
      return actual.applyAck(...args);
    },
  };
});

const { CacheDB, MessageStore, claimRepairRow, getOutboxEntry, putOutboxEntry } =
  await import('../src/cache/index.js');
const { OutboxEngine, FROZEN_NEXT_ATTEMPT_AT } = await import('../src/outbox-engine.js');
type OutboxEntry = import('../src/cache/index.js').OutboxEntry;
type SendMessageRequest = import('../src/codec/send.js').SendMessageRequest;

const NOW = 1_700_000_000_000;

const row = (overrides: Partial<OutboxEntry> = {}): OutboxEntry => ({
  outbox_id: 'A',
  message_id: 'm-A',
  channel_id: '100',
  channel_type: 1,
  local_message_id: 'A',
  from_uid: '999',
  content_type: 'text',
  payload: new TextEncoder().encode('body-A'),
  created_at: NOW,
  updated_at: NOW,
  attempt_count: 0,
  next_attempt_at: 0,
  status: 'pending',
  ...overrides,
});

let db: InstanceType<typeof CacheDB>;
let store: InstanceType<typeof MessageStore>;
let engine: InstanceType<typeof OutboxEngine>;
let sendCalls: SendMessageRequest[];
let events: string[];
let now = NOW;
let dbCounter = 0;
let connectionState: 'authenticated' | 'disconnected' = 'authenticated';

beforeEach(async () => {
  ackRekeyShouldFail.value = true;
  ackAlwaysUnrecoverable.value = false;
  connectionState = 'authenticated';
  now = NOW;
  sendCalls = [];
  events = [];
  db = new CacheDB(`outbox-ack-recovery-${++dbCounter}-${Math.random().toString(36).slice(2, 8)}`);
  store = new MessageStore();
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
  engine = new OutboxEngine({
    db,
    store,
    sendMessage: async (req) => {
      sendCalls.push(req);
      return { client_seq: 0, server_message_id: 's-A', message_seq: 42, reason_code: 0 };
    },
    getConnectionState: () => connectionState,
    now: () => now,
    warn: () => {},
    hooks: { onStateChanged: (e) => events.push(e.status) },
  });
  await putOutboxEntry(db, row());
});

afterEach(() => {
  ackRekeyShouldFail.value = false;
  ackAlwaysUnrecoverable.value = false;
  try {
    db.close();
  } catch {
    /* ignore */
  }
});

describe('OutboxEngine — delivered but not yet committed locally', () => {
  it('moves to ack_pending and stores the server ACK', async () => {
    await engine.flushOutbox();

    const entry = await getOutboxEntry(db, 'A');
    expect(entry?.status).toBe('ack_pending');
    expect(entry?.acked_server_message_id).toBe('s-A');
    expect(entry?.acked_message_seq).toBe(42);
    // The send budget is untouched: this was not the server refusing.
    expect(entry?.attempt_count).toBe(0);
    expect(entry?.local_commit_failures).toBe(1);
  });

  it('retries LOCALLY — the network is called exactly once, ever', async () => {
    await engine.flushOutbox();
    for (let i = 1; i <= 4; i += 1) {
      now = NOW + i * 60_000;
      await engine.flushOutbox();
    }

    // One send. Every later pass replayed the stored ACK instead.
    expect(sendCalls).toHaveLength(1);
    expect((await getOutboxEntry(db, 'A'))?.local_commit_failures).toBe(5);
  });

  it('converges to sent once the local write succeeds, still without re-sending', async () => {
    await engine.flushOutbox();
    expect(await getOutboxEntry(db, 'A')).toBeDefined();

    ackRekeyShouldFail.value = false;
    now = NOW + 60_000;
    const result = await engine.flushOutbox();

    expect(result.sent).toBe(1);
    expect(sendCalls).toHaveLength(1);
    expect(await getOutboxEntry(db, 'A')).toBeUndefined();

    const cached = store.getMessages('100', 1);
    expect(cached).toHaveLength(1);
    expect(cached[0]!.status).toBe('sent');
    expect(cached[0]!.server_message_id).toBe('s-A');
    // Identity survived the whole detour.
    expect(cached[0]!.id).toBe('m-A');
  });

  it('never freezes: a delivered message must stay recoverable', async () => {
    for (let i = 0; i < 12; i += 1) {
      now = NOW + i * 3_600_000;
      await engine.flushOutbox();
    }
    expect((await getOutboxEntry(db, 'A'))?.next_attempt_at).not.toBe(
      FROZEN_NEXT_ATTEMPT_AT,
    );
  });

  it('reports ack_pending, never a plain send failure', async () => {
    await engine.flushOutbox();

    // `failed` is what a UI renders with a retry button; a retry that mints
    // a new local_message_id would send this message a second time.
    expect(events).not.toContain('failed');
    expect(events).not.toContain('sent');
    expect(events.at(-1)).toBe('ack_pending');
  });

  it('keeps the pending row visible in memory while it converges', async () => {
    await engine.flushOutbox();

    const cached = store.getMessages('100', 1);
    expect(cached).toHaveLength(1);
    expect(cached[0]!.status).toBe('pending');
  });
});

describe('OutboxEngine — ack_pending recovery is offline-safe', () => {
  it('converges while disconnected, because no network is involved', async () => {
    await engine.flushOutbox();
    expect((await getOutboxEntry(db, 'A'))?.status).toBe('ack_pending');

    // Go offline, then let the local write succeed.
    connectionState = 'disconnected';
    ackRekeyShouldFail.value = false;
    now = NOW + 60_000;
    const result = await engine.flushOutbox();

    // Gating this on connectivity would leave a delivered message showing
    // as unsettled until the network came back, for no reason.
    expect(result.sent).toBe(1);
    expect(result.skipped).toBe(0);
    expect(await getOutboxEntry(db, 'A')).toBeUndefined();
    expect(store.getMessages('100', 1)[0]!.status).toBe('sent');
    // And still exactly one network call, from the original send.
    expect(sendCalls).toHaveLength(1);
  });

  it('does not count a local-only retry as a network attempt', async () => {
    await engine.flushOutbox();
    now = NOW + 60_000;
    const result = await engine.flushOutbox();
    expect(result.attempted).toBe(0);
  });
});

/**
 * When repair genuinely cannot work, the row must say so.
 *
 * A permanent "syncing" spinner for a message that will never converge is
 * a worse lie than an error: the user has no way to know the message is
 * on the server but this device is broken.
 */
describe('OutboxEngine — repair gives up honestly', () => {
  it('reaches local_data_error after the repair budget, with backoff between passes', async () => {
    ackRekeyShouldFail.value = false;
    ackAlwaysUnrecoverable.value = true;

    const engineWithBudget = new OutboxEngine({
      db,
      store,
      sendMessage: async (req) => {
        sendCalls.push(req);
        return { client_seq: 0, server_message_id: 's-A', message_seq: 42, reason_code: 0 };
      },
      getConnectionState: () => connectionState,
      now: () => now,
      warn: () => {},
      config: { maxRepairAttempts: 3, initialDelayMs: 1_000, maxDelayMs: 10_000 },
      hooks: { onStateChanged: (e) => events.push(e.status) },
    });

    await engineWithBudget.flushOutbox(); // send → quarantine
    expect((await getOutboxEntry(db, 'A'))?.status).toBe('integrity_error');

    // A burst of flushes at the same instant must not burn the budget.
    await engineWithBudget.flushOutbox(); // repair 1
    await engineWithBudget.flushOutbox(); // backing off — no attempt
    await engineWithBudget.flushOutbox();
    expect((await getOutboxEntry(db, 'A'))?.repair_attempts).toBe(1);

    now += 60_000;
    await engineWithBudget.flushOutbox(); // repair 2
    now += 60_000;
    await engineWithBudget.flushOutbox(); // repair 3 → give up

    const entry = await getOutboxEntry(db, 'A');
    expect(entry?.status).toBe('local_data_error');
    expect(entry?.repair_attempts).toBe(3);
    expect(events).toContain('local_data_error');
    // And it was never re-sent along the way.
    expect(sendCalls).toHaveLength(1);
  });

  it('a local_data_error row is never claimed for sending again', async () => {
    ackRekeyShouldFail.value = false;
    ackAlwaysUnrecoverable.value = true;
    const e = new OutboxEngine({
      db,
      store,
      sendMessage: async (req) => {
        sendCalls.push(req);
        return { client_seq: 0, server_message_id: 's-A', message_seq: 42, reason_code: 0 };
      },
      getConnectionState: () => connectionState,
      now: () => now,
      warn: () => {},
      config: { maxRepairAttempts: 1 },
    });
    await e.flushOutbox();
    await e.flushOutbox();
    expect((await getOutboxEntry(db, 'A'))?.status).toBe('local_data_error');

    const before = sendCalls.length;
    for (let i = 0; i < 3; i += 1) {
      now += 600_000;
      await e.flushOutbox();
    }
    expect(sendCalls).toHaveLength(before);
  });
});

/**
 * Repair holds its own lease, distinct from the send lease.
 *
 * Passing "no lease" into the ACK commit would let a repair pass whose
 * lease expired delete a row that a newer repair owner is working on.
 */
describe('OutboxEngine — repair ACK is fenced by the repair lease', () => {
  it('a repair pass whose lease is stolen mid-pass does not delete the row', async () => {
    // End-to-end: the lease is taken away WHILE the repair pass runs (the
    // host hook is awaited inside it), so the pass finishes holding a token
    // that is no longer valid. Its ACK commit must be refused.
    ackRekeyShouldFail.value = false;
    ackAlwaysUnrecoverable.value = true;

    let stolen = false;
    // Recorded, not asserted inside the hook: `attemptRepair` catches hook
    // exceptions (a host must not be able to break repair), so an assertion
    // failing in there would be swallowed and hide the real state.
    let stolenToken: string | undefined;
    const e = new OutboxEngine({
      db,
      store,
      sendMessage: async (req) => {
        sendCalls.push(req);
        return { client_seq: 0, server_message_id: 's-A', message_seq: 42, reason_code: 0 };
      },
      getConnectionState: () => connectionState,
      now: () => now,
      warn: () => {},
      // Short repair lease so it can expire mid-pass, which is the whole
      // scenario: a stalled owner whose ownership is legitimately taken.
      config: { maxRepairAttempts: 10, leaseMs: 1_000, sendTimeoutMs: 400 },
      hooks: {
        onIntegrityFault: async () => {
          if (stolen) return;
          stolen = true;
          // Repair can now succeed, but this pass no longer owns the row.
          ackAlwaysUnrecoverable.value = false;
          now += 5_000;
          const taken = await claimRepairRow(db, 'A', 'repair-B', now, 60_000);
          stolenToken = taken?.repair_lease_token;
        },
      },
    });

    await e.flushOutbox(); // send → quarantine
    expect((await getOutboxEntry(db, 'A'))?.status).toBe('integrity_error');

    await e.flushOutbox(); // repair pass; loses its lease halfway through
    expect(stolenToken).toBe('repair-B'); // the takeover really happened

    // The row survives, still owned by the newer repair owner.
    const after = await getOutboxEntry(db, 'A');
    expect(after).toBeDefined();
    expect(after?.repair_lease_token).toBe('repair-B');
    // And exactly one network send happened, at the very beginning.
    expect(sendCalls).toHaveLength(1);
  });


  it('a stale repair owner cannot delete the row', async () => {
    ackRekeyShouldFail.value = false;
    ackAlwaysUnrecoverable.value = true;
    const e = new OutboxEngine({
      db,
      store,
      sendMessage: async (req) => {
        sendCalls.push(req);
        return { client_seq: 0, server_message_id: 's-A', message_seq: 42, reason_code: 0 };
      },
      getConnectionState: () => connectionState,
      now: () => now,
      warn: () => {},
      config: { maxRepairAttempts: 10 },
    });
    await e.flushOutbox(); // → integrity_error
    expect((await getOutboxEntry(db, 'A'))?.status).toBe('integrity_error');

    // A repair owner takes the row, then stalls past its lease.
    const claimed = await claimRepairRow(db, 'A', 'repair-A', now, 1_000);
    expect(claimed?.repair_lease_token).toBe('repair-A');

    // A newer owner legitimately takes over.
    now += 5_000;
    const taken = await claimRepairRow(db, 'A', 'repair-B', now, 60_000);
    expect(taken?.repair_lease_token).toBe('repair-B');

    // The stale owner now tries to finish: its ACK commit must not delete
    // the row out from under repair-B.
    ackAlwaysUnrecoverable.value = false;
    const applyAck = (
      e as unknown as {
        applyAck: (
          entry: unknown,
          resp: unknown,
          lease: unknown,
          overrideId?: string,
        ) => Promise<boolean>;
      }
    ).applyAck.bind(e);
    const owned = await applyAck(
      claimed,
      { client_seq: 0, server_message_id: 's-A', message_seq: 42, reason_code: 0 },
      { kind: 'repair', token: 'repair-A' },
    );

    expect(owned).toBe(false);
    const after = await getOutboxEntry(db, 'A');
    expect(after).toBeDefined();
    expect(after?.repair_lease_token).toBe('repair-B');
  });
});
