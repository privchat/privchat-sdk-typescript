// Phase 5C-1a unit tests for the outbox storage adapter. Pure CRUD —
// no scheduling, no engine state. Each test owns a fresh CacheDB
// against fake-indexeddb so persistence is observable.

import { afterEach, describe, expect, it } from 'vitest';
import {
  CacheDB,
  deleteOutboxEntry,
  getOutboxByLocalMessageId,
  getOutboxEntry,
  listDueOutboxEntries,
  listOutboxByChannel,
  listOutboxEntries,
  putOutboxEntry,
  updateOutboxStatus,
  upsertChannels,
  upsertMessages,
  upsertSyncState,
  type ChannelRecord,
  type MessageRecord,
  type OutboxEntry,
} from '../../src/cache/index.js';

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
  const db = new CacheDB(`outbox-${++dbCounter}-${Math.random().toString(36).slice(2, 8)}`);
  dbs.push(db);
  return db;
}

const NOW = 1_700_000_000_000;

function entry(
  outbox_id: string,
  overrides: Partial<OutboxEntry> = {},
): OutboxEntry {
  return {
    outbox_id,
    record_key: `l:${outbox_id}`,
    channel_id: '100',
    channel_type: 1,
    local_message_id: outbox_id, // 5C: outbox_id === local_message_id
    from_uid: '999',
    content_type: 'text',
    payload: new TextEncoder().encode(`body-${outbox_id}`),
    created_at: NOW,
    updated_at: NOW,
    attempt_count: 0,
    next_attempt_at: 0, // due now
    status: 'pending',
    ...overrides,
  };
}

// ----- Case 1: Uint8Array round-trip -----

describe('Uint8Array payload round-trip', () => {
  it('preserves bytes through put + get', async () => {
    const db = newDb();
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    await putOutboxEntry(db, entry('a', { payload: bytes }));
    const back = await getOutboxEntry(db, 'a');
    expect(back).toBeDefined();
    // fake-indexeddb returns Uint8Array directly; some browsers may
    // return ArrayBuffer — coerce defensively in production. For the
    // test we assert byte equality both ways.
    const view = back!.payload instanceof Uint8Array
      ? back!.payload
      : new Uint8Array(back!.payload);
    expect(Array.from(view)).toEqual(Array.from(bytes));
  });

  it('handles empty Uint8Array', async () => {
    const db = newDb();
    await putOutboxEntry(db, entry('e', { payload: new Uint8Array() }));
    const back = await getOutboxEntry(db, 'e');
    expect(back!.payload.length).toBe(0);
  });
});

// ----- Case 2: local_message_id uniqueness -----

describe('local_message_id uniqueness', () => {
  it('rejects two entries with the same local_message_id', async () => {
    const db = newDb();
    await putOutboxEntry(db, entry('a1', { local_message_id: 'L-1' }));
    // Different outbox_id but same local_message_id → should fail.
    await expect(
      putOutboxEntry(db, entry('a2', { local_message_id: 'L-1' })),
    ).rejects.toThrow();
  });

  it('allows distinct local_message_ids', async () => {
    const db = newDb();
    await putOutboxEntry(db, entry('a1', { local_message_id: 'L-1' }));
    await putOutboxEntry(db, entry('a2', { local_message_id: 'L-2' }));
    expect(await listOutboxEntries(db)).toHaveLength(2);
  });

  it('lookup by local_message_id returns the matching row', async () => {
    const db = newDb();
    await putOutboxEntry(db, entry('a1', { local_message_id: 'L-7' }));
    await putOutboxEntry(db, entry('a2', { local_message_id: 'L-9' }));
    const found = await getOutboxByLocalMessageId(db, 'L-9');
    expect(found?.outbox_id).toBe('a2');
    expect(await getOutboxByLocalMessageId(db, 'L-missing')).toBeUndefined();
  });
});

// ----- Case 3: per-channel FIFO ordering -----

