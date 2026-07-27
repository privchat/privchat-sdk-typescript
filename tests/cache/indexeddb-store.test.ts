import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CacheDB,
  applyAck,
  clearAll,
  deleteMessageById,
  deleteMessageByServerId,
  ensureCacheOwner,
  getCacheOwner,
  getChannel,
  getMessageWindow,
  getMessagesBefore,
  getSyncState,
  listChannels,
  upsertChannels,
  upsertMessage,
  upsertMessages,
  upsertSyncState,
} from '../../src/cache/indexeddb-store.js';
import {
  nextLocalMessageRecordId,
  type ChannelRecord,
  type MessageRecord,
} from '../../src/cache/types.js';

const sampleChannel = (overrides: Partial<ChannelRecord> = {}): ChannelRecord => ({
  channel_id: '12345',
  channel_type: 1,
  title: 'Alice',
  latest_pts: '100',
  read_pts: '50',
  unread_count: 50,
  last_message_preview: 'hi',
  updated_at: 1_000,
  sync_version: 1,
  ...overrides,
});

/** Build a received MessageRecord. The numeric `id` drives both the
 *  server_message_id (identity) and the timestamp (ordering), keeping
 *  test assertions intuitive. */
const sampleMessage = (
  id: string,
  overrides: Partial<MessageRecord> = {},
): MessageRecord => ({
  // 本地稳定行身份（§3.3）：account 内全局唯一，所以按真实生成器铸，
  // 不能按入参派生 —— 不同频道的同名样本会撞唯一索引。
  id: nextLocalMessageRecordId(),
  channel_id: '12345',
  channel_type: 1,
  server_message_id: `s-${id}`,
  from_uid: '999',
  message_type: 'text',
  content: `body ${id}`,
  payload: new Uint8Array(),
  timestamp: Number(id) * 1000,
  status: 'received',
  revoked: false,
  ...overrides,
});

let db: CacheDB;
let dbCounter = 0;

beforeEach(() => {
  // Fresh DB per test so state doesn't leak.
  db = new CacheDB(`privchat-test-${++dbCounter}`);
});

afterEach(async () => {
  db.close();
});

describe('channels table', () => {
  it('upsert + get by compound primary key', async () => {
    const ch = sampleChannel();
    await upsertChannels(db, [ch]);
    expect(await getChannel(db, '12345', 1)).toEqual(ch);
  });

  it('same channel_id with different channel_type collapses to one row (channel_id is the identity)', async () => {
    // Per the cache identity model: the gateway is authoritative, channel_id
    // is the conversation key. If two records arrive for the same channel_id
    // with different channel_type, the LATER one wins — the local store
    // refuses to host two parallel "conversations" under one channel_id.
    await upsertChannels(db, [
      sampleChannel({ channel_id: '100', channel_type: 1, title: 'first' }),
      sampleChannel({ channel_id: '100', channel_type: 2, title: 'second' }),
    ]);
    const list = await listChannels(db);
    const matching = list.filter((c) => c.channel_id === '100');
    expect(matching).toHaveLength(1);
    expect(matching[0]?.title).toBe('second');
    expect(matching[0]?.channel_type).toBe(2);
  });

  it('upsert overwrites existing row', async () => {
    await upsertChannels(db, [sampleChannel({ unread_count: 5 })]);
    await upsertChannels(db, [sampleChannel({ unread_count: 0 })]);
    expect((await getChannel(db, '12345', 1))?.unread_count).toBe(0);
  });

  it('listChannels orders by updated_at desc (most recent first)', async () => {
    await upsertChannels(db, [
      sampleChannel({ channel_id: 'a', updated_at: 100 }),
      sampleChannel({ channel_id: 'b', updated_at: 300 }),
      sampleChannel({ channel_id: 'c', updated_at: 200 }),
    ]);
    const list = await listChannels(db);
    expect(list.map((c) => c.channel_id)).toEqual(['b', 'c', 'a']);
  });
});

