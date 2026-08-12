import Dexie from 'dexie';
import { CacheDB } from '../../src/cache-idb.js';
import { afterEach, describe, expect, it } from 'vitest';
import { getMessageWindow } from '../../src/cache/indexeddb-store.js';

/**
 * v10 backfill (CONVERSATION_DEPENDENCY_READINESS §3.3).
 *
 * Legacy rows predate `MessageRecord.id`. The identity they get must be
 * freshly minted, not derived from `server_message_id` / `local_message_id`:
 * those are the other two of the three ids CODEX-2 separated, and a row
 * holding neither — a locally injected system card — would otherwise
 * collapse onto the empty string and take the unique index with it.
 */
describe('v10 message id migration', () => {
  let db: CacheDB | undefined;

  afterEach(() => {
    db?.close();
  });

  it('mints a fresh id for every legacy row, including rows with no message id at all', async () => {
    const name = `privchat-mig-${Date.now()}-${Math.random()}`;

    // A pre-v10 database, written by an older build.
    const legacy = new Dexie(name);
    legacy.version(9).stores({
      channels: '&channel_id, channel_type, updated_at',
      messages:
        '&[channel_id+record_key], [channel_id+timestamp], [channel_id+server_message_id]',
      sync_state: '&channel_id',
      outbox:
        '&outbox_id, channel_id, [channel_id+created_at], status, next_attempt_at, &local_message_id',
      users: '&user_id, sync_version',
      groups: '&group_id, sync_version',
      friendships: '&user_id, sync_version',
      cache_metadata: '&key',
    });
    await legacy.open();
    await legacy.table('messages').bulkPut([
      {
        record_key: 's-1',
        channel_id: 'c1',
        channel_type: 1,
        server_message_id: 's-1',
        from_uid: '9',
        message_type: 'text',
        content: 'server-only',
        payload: new Uint8Array(),
        timestamp: 1_000,
        status: 'received',
      },
      {
        record_key: 'l-1',
        channel_id: 'c1',
        channel_type: 1,
        local_message_id: 'l-1',
        from_uid: '9',
        message_type: 'text',
        content: 'local-only',
        payload: new Uint8Array(),
        timestamp: 2_000,
        status: 'pending',
      },
      // Locally injected row: no server id, no local id. Deriving an
      // identity from those fields gives '' for this row.
      {
        record_key: 'sys-1',
        channel_id: 'c1',
        channel_type: 1,
        from_uid: '0',
        message_type: 'system',
        content: 'system card',
        payload: new Uint8Array(),
        timestamp: 3_000,
        status: 'received',
      },
      {
        record_key: 'sys-2',
        channel_id: 'c1',
        channel_type: 1,
        from_uid: '0',
        message_type: 'system',
        content: 'another system card',
        payload: new Uint8Array(),
        timestamp: 4_000,
        status: 'received',
      },
    ]);
    legacy.close();

    db = new CacheDB(name);
    const rows = await getMessageWindow(db, 'c1', 1, 10);

    expect(rows).toHaveLength(4);
    for (const r of rows) {
      expect(r.id).toMatch(/^\d+$/);
      expect(r.id).not.toBe('');
      // Not aliased onto either of the other two ids.
      expect(r.id).not.toBe(r.server_message_id);
      expect(r.id).not.toBe(r.local_message_id);
    }
    // Including the two rows that carry no message id whatsoever.
    expect(new Set(rows.map((r) => r.id)).size).toBe(4);
  });
});
