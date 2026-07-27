// v12: the message store's primary key becomes the stable `id`.
//
// Dexie cannot change a primary key in place, so this creates `messages_v2`
// and moves rows across inside the upgrade transaction, together with the
// outbox references pointing at them. Testing it means opening a real v11
// database at v13 — asserting on freshly written rows would say nothing about
// whether the upgrade ran, and every existing installation goes through this
// exactly once.

import Dexie from 'dexie';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CacheDB,
  ServerMessageIdConflictError,
  getChannelOrderMode,
  getMessageWindow,
  upsertMessages,
} from '../../src/cache/indexeddb-store.js';
import { MessageStore } from '../../src/cache/message-store.js';
import { getOutboxEntry } from '../../src/cache/outbox-store.js';

let db: CacheDB | undefined;
afterEach(() => {
  db?.close();
});

const V11_STORES = {
  channels: '&channel_id, channel_type, updated_at',
  messages:
    '&[channel_id+record_key], &id, [channel_id+timestamp], [channel_id+server_message_id]',
  sync_state: '&channel_id',
  outbox:
    '&outbox_id, channel_id, [channel_id+created_at], status, next_attempt_at, &local_message_id, message_id',
  users: '&user_id, sync_version',
  groups: '&group_id, sync_version',
  friendships: '&user_id, sync_version',
  cache_metadata: '&key',
};

function legacyMessage(over: Record<string, unknown>): Record<string, unknown> {
  return {
    channel_id: 'c1',
    channel_type: 1,
    from_uid: '9',
    message_type: 'text',
    content: 'x',
    payload: new Uint8Array(),
    timestamp: 1_000,
    status: 'received',
    ...over,
  };
}