describe('messages table', () => {
  it('upsert + getMessageWindow returns ascending by timestamp', async () => {
    await upsertMessages(db, [
      sampleMessage('5'),
      sampleMessage('1'),
      sampleMessage('3'),
    ]);
    const window = await getMessageWindow(db, '12345', 1, 10);
    expect(window.map((m) => m.server_message_id)).toEqual(['s-1', 's-3', 's-5']);
  });

  it('getMessageWindow respects limit and returns the latest N', async () => {
    await upsertMessages(db, ['1', '2', '3', '4', '5'].map((s) => sampleMessage(s)));
    const window = await getMessageWindow(db, '12345', 1, 3);
    expect(window.map((m) => m.server_message_id)).toEqual(['s-3', 's-4', 's-5']);
  });

  it('getMessagesBefore paginates older-than-cursor in display order', async () => {
    const rows = await upsertMessages(
      db,
      ['1', '2', '3', '4', '5'].map((s) => sampleMessage(s)),
    );
    // Keyset cursor is the record itself, walked in the same order the list
    // renders in — a timestamp cursor would page a different sequence than
    // the one on screen.
    const older = await getMessagesBefore(db, '12345', 1, rows[3]!, 10);
    expect(older.map((m) => m.server_message_id)).toEqual(['s-1', 's-2', 's-3']);
  });

  it('upsert by server_message_id replaces the row', async () => {
    await upsertMessages(db, [sampleMessage('5', { content: 'first' })]);
    await upsertMessages(db, [sampleMessage('5', { content: 'updated' })]);
    const win = await getMessageWindow(db, '12345', 1, 10);
    expect(win).toHaveLength(1);
    expect(win[0]!.content).toBe('updated');
  });

  it('deleteMessageByServerId removes by server_message_id', async () => {
    await upsertMessages(db, [sampleMessage('5'), sampleMessage('6')]);
    await deleteMessageByServerId(db, '12345', 1, 's-5');
    const win = await getMessageWindow(db, '12345', 1, 10);
    expect(win.map((m) => m.server_message_id)).toEqual(['s-6']);
  });

  it('deleteMessageById removes pending row by its local key', async () => {
    const pending: MessageRecord = {
      id: 'r-local-1',
      channel_id: '12345',
      channel_type: 1,
      local_message_id: 'local-1',
      from_uid: '999',
      message_type: 'text',
      content: 'pending',
      payload: new Uint8Array(),
      timestamp: 999,
      status: 'pending',
    };
    await upsertMessage(db, pending);
    expect(await getMessageWindow(db, '12345', 1, 10)).toHaveLength(1);
    await deleteMessageById(db, (await getMessageWindow(db, '12345', 1, 10))[0]!.id);
    expect(await getMessageWindow(db, '12345', 1, 10)).toEqual([]);
  });

  // SDK_ENTITY_MODEL_SPEC §2.6.1: `id` is the identity pending dependencies
  // and projections are keyed by, and the ACK must not move it. It used to
  // share that job with a key that flipped `l:` → `s:` on ACK; the store now
  // updates the row in place.
  describe('stable local id', () => {
    const pending: MessageRecord = {
      id: 'r-local-1',
      channel_id: '12345',
      channel_type: 1,
      local_message_id: 'local-1',
      from_uid: '999',
      message_type: 'text',
      content: 'hi',
      payload: new Uint8Array(),
      timestamp: 999,
      status: 'pending',
    };

    /** What the ACK path builds: a fresh record for the same message,
     *  carrying a newly minted id because the caller rebuilt it. The store
     *  must ignore that id and keep the pending row's. */
    const ackedFor = (serverId: string): MessageRecord => ({
      ...pending,
      id: nextLocalMessageRecordId(),
      server_message_id: serverId,
      status: 'sent',
    });

    it('keeps the stable id through the ACK even when the caller re-mints it', async () => {
      await upsertMessage(db, pending);
      const stored = await applyAck(db, ackedFor('srv-1'));

      const win = await getMessageWindow(db, '12345', 1, 10);
      expect(win).toHaveLength(1);
      expect(win[0]!.server_message_id).toBe('srv-1');
      expect(win[0]!.id).toBe('r-local-1');
      // The returned row is what callers publish — it must match disk.
      expect(stored.id).toBe('r-local-1');
    });

    it('is not re-minted when the same message is cached again', async () => {
      // A re-opened conversation re-fetches history and rebuilds records,
      // minting a fresh id each time. The stored identity must win, or the
      // row either duplicates or fails its unique index.
      const first: MessageRecord = { ...pending, server_message_id: 'srv-2', id: 'r-first' };
      await upsertMessages(db, [first]);
      await upsertMessages(db, [{ ...first, id: 'r-second-mint', content: 'edited' }]);

      const win = await getMessageWindow(db, '12345', 1, 10);
      expect(win).toHaveLength(1);
      expect(win[0]!.id).toBe('r-first');
      expect(win[0]!.content).toBe('edited');
    });

    it('pending identity wins when the self-push beat the ACK', async () => {
      // The server echoes our own message back before the ACK for it
      // returns. That push row is keyed `s:srv-3` with an id of its own,
      // while the UI has been showing the pending row since send. If the
      // push id won, every dependency recorded against the pending row
      // would dangle.
      await upsertMessage(db, pending);
      await upsertMessage(db, {
        ...pending,
        id: 'r-from-push',
        local_message_id: undefined,
        server_message_id: 'srv-3',
        status: 'received',
      });
      expect(await getMessageWindow(db, '12345', 1, 10)).toHaveLength(2);

      await applyAck(db, ackedFor('srv-3'));

      const win = await getMessageWindow(db, '12345', 1, 10);
      expect(win).toHaveLength(1);
      expect(win[0]!.id).toBe('r-local-1');
      expect(win[0]!.status).toBe('sent');
    });

    it('leaves one row when the ACK lands before the self-push', async () => {
      await upsertMessage(db, pending);
      await applyAck(db, ackedFor('srv-4'));
      // Push arrives afterwards for the same server id: a plain upsert on
      // an existing key, so it must merge, not duplicate or re-mint.
      await upsertMessage(db, {
        ...pending,
        id: 'r-late-push',
        local_message_id: undefined,
        server_message_id: 'srv-4',
        status: 'received',
      });

      const win = await getMessageWindow(db, '12345', 1, 10);
      expect(win).toHaveLength(1);
      expect(win[0]!.id).toBe('r-local-1');
    });

    it('is idempotent: replaying an ACK does not duplicate or re-order', async () => {
      // The engine replays a stored ACK on every repair pass, so this runs
      // more than once for the same message by design.
      await upsertMessage(db, pending);
      const first = await applyAck(db, ackedFor('srv-5'));
      await applyAck(db, ackedFor('srv-5'));
      const afterRetry = await getMessageWindow(db, '12345', 1, 10);
      expect(afterRetry).toHaveLength(1);
      expect(afterRetry[0]!.id).toBe('r-local-1');
      expect(afterRetry[0]!.status).toBe('sent');
      // Position in the timeline is not disturbed by the replay.
      expect(afterRetry[0]!.local_order_seq).toBe(first.local_order_seq);
    });

    it('rejects the same id in a different channel (account-global)', async () => {
      // `pending_dependency` names a consumer by a bare `message.id`, with
      // no channel beside it. An id unique only within its channel would
      // resolve to two rows.
      await upsertMessage(db, pending);
      await expect(
        upsertMessage(db, { ...pending, channel_id: 'other-channel' }),
      ).rejects.toThrow();
    });
  });

  it('messages from different (channel, type) are isolated', async () => {
    // Distinct server ids: one network identity names one message, and
    // reusing 's-1' across channels is the conflict case, tested separately.
    // What is under test here is channel isolation.
    await upsertMessages(db, [
      sampleMessage('1', { channel_id: 'a' }),
      sampleMessage('2', { channel_id: 'b' }),
    ]);
    expect(await getMessageWindow(db, 'a', 1, 10)).toHaveLength(1);
    expect(await getMessageWindow(db, 'b', 1, 10)).toHaveLength(1);
  });
});

