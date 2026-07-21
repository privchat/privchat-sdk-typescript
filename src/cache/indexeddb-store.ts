// IndexedDB adapter via Dexie. Owns the schema + low-level CRUD; does NOT
// own observer fan-out (that lives in MessageStore).
//
// Identity model (v3):
//   - channels primary: `channel_id` (string)
//   - messages primary: compound (channel_id, record_key); record_key
//     derives from server_message_id || local_message_id (see
//     `messageRecordKey` in ./types.ts).
//   - sync_state primary: `channel_id`
//   - outbox primary: `outbox_id`; secondary indexes on channel_id (and
//     `[channel_id+created_at]`) drive per-channel FIFO scans.
//
// `channel_type` was REMOVED from primary keys in v3. It remains a column
// on each row (used by UI to pick "direct vs group settings"), but the
// store dedupes purely by channel_id — that is the gateway's identity for
// a conversation, and letting `channel_type` participate in the key
// allowed the same conversation to surface twice in the UI when an
// upstream service emitted inconsistent types.
//
// Sort key for messages remains `timestamp`. A secondary index supports
// window queries + before-cursor pagination; a third index on
// server_message_id supports revoke / dedup lookups.

import Dexie, { type Table } from 'dexie';
import {
  messageRecordKey,
  type ChannelRecord,
  type FriendshipRecord,
  type GroupRecord,
  type MessageRecord,
  type OutboxEntry,
  type SyncStateRecord,
  type UserRecord,
} from './types.js';

/** Persisted shape — adds the derived `record_key` so Dexie has something
 *  reliable as part of the compound primary key. Not exposed outside the
 *  cache module. */
interface StoredMessage extends MessageRecord {
  record_key: string;
}

interface CacheMetadataRecord {
  key: string;
  value: string;
}

const CACHE_OWNER_KEY = 'owner_user_id';

export class CacheDB extends Dexie {
  channels!: Table<ChannelRecord, string>;
  messages!: Table<StoredMessage, [string, string]>;
  sync_state!: Table<SyncStateRecord, string>;
  /** Outbox. `outbox_id` is the primary key; `local_message_id` is unique. */
  outbox!: Table<OutboxEntry, string>;
  /** R2A profile cache: cached user / group profiles for title resolution. */
  users!: Table<UserRecord, string>;
  groups!: Table<GroupRecord, string>;
  /** R2.1 friendship cache: alias / `is_friend` source for the title
   *  resolver. Holds only ACCEPTED friendships (the server's wire
   *  filter excludes pending/blocked rows; tombstones cause local
   *  delete). Primary key is the friend's `user_id`. */
  friendships!: Table<FriendshipRecord, string>;
  /** Account-isolation guard. Every populated cache belongs to exactly one
   * authenticated user; hosts must never be able to hydrate another user's
   * rows merely by reusing a database name. */
  cache_metadata!: Table<CacheMetadataRecord, string>;

