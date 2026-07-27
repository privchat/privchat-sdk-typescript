// Display ordering, and the Rust/TS agreement on it.
//
// The tuple is (pending_group, pts, server_message_id, local_order_seq) and
// `timestamp` decides nothing. The cases below are the ones that actually
// broke things: out-of-order arrival, identical timestamps, and a sender
// whose clock runs backwards. Sorting by wall clock gets each of them wrong,
// and gets them wrong differently on each client — which is how one
// conversation ends up rendering in two orders.

import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CacheDB,
  getMessageWindow,
  upsertMessages,
} from '../../src/cache/indexeddb-store.js';
import { MessageStore } from '../../src/cache/message-store.js';
import { compareDisplayOrder, encodeSortKey } from '../../src/cache/types.js';
import type { MessageRecord } from '../../src/cache/types.js';

let db: CacheDB | undefined;
let counter = 0;
afterEach(() => {
  db?.close();
  db = undefined;
});

function msg(over: Partial<MessageRecord> & { id: string }): MessageRecord {
  return {
    channel_id: 'c1',
    channel_type: 1,
    from_uid: '9',
    message_type: 'text',
    content: over.id,
    payload: new Uint8Array(),
    timestamp: 1_000,
    status: 'received',
    ...over,
  };
}

/**
 * The shared fixture — the same JSON the Rust SDK's parity test reads
 * (privchat-docs/fixtures/display-order.json). Loaded rather than duplicated:
 * two copies of "the expected order" are two things that can drift, and the
 * whole point of the case is that both SDKs produce one ordering.
 *
 * It is deliberately adversarial: rows arrive 30, 10, 20; `t-same-a` and
 * `t-same-b` share a timestamp; `t-backwards` has the highest pts and a
 * timestamp far in the past (a sender whose clock is wrong); and one pending
 * row has no pts at all.
 *
 * Rust orders it by `(pending_group, pts, server_message_id, message.id)`
 * where its id is a monotonic rowid; TypeScript substitutes `local_order_seq`
 * for that last element, which is why the two agree.
 */
interface Fixture {
  channel_id: number;
  channel_type: number;
  from_uid: number;
  confirmed: Array<{
    label: string;
    server_message_id: number;
    pts: number;
    timestamp: number;
  }>;
  pending: Array<{ label: string; local_message_id: number; timestamp: number }>;
  expected_order: string[];
}

const FIXTURE = JSON.parse(
  readFileSync(
    new URL('../../../privchat-docs/fixtures/display-order.json', import.meta.url),
    'utf8',
  ),
) as Fixture;

const SHUFFLED: MessageRecord[] = [
  ...FIXTURE.confirmed.map((r) =>
    msg({
      id: r.label,
      server_message_id: String(r.server_message_id),
      pts: String(r.pts),
      timestamp: r.timestamp,
    }),
  ),
  ...FIXTURE.pending.map((r) =>
    msg({
      id: r.label,
      local_message_id: String(r.local_message_id),
      status: 'pending',
      timestamp: r.timestamp,
    }),
  ),
];

const EXPECTED = FIXTURE.expected_order;

describe('display order', () => {
  it('persists and reads back in tuple order, whatever the arrival order', async () => {
    db = new CacheDB(`order-${++counter}-${Date.now()}`);
    await upsertMessages(db, SHUFFLED);
    const rows = await getMessageWindow(db, 'c1', 1, 20);
    expect(rows.map((r) => r.id)).toEqual(EXPECTED);
  });

  it('the in-memory comparator agrees with the persisted index', async () => {
    db = new CacheDB(`order-mem-${++counter}-${Date.now()}`);
    // Take the rows as stored, so both sides compare the same
    // `local_order_seq` — that is what makes the two orderings one ordering.
    const stored = await upsertMessages(db, SHUFFLED);
    const store = new MessageStore();
    store.upsertMessages('c1', 1, stored, true);
    expect(store.getMessages('c1', 1).map((r) => r.id)).toEqual(EXPECTED);
  });

  it('ignores timestamp entirely, including a sender whose clock ran backwards', async () => {
    db = new CacheDB(`order-clock-${++counter}-${Date.now()}`);
    await upsertMessages(db, SHUFFLED);
    const rows = await getMessageWindow(db, 'c1', 1, 20);
    const byTimestamp = [...SHUFFLED]
      .sort((a, b) => a.timestamp - b.timestamp)
      .map((r) => r.id);
    // If these ever coincide the test has stopped proving anything.
    expect(byTimestamp).not.toEqual(EXPECTED);
    expect(rows.map((r) => r.id)).toEqual(EXPECTED);
  });

  it('compares numerically, not lexicographically', () => {
    // IndexedDB compares compound index members as strings, so "10" would
    // sort before "2" without the fixed-width encoding.
    expect(encodeSortKey('2') < encodeSortKey('10')).toBe(true);
    expect('2' < '10').toBe(false);

    const two = msg({ id: 'a', server_message_id: '2', pts: '2' });
    const ten = msg({ id: 'b', server_message_id: '10', pts: '10' });
    expect(compareDisplayOrder(two, ten)).toBeLessThan(0);
  });

  it('keeps consecutive pending sends in send order', async () => {
    // Rust gets this from a monotonic rowid. This SDK's `id` is 128 random
    // bits, so without `local_order_seq` these would come out shuffled — the
    // reason the contract names a separate ordering field.
    db = new CacheDB(`order-pending-${++counter}-${Date.now()}`);
    const sends = ['first', 'second', 'third'].map((n) =>
      msg({ id: `p-${n}`, local_message_id: n, status: 'pending', timestamp: 1_000 }),
    );
    for (const s of sends) await upsertMessages(db, [s]);
    const rows = await getMessageWindow(db, 'c1', 1, 20);
    expect(rows.map((r) => r.local_message_id)).toEqual(['first', 'second', 'third']);
  });
});