describe('sync_state table', () => {
  it('upsert + get by compound key', async () => {
    await upsertSyncState(db, {
      channel_id: '12345',
      channel_type: 1,
      min_loaded_at: 1_000,
      max_loaded_at: 5_000,
      last_sync_at: 1_700,
    });
    const got = await getSyncState(db, '12345', 1);
    expect(got).toMatchObject({ min_loaded_at: 1_000, max_loaded_at: 5_000 });
  });

  it('returns undefined for missing key', async () => {
    expect(await getSyncState(db, 'nope', 1)).toBeUndefined();
  });
});

describe('clearAll', () => {
  it('wipes channels + messages + sync_state in a single transaction', async () => {
    await upsertChannels(db, [sampleChannel()]);
    await upsertMessages(db, [sampleMessage('1')]);
    await upsertSyncState(db, {
      channel_id: '12345',
      channel_type: 1,
      last_sync_at: 1,
    });

    await clearAll(db);

    expect(await listChannels(db)).toEqual([]);
    expect(await getMessageWindow(db, '12345', 1, 10)).toEqual([]);
    expect(await getSyncState(db, '12345', 1)).toBeUndefined();
  });
});

describe('cache account ownership', () => {
  it('clears an unowned legacy cache before binding it', async () => {
    await upsertChannels(db, [sampleChannel({ channel_id: 'foreign-31' })]);

    await expect(ensureCacheOwner(db, '100000028')).resolves.toBe(true);

    expect(await getCacheOwner(db)).toBe('100000028');
    expect(await listChannels(db)).toEqual([]);
  });

  it('preserves rows for the same owner and clears them on owner mismatch', async () => {
    await ensureCacheOwner(db, '100000031');
    await upsertChannels(db, [sampleChannel({ channel_id: 'owned-by-31' })]);

    await expect(ensureCacheOwner(db, '100000031')).resolves.toBe(false);
    expect(await listChannels(db)).toHaveLength(1);

    await expect(ensureCacheOwner(db, '100000028')).resolves.toBe(true);
    expect(await getCacheOwner(db)).toBe('100000028');
    expect(await listChannels(db)).toEqual([]);
  });
});
