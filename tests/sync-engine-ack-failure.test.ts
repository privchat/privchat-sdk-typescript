// A commit whose ACK rekey does not commit must not be left behind the
// sync cursor (CONVERSATION_DEPENDENCY_READINESS §3.3).
//
// `runSync` persists the page cursor immediately after `mergeCommits`
// returns. If a rekey failure were swallowed there, the cursor would move
// past a commit whose pending row is still in the database — and since the
// next sync starts from the new cursor, that commit would never be fetched
// again. The row would stay "sending" forever with no path back.
//
// The failure is injected at the module boundary rather than by planting a
// conflicting row: the pending row has to be on disk for this scenario, and
// `id` is unique account-wide, so the conflicting row cannot be seeded
// alongside it. Lives in its own file because `vi.mock` is module-scoped.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ackRekeyShouldFail = { value: false };
const messageWriteShouldFail = { value: false };

vi.mock('../src/cache/index.js', async () => {
  const actual = await vi.importActual<typeof import('../src/cache/index.js')>(
    '../src/cache/index.js',
  );
  return {
    ...actual,
    applyAckRekey: async (...args: Parameters<typeof actual.applyAckRekey>) => {
      if (ackRekeyShouldFail.value) {
        throw new Error('injected: ACK rekey transaction failed');
      }
      return actual.applyAckRekey(...args);
    },
    upsertMessages: async (...args: Parameters<typeof actual.upsertMessages>) => {
      if (messageWriteShouldFail.value) {
        throw new Error('injected: message write failed');
      }
      return actual.upsertMessages(...args);
    },
  };
});

const {
  CacheDB,
  MessageStore,
  getSyncState,
  upsertMessage,
  upsertSyncState,
} = await import('../src/cache/index.js');
const { SyncEngine } = await import('../src/sync-engine.js');
type MessageRecord = import('../src/cache/index.js').MessageRecord;
type GetDifferenceResponse = import('../src/api-types.js').GetDifferenceResponse;

const CHANNEL_ID = '100';
const CHANNEL_TYPE = 1;
const SELF_UID = 'self-1';

let db: InstanceType<typeof CacheDB>;
let store: InstanceType<typeof MessageStore>;
let engine: InstanceType<typeof SyncEngine>;
let dbCounter = 0;

/** One page carrying the server's echo of our own pending message. */
const ackPage = (): GetDifferenceResponse => ({
  commits: [
    {
      pts: '7',
      server_msg_id: '4242',
      local_message_id: '9',
      sender_id: SELF_UID,
      channel_id: CHANNEL_ID,
      channel_type: CHANNEL_TYPE,
      content: 'hello',
      message_type: '0',
      server_timestamp: 1_700_000_000_500,
    },
  ],
  current_pts: '7',
  has_more: false,
});

const pending: MessageRecord = {
  id: 'r-9',
  channel_id: CHANNEL_ID,
  channel_type: CHANNEL_TYPE,
  local_message_id: '9',
  from_uid: SELF_UID,
  message_type: 'text',
  content: 'hello',
  payload: new Uint8Array(),
  timestamp: 1_700_000_000_500,
  status: 'pending',
};

beforeEach(async () => {
  ackRekeyShouldFail.value = true;
  messageWriteShouldFail.value = false;
  db = new CacheDB(`sync-ack-fail-${++dbCounter}-${Math.random().toString(36).slice(2, 8)}`);
  store = new MessageStore();
  store.upsertChannel({
    channel_id: CHANNEL_ID,
    channel_type: CHANNEL_TYPE,
    title: 'chan',
    latest_pts: '6',
    read_pts: '6',
    unread_count: 0,
    last_message_preview: '',
    updated_at: 1_700_000_000_000,
    sync_version: 1,
  });
  store.upsertMessage(pending, false);
  await upsertMessage(db, pending);
  // Real cursor baseline — without it the "cursor unchanged" assertion
  // would compare undefined to undefined and prove nothing.
  await upsertSyncState(db, {
    channel_id: CHANNEL_ID,
    channel_type: CHANNEL_TYPE,
    latest_pts: '6',
    last_sync_at: 1_700_000_000_000,
  });

  engine = new SyncEngine({
    db,
    store,
    callDifference: async () => ackPage(),
    openConversation: async () => [],
    getCurrentUserId: () => SELF_UID,
    emit: () => {},
    warn: () => {},
  });
});

afterEach(async () => {
  ackRekeyShouldFail.value = false;
  messageWriteShouldFail.value = false;
  try {
    db.close();
  } catch {
    /* ignore */
  }
});

