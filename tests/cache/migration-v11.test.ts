import Dexie from 'dexie';
import { CacheDB } from '../../src/cache-idb.js';
import { afterEach, describe, expect, it } from 'vitest';
import { getOutboxEntry } from '../../src/cache/outbox-store.js';

/**
 * v11 backfill: give every existing outbox command the stable
 * `MessageRecord.id` of the message it delivers (SDK_ENTITY_MODEL_SPEC
 * §2.6.1).
 *
 * This has to be tested against a real v10 database that is then opened at
 * v11. Asserting on freshly written rows proves nothing about the upgrade —
 * new rows carry `message_id` because the write path sets it, so a migration
 * that silently does nothing still looks green. Every existing installation
 * goes through this path exactly once, and if it no-ops those users are left
 * on the `record_key` fallback forever.
 */
describe('v11 outbox message_id migration', () => {
  let db: CacheDB | undefined;

  afterEach(() => {
    db?.close();
  });

  const V10_STORES = {
    channels: '&channel_id, channel_type, updated_at',
    messages:
      '&[channel_id+record_key], &id, [channel_id+timestamp], [channel_id+server_message_id]',
    sync_state: '&channel_id',
    outbox:
      '&outbox_id, channel_id, [channel_id+created_at], status, next_attempt_at, &local_message_id',
    users: '&user_id, sync_version',
    groups: '&group_id, sync_version',
    friendships: '&user_id, sync_version',
    cache_metadata: '&key',
  };

  function legacyOutboxRow(outbox_id: string, record_key: string) {
    return {
      outbox_id,
      record_key,
      channel_id: 'c1',
      channel_type: 1,
      local_message_id: outbox_id,
      from_uid: '9',
      content_type: 'text',
      payload: new Uint8Array(),
      created_at: 1_000,
      updated_at: 1_000,
      attempt_count: 0,
      next_attempt_at: 0,
      status: 'pending',
    };
  }

  it('links each command to the stable id of the message it delivers', async () => {
    const name = `privchat-mig11-${Date.now()}-${Math.random()}`;

    const legacy = new Dexie(name);
    legacy.version(10).stores(V10_STORES);
    await legacy.open();
    await legacy.table('messages').bulkPut([
      {
        id: 'stable-pending',
        record_key: 'l:cmd-1',
        channel_id: 'c1',
        channel_type: 1,
        local_message_id: 'cmd-1',
        from_uid: '9',
        message_type: 'text',
        content: 'still sending',
        payload: new Uint8Array(),
        timestamp: 1_000,
        status: 'pending',
      },
      // The case the whole change exists for: the row was already rekeyed
      // from `l:` to `s:` by an earlier ack, so the key its command still
      // holds points at nothing.
      {
        id: 'stable-rekeyed',
        record_key: 's:srv-2',
        channel_id: 'c1',
        channel_type: 1,
        local_message_id: 'cmd-2',
        server_message_id: 'srv-2',
        from_uid: '9',
        message_type: 'text',
        content: 'already acked once',
        payload: new Uint8Array(),
        timestamp: 2_000,
        status: 'sent',
      },
    ]);
    await legacy.table('outbox').bulkPut([
      legacyOutboxRow('cmd-1', 'l:cmd-1'),
      legacyOutboxRow('cmd-2', 'l:cmd-2'),
      // Command whose message is gone. Its payload is text, so the row is
      // rebuilt from it rather than left orphaned — see below.
      legacyOutboxRow('cmd-3', 'l:cmd-3'),
    ]);
    legacy.close();

    db = new CacheDB(name);
    const one = await getOutboxEntry(db, 'cmd-1');
    const two = await getOutboxEntry(db, 'cmd-2');
    const three = await getOutboxEntry(db, 'cmd-3');

    expect(one?.message_id).toBe('stable-pending');
    // Backfilled via local_message_id, because record_key has already moved.
    expect(two?.message_id).toBe('stable-rekeyed');
    // v12 rebuilds it: an unlinked command is not a neutral state — every
    // flush would treat it as damaged data forever, and the user would watch
    // a send that neither completes nor fails. The payload carries the whole
    // body for text, so the message is recoverable exactly.
    expect(three?.message_id).toBeDefined();
    const rebuilt = await db.messages_v2.get(three!.message_id!);
    expect(rebuilt?.local_message_id).toBe('cmd-3');
    expect(rebuilt?.channel_id).toBe('c1');
  });

  it('keeps an existing message_id only when it still resolves to this send', async () => {
    const name = `privchat-mig11b-${Date.now()}-${Math.random()}`;

    const legacy = new Dexie(name);
    legacy.version(10).stores(V10_STORES);
    await legacy.open();
    await legacy.table('messages').put({
      id: 'written-by-a-newer-tab',
      record_key: 'l:cmd-x',
      channel_id: 'c1',
      channel_type: 1,
      local_message_id: 'cmd-x',
      from_uid: '9',
      message_type: 'text',
      content: 'x',
      payload: new Uint8Array(),
      timestamp: 1_000,
      status: 'pending',
    });
    await legacy.table('outbox').put({
      ...legacyOutboxRow('cmd-x', 'l:cmd-x'),
      message_id: 'written-by-a-newer-tab',
    });
    legacy.close();

    db = new CacheDB(name);
    expect((await getOutboxEntry(db, 'cmd-x'))?.message_id).toBe(
      'written-by-a-newer-tab',
    );
  });

  // An existing message_id is not evidence that it is correct. Mixed-version
  // tabs, an interrupted upgrade or corruption can leave one pointing
  // somewhere wrong, and a wrong link is worse than a missing one: the ack
  // lands on another conversation's row.
  it('re-derives a message_id that points at a row in another channel', async () => {
    const name = `privchat-mig11c-${Date.now()}-${Math.random()}`;

    const legacy = new Dexie(name);
    legacy.version(10).stores(V10_STORES);
    await legacy.open();
    await legacy.table('messages').bulkPut([
      {
        id: 'belongs-to-c2',
        record_key: 'l:other',
        channel_id: 'c2',
        channel_type: 1,
        local_message_id: 'other',
        from_uid: '9',
        message_type: 'text',
        content: 'someone else',
        payload: new Uint8Array(),
        timestamp: 1_000,
        status: 'pending',
      },
      {
        id: 'the-right-one',
        record_key: 'l:cmd-y',
        channel_id: 'c1',
        channel_type: 1,
        local_message_id: 'cmd-y',
        from_uid: '9',
        message_type: 'text',
        content: 'y',
        payload: new Uint8Array(),
        timestamp: 2_000,
        status: 'pending',
      },
    ]);
    await legacy.table('outbox').put({
      ...legacyOutboxRow('cmd-y', 'l:cmd-y'),
      message_id: 'belongs-to-c2',
    });
    legacy.close();

    db = new CacheDB(name);
    expect((await getOutboxEntry(db, 'cmd-y'))?.message_id).toBe('the-right-one');
  });

  it('clears a message_id whose row is gone and cannot be re-derived', async () => {
    const name = `privchat-mig11d-${Date.now()}-${Math.random()}`;

    const legacy = new Dexie(name);
    legacy.version(10).stores(V10_STORES);
    await legacy.open();
    await legacy.table('outbox').put({
      ...legacyOutboxRow('cmd-z', 'l:cmd-z'),
      message_id: 'points-at-nothing',
    });
    legacy.close();

    db = new CacheDB(name);
    // The disproved pointer is not carried forward; the command is relinked
    // to a row rebuilt from its own payload instead.
    const row = await getOutboxEntry(db, 'cmd-z');
    expect(row?.message_id).toBeDefined();
    expect(row?.message_id).not.toBe('points-at-nothing');
    expect((await db.messages_v2.get(row!.message_id!))?.local_message_id).toBe('cmd-z');
  });
});