describe('v12 messages_v2 migration', () => {
  it('carries every row across, keyed by its stable id', async () => {
    const name = `mig12-${Date.now()}-${Math.random()}`;
    const legacy = new Dexie(name);
    legacy.version(11).stores(V11_STORES);
    await legacy.open();
    await legacy.table('messages').bulkPut([
      legacyMessage({
        id: 'keep-1',
        record_key: 's:100',
        server_message_id: '100',
        pts: '10',
      }),
      legacyMessage({
        id: 'keep-2',
        record_key: 's:200',
        server_message_id: '200',
        pts: '20',
      }),
      legacyMessage({
        id: 'keep-pending',
        record_key: 'l:cmd-1',
        local_message_id: 'cmd-1',
        status: 'pending',
      }),
    ]);
    legacy.close();

    db = new CacheDB(name);
    const rows = await getMessageWindow(db, 'c1', 1, 10);

    expect(rows.map((r) => r.id)).toEqual(['keep-1', 'keep-2', 'keep-pending']);
    // Ordering came out of the migration, not out of insertion order:
    // confirmed by pts, pending last.
    expect(rows.map((r) => r.local_order_seq)).toEqual([1, 2, 3]);
  });

  // The degraded-order rule (SDK_ENTITY_MODEL_SPEC §2.6.2): while ANY
  // confirmed row in a channel still lacks pts, that channel is ordered by
  // server_message_id alone. A missing pts encodes as zeros, so keeping pts
  // order would sort the pts-less row ahead of the whole conversation —
  // which is the inversion the rule exists to prevent.
  it('orders a channel by server_message_id while any confirmed row lacks pts', async () => {
    const name = `mig12b-${Date.now()}-${Math.random()}`;
    const legacy = new Dexie(name);
    legacy.version(11).stores(V11_STORES);
    await legacy.open();
    await legacy.table('messages').bulkPut([
      legacyMessage({
        id: 'older-with-pts',
        record_key: 's:100',
        server_message_id: '100',
        pts: '10',
      }),
      // Fetched through message/history, which carries no pts.
      legacyMessage({
        id: 'newer-without-pts',
        record_key: 's:300',
        server_message_id: '300',
      }),
    ]);
    legacy.close();

    db = new CacheDB(name);
    const rows = await getMessageWindow(db, 'c1', 1, 10);
    expect(rows.map((r) => r.id)).toEqual(['older-with-pts', 'newer-without-pts']);
    expect(await getChannelOrderMode(db, 'c1')).toBe('server_id');

    // And the in-memory comparator sorts it the same way — one ordering, not
    // two. Told the mode the rows were keyed under, as the client does.
    const store = new MessageStore();
    store.setChannelOrderMode('c1', await getChannelOrderMode(db, 'c1'));
    store.upsertMessages('c1', 1, rows, true);
    expect(store.getMessages('c1', 1).map((r) => r.id)).toEqual([
      'older-with-pts',
      'newer-without-pts',
    ]);
  });

  it('returns to pts order once sync fills the missing pts in', async () => {
    // The flag is not a one-way door: server_message_id only approximates the
    // channel order, so the moment pts is complete the authoritative order
    // has to come back — and every persisted key with it, or the two
    // disagree.
    const name = `mig12b2-${Date.now()}-${Math.random()}`;
    const legacy = new Dexie(name);
    legacy.version(11).stores(V11_STORES);
    await legacy.open();
    await legacy.table('messages').bulkPut([
      legacyMessage({ id: 'a', record_key: 's:100', server_message_id: '100', pts: '10' }),
      legacyMessage({ id: 'b', record_key: 's:300', server_message_id: '300' }),
    ]);
    legacy.close();

    db = new CacheDB(name);
    expect(await getChannelOrderMode(db, 'c1')).toBe('server_id');

    // Sync delivers the pts for the row that was missing one.
    const [gap] = (await getMessageWindow(db, 'c1', 1, 10)).filter((r) => r.id === 'b');
    await upsertMessages(db, [{ ...gap!, pts: '30' }]);

    expect(await getChannelOrderMode(db, 'c1')).toBe('pts');
    expect((await getMessageWindow(db, 'c1', 1, 10)).map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('keeps one network identity in one channel, quarantining the intruder', async () => {
    // server_message_id is globally unique: the same id in two channels is
    // corruption, and merging it would put someone's message in a
    // conversation it was never sent to. The loser is preserved rather than
    // deleted — it is user data, and the only evidence of the bug.
    const name = `mig12e-${Date.now()}-${Math.random()}`;
    const legacy = new Dexie(name);
    legacy.version(11).stores(V11_STORES);
    await legacy.open();
    await legacy.table('messages').bulkPut([
      legacyMessage({ id: 'right', record_key: 's:777', server_message_id: '777', pts: '1' }),
      legacyMessage({
        id: 'intruder',
        channel_id: 'c2',
        record_key: 's:777',
        server_message_id: '777',
        pts: '1',
      }),
    ]);
    legacy.close();

    db = new CacheDB(name);
    // The upgrade completed at all — a ConstraintError inside it would abort
    // the whole thing and leave the database unopenable.
    expect((await getMessageWindow(db, 'c1', 1, 10)).map((r) => r.id)).toEqual(['right']);
    expect(await getMessageWindow(db, 'c2', 1, 10)).toEqual([]);
    const held = await db.quarantine.toArray();
    expect(held.map((r) => r.id)).toEqual(['intruder']);

    // And the live path refuses the same thing rather than corrupting.
    await expect(
      upsertMessages(db, [
        {
          id: 'later',
          channel_id: 'c3',
          channel_type: 1,
          server_message_id: '777',
          from_uid: '9',
          message_type: 'text',
          content: 'x',
          payload: new Uint8Array(),
          timestamp: 1,
          status: 'received',
        },
      ]),
    ).rejects.toThrow(ServerMessageIdConflictError);
  });

  it('collapses a duplicated row within one channel, keeping the more complete one', async () => {
    const name = `mig12f-${Date.now()}-${Math.random()}`;
    const legacy = new Dexie(name);
    legacy.version(11).stores(V11_STORES);
    await legacy.open();
    await legacy.table('messages').bulkPut([
      // Written twice for one message: a network copy, and our own row that
      // the outbox and the UI point at.
      legacyMessage({ id: 'network-copy', record_key: 's:888', server_message_id: '888' }),
      legacyMessage({
        id: 'ours',
        record_key: 'l:cmd-dup',
        server_message_id: '888',
        local_message_id: 'cmd-dup',
        pts: '5',
      }),
    ]);
    legacy.close();

    db = new CacheDB(name);
    const rows = await getMessageWindow(db, 'c1', 1, 10);
    expect(rows.map((r) => r.id)).toEqual(['ours']);
    expect(await db.quarantine.count()).toBe(0);
  });

  it('moves outbox references across in the same upgrade', async () => {
    const name = `mig12c-${Date.now()}-${Math.random()}`;
    const legacy = new Dexie(name);
    legacy.version(11).stores(V11_STORES);
    await legacy.open();
    await legacy.table('messages').put(
      legacyMessage({
        id: 'msg-for-cmd',
        record_key: 'l:cmd-1',
        local_message_id: 'cmd-1',
        status: 'pending',
      }),
    );
    // A pre-v11 command: no message_id, only the old record_key.
    await legacy.table('outbox').put({
      outbox_id: 'cmd-1',
      record_key: 'l:cmd-1',
      channel_id: 'c1',
      channel_type: 1,
      local_message_id: 'cmd-1',
      from_uid: '9',
      content_type: 'text',
      payload: new Uint8Array(),
      created_at: 1_000,
      updated_at: 1_000,
      attempt_count: 0,
      next_attempt_at: 0,
      status: 'pending',
    });
    legacy.close();

    db = new CacheDB(name);
    // Migrating messages first and outbox later would leave a window where a
    // crash strands the command pointing at a table that no longer exists.
    expect((await getOutboxEntry(db, 'cmd-1'))?.message_id).toBe('msg-for-cmd');
  });

  it('rebuilds a text command whose message row is gone, and routes media to repair', async () => {
    // No outbox row may come out of the upgrade unlinked. An unlinked command
    // is not a neutral state: `resolvePending` treats it as damaged data on
    // every flush, forever, and the user watches a send that neither
    // completes nor fails. Text carries its whole body in the payload, so the
    // row is rebuilt exactly; media depends on a local file and on metadata
    // the command never held, so it is marked as broken local data — a state
    // the host can act on.
    const name = `mig12g-${Date.now()}-${Math.random()}`;
    const legacy = new Dexie(name);
    legacy.version(11).stores(V11_STORES);
    await legacy.open();
    const orphan = (outbox_id: string, content_type: string, extra = {}) => ({
      outbox_id,
      channel_id: 'c1',
      channel_type: 1,
      local_message_id: outbox_id,
      from_uid: '9',
      content_type,
      payload: new Uint8Array(),
      created_at: 1_000,
      updated_at: 1_000,
      attempt_count: 0,
      next_attempt_at: 0,
      status: 'pending',
      ...extra,
    });
    await legacy.table('outbox').bulkPut([
      orphan('cmd-text', 'text', {
        payload: new TextEncoder().encode('rebuild me'),
        payload_encoding: 'raw_utf8',
      }),
      orphan('cmd-image', 'image', { payload_encoding: 'message_envelope' }),
    ]);
    legacy.close();

    db = new CacheDB(name);
    const text = await getOutboxEntry(db, 'cmd-text');
    expect(text?.message_id).toBeDefined();
    const rebuilt = await db.messages_v2.get(text!.message_id!);
    expect(rebuilt?.content).toBe('rebuild me');
    expect(rebuilt?.status).toBe('pending');
    // The rebuilt row is in the timeline, not floating unreachable.
    expect((await getMessageWindow(db, 'c1', 1, 10)).map((r) => r.id)).toEqual([rebuilt!.id]);

    const image = await getOutboxEntry(db, 'cmd-image');
    expect(image?.message_id).toBeUndefined();
    expect(image?.status).toBe('local_data_error');
    expect(image?.last_error).toContain('image');
  });

  it('leaves each account database numbering independently', async () => {
    // local_order_seq is account-global, and each account has its own
    // database — two accounts must not be able to see or disturb each
    // other's counter.
    const mk = async (name: string, id: string): Promise<CacheDB> => {
      const legacy = new Dexie(name);
      legacy.version(11).stores(V11_STORES);
      await legacy.open();
      await legacy.table('messages').put(
        legacyMessage({ id, record_key: `s:${id}`, server_message_id: id, pts: '1' }),
      );
      legacy.close();
      return new CacheDB(name);
    };

    const a = await mk(`mig12d-a-${Date.now()}-${Math.random()}`, 'acct-a-1');
    const b = await mk(`mig12d-b-${Date.now()}-${Math.random()}`, 'acct-b-1');
    try {
      expect((await getMessageWindow(a, 'c1', 1, 10))[0]!.local_order_seq).toBe(1);
      expect((await getMessageWindow(b, 'c1', 1, 10))[0]!.local_order_seq).toBe(1);
    } finally {
      a.close();
      b.close();
    }
  });
});