describe('per-channel FIFO ordering', () => {
  it('listOutboxByChannel returns rows in created_at ascending order', async () => {
    const db = newDb();
    // Insert out of natural order to ensure sort, not insertion order.
    await putOutboxEntry(db, entry('b', { created_at: NOW + 200 }));
    await putOutboxEntry(db, entry('a', { created_at: NOW + 100 }));
    await putOutboxEntry(db, entry('c', { created_at: NOW + 300 }));
    const rows = await listOutboxByChannel(db, '100', 1);
    expect(rows.map((r) => r.outbox_id)).toEqual(['a', 'b', 'c']);
  });

  it('listOutboxByChannel scopes to one channel_id (channel_type is not part of the queue identity)', async () => {
    // Conversation identity is the channel_id alone. Outbox rows for the
    // same channel_id share one queue, regardless of the `channel_type`
    // attribute they carried at enqueue time. Cross-channel_id rows stay
    // separate.
    const db = newDb();
    await putOutboxEntry(db, entry('a', { channel_id: '100', channel_type: 1 }));
    await putOutboxEntry(db, entry('b', { channel_id: '100', channel_type: 2 }));
    await putOutboxEntry(db, entry('c', { channel_id: '200', channel_type: 1 }));
    const ch100 = await listOutboxByChannel(db, '100', 1);
    expect(ch100.map((r) => r.outbox_id).sort()).toEqual(['a', 'b']);
    const ch200 = await listOutboxByChannel(db, '200', 1);
    expect(ch200.map((r) => r.outbox_id)).toEqual(['c']);
  });

  it('listOutboxEntries sorts globally by created_at', async () => {
    const db = newDb();
    await putOutboxEntry(db, entry('b', { channel_id: '100', created_at: NOW + 100 }));
    await putOutboxEntry(db, entry('a', { channel_id: '200', created_at: NOW + 50 }));
    await putOutboxEntry(db, entry('c', { channel_id: '300', created_at: NOW + 200 }));
    const rows = await listOutboxEntries(db);
    expect(rows.map((r) => r.outbox_id)).toEqual(['a', 'b', 'c']);
  });
});

// ----- Case 4: listDueOutboxEntries (status + next_attempt_at filter) -----

describe('listDueOutboxEntries', () => {
  it('returns only pending/failed rows whose next_attempt_at <= now', async () => {
    const db = newDb();
    await putOutboxEntry(db, entry('p-due', { status: 'pending', next_attempt_at: NOW - 100 }));
    await putOutboxEntry(db, entry('p-future', { status: 'pending', next_attempt_at: NOW + 1000 }));
    await putOutboxEntry(db, entry('f-due', { status: 'failed', next_attempt_at: NOW - 50 }));
    await putOutboxEntry(db, entry('s-due', { status: 'sending', next_attempt_at: NOW - 100 }));

    const due = await listDueOutboxEntries(db, NOW);
    const ids = due.map((r) => r.outbox_id).sort();
    expect(ids).toEqual(['f-due', 'p-due']); // sending excluded; future excluded
  });

  it('treats next_attempt_at === now as due (boundary)', async () => {
    const db = newDb();
    await putOutboxEntry(db, entry('boundary', { next_attempt_at: NOW }));
    const due = await listDueOutboxEntries(db, NOW);
    expect(due.map((r) => r.outbox_id)).toEqual(['boundary']);
  });

  it('returns due rows in created_at ascending order', async () => {
    const db = newDb();
    await putOutboxEntry(db, entry('newer', { created_at: NOW + 200, next_attempt_at: 0 }));
    await putOutboxEntry(db, entry('older', { created_at: NOW + 100, next_attempt_at: 0 }));
    const due = await listDueOutboxEntries(db, NOW + 1000);
    expect(due.map((r) => r.outbox_id)).toEqual(['older', 'newer']);
  });
});

// ----- Case 5: updateOutboxStatus -----

describe('updateOutboxStatus', () => {
  it('patches status / attempt_count / next_attempt_at and bumps updated_at', async () => {
    const db = newDb();
    await putOutboxEntry(db, entry('a', { updated_at: NOW }));
    const after = await updateOutboxStatus(db, 'a', {
      status: 'sending',
      attempt_count: 1,
      next_attempt_at: NOW + 1_000,
      updated_at: NOW + 50,
    });
    expect(after?.status).toBe('sending');
    expect(after?.attempt_count).toBe(1);
    expect(after?.next_attempt_at).toBe(NOW + 1_000);
    expect(after?.updated_at).toBe(NOW + 50);
    // Persisted: read back from store.
    const persisted = await getOutboxEntry(db, 'a');
    expect(persisted?.status).toBe('sending');
  });

  it('auto-bumps updated_at when patch omits it', async () => {
    const db = newDb();
    await putOutboxEntry(db, entry('a', { updated_at: NOW }));
    const before = Date.now();
    const after = await updateOutboxStatus(db, 'a', { status: 'failed' });
    const upper = Date.now();
    expect(after!.updated_at).toBeGreaterThanOrEqual(before);
    expect(after!.updated_at).toBeLessThanOrEqual(upper);
  });

  it('sets last_error when supplied; clears it when null/undefined', async () => {
    const db = newDb();
    await putOutboxEntry(db, entry('a'));
    await updateOutboxStatus(db, 'a', { last_error: 'transient: timeout' });
    expect((await getOutboxEntry(db, 'a'))?.last_error).toBe('transient: timeout');
    await updateOutboxStatus(db, 'a', { last_error: null });
    expect((await getOutboxEntry(db, 'a'))?.last_error).toBeUndefined();
  });

  it('returns undefined and is a no-op when outbox_id is unknown', async () => {
    const db = newDb();
    const r = await updateOutboxStatus(db, 'nope', { status: 'failed' });
    expect(r).toBeUndefined();
    expect(await listOutboxEntries(db)).toEqual([]);
  });

  it('does not modify identity fields (outbox_id / channel_id / payload)', async () => {
    const db = newDb();
    const original = entry('a', { channel_id: '100', payload: new Uint8Array([1, 2, 3]) });
    await putOutboxEntry(db, original);
    await updateOutboxStatus(db, 'a', { status: 'sending' });
    const after = await getOutboxEntry(db, 'a');
    expect(after?.channel_id).toBe('100');
    expect(after?.outbox_id).toBe('a');
    const view = after!.payload instanceof Uint8Array
      ? after!.payload
      : new Uint8Array(after!.payload);
    expect(Array.from(view)).toEqual([1, 2, 3]);
  });
});