describe('SyncEngine — ACK rekey failure', () => {
  it('fails the sync instead of reporting success', async () => {
    await expect(engine.syncChannel(CHANNEL_ID, CHANNEL_TYPE)).rejects.toThrow(
      /injected/,
    );
  });

  it('leaves the persisted cursor untouched so the commit is re-fetched', async () => {
    const before = await getSyncState(db, CHANNEL_ID, CHANNEL_TYPE);
    expect(before?.latest_pts).toBe('6');

    await engine.syncChannel(CHANNEL_ID, CHANNEL_TYPE).catch(() => undefined);

    const after = await getSyncState(db, CHANNEL_ID, CHANNEL_TYPE);
    expect(after?.latest_pts).toBe('6');
  });

  it('leaves the pending row pending, in memory and on disk', async () => {
    await engine.syncChannel(CHANNEL_ID, CHANNEL_TYPE).catch(() => undefined);

    const buffer = store.getMessages(CHANNEL_ID, CHANNEL_TYPE);
    expect(buffer).toHaveLength(1);
    expect(buffer[0]!.status).toBe('pending');

    const persisted = await db.messages.toArray();
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.record_key).toBe('l:9');
    expect(persisted[0]!.status).toBe('pending');
    expect(persisted[0]!.id).toBe('r-9');
  });

  it('recovers on the retry once the write succeeds', async () => {
    await engine.syncChannel(CHANNEL_ID, CHANNEL_TYPE).catch(() => undefined);

    ackRekeyShouldFail.value = false;
    const res = await engine.syncChannel(CHANNEL_ID, CHANNEL_TYPE);
    expect(res.status).toBe('synced');
    // And only now does the cursor move past the commit.
    expect((await getSyncState(db, CHANNEL_ID, CHANNEL_TYPE))?.latest_pts).toBe('7');

    const persisted = await db.messages.toArray();
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.record_key).toBe('s:4242');
    // The identity survived the failed attempt AND the retry.
    expect(persisted[0]!.id).toBe('r-9');
  });
});

/**
 * Ordinary commits get the same publication barrier as ACK swaps.
 *
 * The earlier round fixed only the ACK branch; plain message rows were
 * still written with a swallowed error while the memory store had already
 * been updated, and the cursor advanced regardless. That loses ordinary
 * incoming messages exactly the same way — they are simply never fetched
 * again.
 */
describe('SyncEngine — ordinary commits are page-atomic', () => {
  const PEER = 'peer-2';

  function newEngineWithPage(page: GetDifferenceResponse) {
    return new SyncEngine({
      db,
      store,
      callDifference: async () => page,
      openConversation: async () => [],
      getCurrentUserId: () => SELF_UID,
      emit: () => {},
      warn: () => {},
    });
  }

  const foreignPage = (): GetDifferenceResponse => ({
    commits: [
      {
        pts: '7',
        server_msg_id: '5000',
        sender_id: PEER,
        channel_id: CHANNEL_ID,
        channel_type: CHANNEL_TYPE,
        content: 'from peer',
        message_type: '0',
        server_timestamp: 1_700_000_001_000,
      },
    ],
    current_pts: '7',
    has_more: false,
  });

  it('fails the sync when the message rows cannot be written', async () => {
    messageWriteShouldFail.value = true;
    const e = newEngineWithPage(foreignPage());
    await expect(e.syncChannel(CHANNEL_ID, CHANNEL_TYPE)).rejects.toThrow(/injected/);
  });

  it('does not advance the cursor past rows that never reached the database', async () => {
    messageWriteShouldFail.value = true;
    const e = newEngineWithPage(foreignPage());
    await e.syncChannel(CHANNEL_ID, CHANNEL_TYPE).catch(() => undefined);

    expect((await getSyncState(db, CHANNEL_ID, CHANNEL_TYPE))?.latest_pts).toBe('6');
  });

  it('does not publish the messages to memory either', async () => {
    messageWriteShouldFail.value = true;
    const e = newEngineWithPage(foreignPage());
    await e.syncChannel(CHANNEL_ID, CHANNEL_TYPE).catch(() => undefined);

    // Only the pre-seeded pending row; the peer message was never published.
    const buffer = store.getMessages(CHANNEL_ID, CHANNEL_TYPE);
    expect(buffer.map((m) => m.server_message_id)).toEqual([undefined]);
  });

  it('does not bump unread on a page that failed to commit', async () => {
    messageWriteShouldFail.value = true;
    const e = newEngineWithPage(foreignPage());
    await e.syncChannel(CHANNEL_ID, CHANNEL_TYPE).catch(() => undefined);

    expect(store.getChannel(CHANNEL_ID, CHANNEL_TYPE)?.unread_count).toBe(0);
  });

  it('applies everything once the write succeeds on retry', async () => {
    messageWriteShouldFail.value = true;
    const e = newEngineWithPage(foreignPage());
    await e.syncChannel(CHANNEL_ID, CHANNEL_TYPE).catch(() => undefined);

    messageWriteShouldFail.value = false;
    const res = await e.syncChannel(CHANNEL_ID, CHANNEL_TYPE);

    expect(res.status).toBe('synced');
    expect((await getSyncState(db, CHANNEL_ID, CHANNEL_TYPE))?.latest_pts).toBe('7');
    expect(store.getChannel(CHANNEL_ID, CHANNEL_TYPE)?.unread_count).toBe(1);
    const rows = await db.messages.toArray();
    expect(rows.map((r) => r.record_key).sort()).toEqual(['l:9', 's:5000']);
  });
});