  constructor(dbName: string) {
    super(dbName);

    // v1: original cache (channels/messages/sync_state) keyed on
    // [channel_id+channel_type]. v2: added outbox (also composite-keyed).
    this.version(1).stores({
      channels: '&[channel_id+channel_type], updated_at',
      messages:
        '&[channel_id+channel_type+record_key], [channel_id+channel_type+timestamp], [channel_id+channel_type+server_message_id]',
      sync_state: '&[channel_id+channel_type]',
    });
    this.version(2).stores({
      outbox:
        '&outbox_id, [channel_id+channel_type], [channel_id+channel_type+created_at], status, next_attempt_at, &local_message_id',
    });

    // v3 / v4: drop `channel_type` from every primary key. The gateway
    // treats channel_id as the conversation's identity, so the local cache
    // must too.
    //
    // Dexie cannot change a primary key in a single version step (throws
    // "Not yet support for changing primary key"). The supported pattern
    // is: v3 drops the affected tables (stores: null), v4 re-creates them
    // with the new key shape. Existing v2 rows are discarded — channels +
    // sync_state get rehydrated by `bootstrapChannels()`, messages by
    // `openConversation()`. The outbox primary key (`outbox_id`) doesn't
    // change shape but we drop+recreate alongside so we can rebuild
    // secondary indexes off `channel_id` instead of the old composite.
    // Outbox rows do get wiped this way, but in practice any row that
    // mattered would've been flushed before the upgrade — and dev-stage
    // is the right time to take this hit.
    this.version(3).stores({
      channels: null,
      messages: null,
      sync_state: null,
      outbox: null,
    });
    this.version(4).stores({
      channels: '&channel_id, channel_type, updated_at',
      messages:
        '&[channel_id+record_key], [channel_id+timestamp], [channel_id+server_message_id]',
      sync_state: '&channel_id',
      outbox:
        '&outbox_id, channel_id, [channel_id+created_at], status, next_attempt_at, &local_message_id',
    });

    // v5 (R2A): add `users` and `groups` profile-cache tables. Pure
    // additions — no existing rows are migrated, so no upgrade callback
    // is needed (Dexie creates the new object stores on open). The
    // `sync_version` index supports incremental syncs that look up the
    // local high-water mark before paging.
    this.version(5).stores({
      users: '&user_id, sync_version',
      groups: '&group_id, sync_version',
    });

    // v6 (R2.1): friendships table for alias / contact-relation cache.
    // Pure addition — same migration shape as v5. Primary key is
    // `user_id` (the friend's uid; current user is implicit since
    // we're a single-account SDK), with a `sync_version` index for
    // incremental-sync watermarking.
    this.version(6).stores({
      friendships: '&user_id, sync_version',
    });

    // v7 (R6.a + R6.c): four new optional flags on ChannelRecord —
    // `last_message_revoked` / `pinned` / `muted` / `hidden`. None
    // are indexed (they're cheap row-level reads), so the schema
    // string is unchanged; we just bump the version + backfill
    // defaults onto existing rows so consumers don't see undefined.
    //
    // Existing rows without the fields would still work (TypeScript
    // optional properties tolerate undefined), but explicit `false`
    // defaults make VM logic — "revoked-or-not", "pinned-or-not" —
    // safer to read without sprinkling `?? false` everywhere. The
    // migration is idempotent: `bulkPut` overwrites whole rows but
    // we only touch the new fields if they're not already set.
    this.version(7)
      .stores({
        // No index changes — bumping the version is enough for Dexie
        // to fire the upgrade callback below. Re-stating the channels
        // line preserves the existing indexes verbatim.
        channels: '&channel_id, channel_type, updated_at',
      })
      .upgrade(async (tx) => {
        const channels = tx.table('channels');
        await channels.toCollection().modify((row: ChannelRecord) => {
          if (row.last_message_revoked === undefined) row.last_message_revoked = false;
          if (row.pinned === undefined) row.pinned = false;
          if (row.muted === undefined) row.muted = false;
          if (row.hidden === undefined) row.hidden = false;
        });
      });

    // v8: persist the authenticated owner of this database. Existing v7
    // databases intentionally start unowned; the first successful
    // authenticate performs a one-time wipe before claiming ownership.
    // This repairs caches contaminated by the legacy shared-DB migration.
    this.version(8).stores({
      cache_metadata: '&key',
    });

    // v9 (PROFILE_VISIBILITY P1): one-time cleanse of stale usernames.
    // The server no longer emits non-friend usernames, but rows cached by
    // older builds still hold them — an eternal leak unless wiped. Clear
    // username for every user row without a local friendship; friends keep
    // theirs (and the friend entity sync re-hydrates going forward).
    this.version(9)
      .stores({})
      .upgrade(async (tx) => {
        const friendIds = new Set(
          (await tx.table('friendships').toCollection().primaryKeys()).map(String),
        );
        await tx
          .table('users')
          .toCollection()
          .modify((u: { user_id: string; username?: string }) => {
            if (!friendIds.has(String(u.user_id))) u.username = '';
          });
      });
  }
}

