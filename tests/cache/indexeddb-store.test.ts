import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CacheDB,
  clearAll,
  deleteMessageByRecordKey,
  deleteMessageByServerId,
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
import type { ChannelRecord, MessageRecord } from '../../src/cache/types.js';

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

  it('getMessagesBefore paginates older-than-cursor by timestamp', async () => {
    await upsertMessages(db, ['1', '2', '3', '4', '5'].map((s) => sampleMessage(s)));
    // Before timestamp 4000 (= id 4) → returns ids 1, 2, 3
    const older = await getMessagesBefore(db, '12345', 1, 4_000, 10);
    expect(older.map((m) => m.server_message_id)).toEqual(['s-1', 's-2', 's-3']);
  });

  it('upsert by record_key (derived from server_message_id) replaces row', async () => {
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

  it('deleteMessageByRecordKey removes pending row by its local key', async () => {
    const pending: MessageRecord = {
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
    await deleteMessageByRecordKey(db, '12345', 1, 'l:local-1');
    expect(await getMessageWindow(db, '12345', 1, 10)).toEqual([]);
  });

  it('messages from different (channel, type) are isolated', async () => {
    await upsertMessages(db, [
      sampleMessage('1', { channel_id: 'a' }),
      sampleMessage('1', { channel_id: 'b' }),
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