// ----- Case 6: deleteOutboxEntry -----

describe('deleteOutboxEntry', () => {
  it('removes the matching row', async () => {
    const db = newDb();
    await putOutboxEntry(db, entry('a'));
    await putOutboxEntry(db, entry('b'));
    await deleteOutboxEntry(db, 'a');
    expect(await getOutboxEntry(db, 'a')).toBeUndefined();
    expect(await getOutboxEntry(db, 'b')).toBeDefined();
    expect(await listOutboxEntries(db)).toHaveLength(1);
  });

  it('is a no-op when outbox_id is unknown', async () => {
    const db = newDb();
    await putOutboxEntry(db, entry('a'));
    await deleteOutboxEntry(db, 'unknown');
    expect(await listOutboxEntries(db)).toHaveLength(1);
  });
});

// ----- Case 7: schema migration coexistence -----

describe('Dexie v2 migration', () => {
  it('preserves the existing channels / messages / sync_state tables', async () => {
    const db = newDb();
    // Write into every pre-existing store and confirm round-trip.
    const channel: ChannelRecord = {
      channel_id: 'c1',
      channel_type: 1,
      title: 'test',
      latest_pts: '0',
      read_pts: '0',
      unread_count: 0,
      updated_at: NOW,
      sync_version: 1,
    };
    await upsertChannels(db, [channel]);

    const msg: MessageRecord = {
      channel_id: 'c1',
      channel_type: 1,
      server_message_id: 's-1',
      from_uid: '999',
      message_type: 'text',
      content: 'hi',
      payload: new Uint8Array(),
      timestamp: NOW,
      status: 'received',
    };
    await upsertMessages(db, [msg]);

    await upsertSyncState(db, {
      channel_id: 'c1',
      channel_type: 1,
      last_sync_at: NOW,
    });

    // And the new outbox.
    await putOutboxEntry(db, entry('o-1'));

    // All four tables independently readable.
    expect((await db.channels.toArray()).map((c) => c.channel_id)).toEqual(['c1']);
    expect((await db.messages.toArray()).map((m) => m.server_message_id)).toEqual(['s-1']);
    expect((await db.sync_state.toArray()).map((s) => s.channel_id)).toEqual(['c1']);
    expect((await db.outbox.toArray()).map((o) => o.outbox_id)).toEqual(['o-1']);
  });
});

// ----- Misc smoke -----

describe('listOutboxEntries options', () => {
  it('filters by statuses', async () => {
    const db = newDb();
    await putOutboxEntry(db, entry('p', { status: 'pending' }));
    await putOutboxEntry(db, entry('s', { status: 'sending' }));
    await putOutboxEntry(db, entry('f', { status: 'failed' }));
    const onlyFailed = await listOutboxEntries(db, { statuses: ['failed'] });
    expect(onlyFailed.map((r) => r.outbox_id)).toEqual(['f']);
    const sendingOrFailed = await listOutboxEntries(db, {
      statuses: ['sending', 'failed'],
    });
    expect(sendingOrFailed.map((r) => r.outbox_id).sort()).toEqual(['f', 's']);
  });

  it('respects limit (post-sort)', async () => {
    const db = newDb();
    await putOutboxEntry(db, entry('a', { created_at: NOW + 100 }));
    await putOutboxEntry(db, entry('b', { created_at: NOW + 200 }));
    await putOutboxEntry(db, entry('c', { created_at: NOW + 300 }));
    const top2 = await listOutboxEntries(db, { limit: 2 });
    expect(top2.map((r) => r.outbox_id)).toEqual(['a', 'b']);
  });
});