/**
 * Bind a cache database to one authenticated user.
 *
 * Returns true when persisted rows were reset. Missing ownership is treated
 * as unsafe rather than implicitly trusted: old releases could copy a shared
 * legacy database into more than one account database, so its rows cannot be
 * attributed reliably. The reset and owner write are one IndexedDB
 * transaction, preventing a partially-cleared database from being claimed.
 */
export async function ensureCacheOwner(
  db: CacheDB,
  userId: string,
): Promise<boolean> {
  if (userId.length === 0) {
    throw new Error('cache owner user id must not be empty');
  }

  return db.transaction(
    'rw',
    [
      db.channels,
      db.messages,
      db.sync_state,
      db.outbox,
      db.users,
      db.groups,
      db.friendships,
      db.cache_metadata,
    ],
    async () => {
      const current = await db.cache_metadata.get(CACHE_OWNER_KEY);
      if (current?.value === userId) return false;

      await db.channels.clear();
      await db.messages.clear();
      await db.sync_state.clear();
      await db.outbox.clear();
      await db.users.clear();
      await db.groups.clear();
      await db.friendships.clear();
      await db.cache_metadata.clear();
      await db.cache_metadata.put({ key: CACHE_OWNER_KEY, value: userId });
      return true;
    },
  );
}

export async function getCacheOwner(db: CacheDB): Promise<string | undefined> {
  return (await db.cache_metadata.get(CACHE_OWNER_KEY))?.value;
}

// ----- Channel ops -----

export async function upsertChannels(
  db: CacheDB,
  records: ChannelRecord[],
): Promise<void> {
  if (records.length === 0) return;
  await db.channels.bulkPut(records);
}

export async function listChannels(db: CacheDB): Promise<ChannelRecord[]> {
  return db.channels.orderBy('updated_at').reverse().toArray();
}

export async function getChannel(
  db: CacheDB,
  channel_id: string,
  // `channel_type` is no longer part of the key. Accepted for API
  // compatibility with v2 callers; ignored.
  _channel_type?: number,
): Promise<ChannelRecord | undefined> {
  return db.channels.get(channel_id);
}

// ----- Message ops -----

export async function upsertMessages(
  db: CacheDB,
  records: MessageRecord[],
): Promise<void> {
  if (records.length === 0) return;
  await db.messages.bulkPut(records.map(stamp));
}

export async function upsertMessage(
  db: CacheDB,
  record: MessageRecord,
): Promise<void> {
  await db.messages.put(stamp(record));
}

/** Latest `limit` messages for a channel, ordered ascending by timestamp. */
export async function getMessageWindow(
  db: CacheDB,
  channel_id: string,
  _channel_type: number,
  limit: number,
): Promise<MessageRecord[]> {
  const desc = await db.messages
    .where('[channel_id+timestamp]')
    .between([channel_id, -Infinity], [channel_id, Infinity])
    .reverse()
    .limit(limit)
    .toArray();
  return desc.reverse().map(strip);
}

/** Page older than the given timestamp, ascending order. */
export async function getMessagesBefore(
  db: CacheDB,
  channel_id: string,
  _channel_type: number,
  before_timestamp: number,
  limit: number,
): Promise<MessageRecord[]> {
  const desc = await db.messages
    .where('[channel_id+timestamp]')
    .between([channel_id, -Infinity], [channel_id, before_timestamp], true, false)
    .reverse()
    .limit(limit)
    .toArray();
  return desc.reverse().map(strip);
}

/** Delete a message by its server-assigned id (used for revokes). */
export async function deleteMessageByServerId(
  db: CacheDB,
  channel_id: string,
  _channel_type: number,
  server_message_id: string,
): Promise<void> {
  await db.messages
    .where('[channel_id+server_message_id]')
    .equals([channel_id, server_message_id])
    .delete();
}

/** Delete a message by its internal record_key (used for local-echo ACK swaps). */
export async function deleteMessageByRecordKey(
  db: CacheDB,
  channel_id: string,
  _channel_type: number,
  record_key: string,
): Promise<void> {
  await db.messages.delete([channel_id, record_key]);
}

/**
 * Drop every persisted message for one channel. Used by the sync engine
 * when the server returns 20900 SyncChannelResyncRequired — the cache
 * window is invalidated and must be re-hydrated from the authoritative
 * history wire via `openConversation`.
 */
export async function clearChannelMessages(
  db: CacheDB,
  channel_id: string,
  _channel_type?: number,
): Promise<void> {
  await db.messages
    .where('[channel_id+timestamp]')
    .between([channel_id, -Infinity], [channel_id, Infinity])
    .delete();
}

// ----- Sync state ops -----

export async function getSyncState(
  db: CacheDB,
  channel_id: string,
  _channel_type?: number,
): Promise<SyncStateRecord | undefined> {
  return db.sync_state.get(channel_id);
}

export async function upsertSyncState(
  db: CacheDB,
  record: SyncStateRecord,
): Promise<void> {
  await db.sync_state.put(record);
}

// ----- User profile cache (R2A) -----

export async function upsertUsers(
  db: CacheDB,
  records: UserRecord[],
): Promise<void> {
  if (records.length === 0) return;
  await db.users.bulkPut(records);
}

export async function listUsers(db: CacheDB): Promise<UserRecord[]> {
  return db.users.toArray();
}

/** Highest `sync_version` known locally — used as the `since_version`
 *  cursor on the next entity sync page. Returns 0 when the table is empty. */
export async function maxUserSyncVersion(db: CacheDB): Promise<number> {
  const top = await db.users.orderBy('sync_version').reverse().first();
  return top?.sync_version ?? 0;
}

// ----- Group profile cache (R2A) -----

export async function upsertGroups(
  db: CacheDB,
  records: GroupRecord[],
): Promise<void> {
  if (records.length === 0) return;
  await db.groups.bulkPut(records);
}

export async function listGroups(db: CacheDB): Promise<GroupRecord[]> {
  return db.groups.toArray();
}

export async function maxGroupSyncVersion(db: CacheDB): Promise<number> {
  const top = await db.groups.orderBy('sync_version').reverse().first();
  return top?.sync_version ?? 0;
}

// ----- Friendship cache (R2.1) -----

export async function upsertFriendships(
  db: CacheDB,
  records: FriendshipRecord[],
): Promise<void> {
  if (records.length === 0) return;
  await db.friendships.bulkPut(records);
}

export async function deleteFriendships(
  db: CacheDB,
  user_ids: string[],
): Promise<void> {
  if (user_ids.length === 0) return;
  await db.friendships.bulkDelete(user_ids);
}

export async function listFriendships(db: CacheDB): Promise<FriendshipRecord[]> {
  return db.friendships.toArray();
}

export async function maxFriendshipSyncVersion(db: CacheDB): Promise<number> {
  const top = await db.friendships.orderBy('sync_version').reverse().first();
  return top?.sync_version ?? 0;
}

// ----- Bulk wipe (logout / clear_local_state) -----

export async function clearAll(db: CacheDB): Promise<void> {
  // Dexie's typed `transaction()` tops out at 5 store arguments before
  // requiring the array form; with users / groups / friendships added
  // we cross that bound, so pass the table list as an explicit array.
  await db.transaction(
    'rw',
    [
      db.channels,
      db.messages,
      db.sync_state,
      db.outbox,
      db.users,
      db.groups,
      db.friendships,
      db.cache_metadata,
    ],
    async () => {
      await db.channels.clear();
      await db.messages.clear();
      await db.sync_state.clear();
      await db.outbox.clear();
      await db.users.clear();
      await db.groups.clear();
      await db.friendships.clear();
      await db.cache_metadata.clear();
    },
  );
}

// ----- Internal: record_key stamping -----

function stamp(record: MessageRecord): StoredMessage {
  return { ...record, record_key: messageRecordKey(record) };
}

function strip(stored: StoredMessage): MessageRecord {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { record_key: _, ...rest } = stored;
  return rest;
}
