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
  nextLocalMessageRecordId,
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

    // v10 (CONVERSATION_DEPENDENCY_READINESS §3.3): messages get a stable
    // local `id`. `record_key` flips from `l:{local_message_id}` to
    // `s:{server_message_id}` on ack, so anything keyed by it (pending
    // dependencies, projections) loses its row at that moment; `id` is the
    // identity that survives.
    //
    // `record_key` stays the primary key: it is what dedups a row across the
    // ack and what callers delete by. `id` is assigned exactly once per row
    // on first insert — see `stampIdentity`, which reuses the stored id when
    // the same row is written again. A caller that re-builds a record from
    // the network must not be able to mint a second identity for a message
    // that already exists locally.
    //
    // `&id` is account-global, not per-channel: `pending_dependency` records
    // a consumer as a bare `message.id` with no channel beside it, so an id
    // that is only unique within its channel would resolve to two rows.
    //
    // Legacy rows get a freshly minted id. Deriving it from
    // `server_message_id` / `local_message_id` would alias the three ids
    // CODEX-2 deliberately separated (UI identity / idempotency / wire), and
    // a row holding neither — a locally injected system card — would collapse
    // onto the empty string and take the unique index down with it.
    this.version(10)
      .stores({
        messages:
          '&[channel_id+record_key], &id, [channel_id+timestamp], [channel_id+server_message_id]',
      })
      .upgrade(async (tx) => {
        await tx
          .table('messages')
          .toCollection()
          .modify((m: { id?: string }) => {
            if (m.id) return;
            m.id = nextLocalMessageRecordId();
          });
      });

    // v11: give the outbox a stable foreign key to the message it delivers.
    //
    // Until now the only link was `record_key`, which is derived from
    // `local_message_id` while the send is in flight and from
    // `server_message_id` once it lands — so the join key changed underneath
    // the command it identified. `MessageRecord.id` does not change, and it
    // is what SDK_ENTITY_MODEL_SPEC §2.6.1 names as the local identity of a
    // message; the outbox should hold that, exactly as the Rust SDK's
    // `outbox.message_id` holds `message.id`.
    //
    // `command_id`/`outbox_id` stays equal to `local_message_id`: a send
    // command really is identified by the key the server dedupes on. The two
    // are different questions and now have different fields.
    this.version(11)
      .stores({
        outbox:
          '&outbox_id, channel_id, [channel_id+created_at], status, next_attempt_at, &local_message_id, message_id',
      })
      .upgrade(async (tx) => {
        // Backfill the link for commands written before this version.
        //
        // Iterate the outbox and await each lookup. Do NOT reach for
        // `.modify(async ...)`: Dexie's modifier is typed `void | boolean`
        // and is not awaited, so an async one returns a promise Dexie
        // discards and every assignment inside it lands after the write has
        // already been committed. That shape type-checks, runs without
        // error, and silently migrates nothing — which is exactly what the
        // first version of this did.
        //
        // Cost, stated honestly: the record_key and id probes are indexed,
        // but the local_message_id fallback scans the channel's messages and
        // filters in JS, so the worst case is O(outbox x channel_messages).
        // That is acceptable for a one-shot upgrade over an outbox holding
        // only unacked sends; it is not a pattern to reuse at runtime.
        // `messages_v2` should carry a real [channel_id+local_message_id]
        // index and this fallback should then use it.
        const messages = tx.table('messages');
        const outbox = tx.table('outbox');
        const rows: Array<{
          outbox_id: string;
          message_id?: string;
          channel_id?: string;
          record_key?: string;
          local_message_id?: string;
        }> = await outbox.toArray();

        /** A command may only point at a message in its own channel, and —
         *  when both sides name one — the same send. A link that fails this
         *  is worse than a missing one: the ack would be applied to someone
         *  else's row. */
        const owns = (
          row: { channel_id?: string; local_message_id?: string } | undefined,
          o: { channel_id?: string; local_message_id?: string },
        ): boolean => {
          if (row === undefined) return false;
          if (row.channel_id !== o.channel_id) return false;
          if (
            row.local_message_id !== undefined &&
            o.local_message_id !== undefined &&
            row.local_message_id !== o.local_message_id
          ) {
            return false;
          }
          return true;
        };

        for (const o of rows) {
          if (o.channel_id === undefined) continue;

          // An existing message_id is not evidence. Mixed-version tabs, an
          // interrupted upgrade or plain corruption can leave one pointing at
          // a row that is gone, in another channel, or belongs to a different
          // send. Verify it; only a link that still checks out is kept.
          if (o.message_id !== undefined) {
            const named = await messages.where('id').equals(o.message_id).first();
            if (owns(named, o)) continue;
            // Falls through and re-derives below rather than carrying a link
            // we just proved wrong.
          }

          // record_key first — it is what the command was written with.
          let row =
            o.record_key !== undefined
              ? await messages.get([o.channel_id, o.record_key])
              : undefined;
          if (!owns(row, o)) row = undefined;

          // Then local_message_id. A row that was already acked has been
          // rekeyed `l:` → `s:`, so the key its command still carries points
          // at nothing — and those are precisely the commands this field
          // exists to rescue, so missing them would leave the worst case
          // uncovered.
          if (row === undefined && o.local_message_id !== undefined) {
            row = await messages
              .where('[channel_id+record_key]')
              .between([o.channel_id, ''], [o.channel_id, '\uffff'])
              .filter(
                (m: { local_message_id?: string }) =>
                  m.local_message_id === o.local_message_id,
              )
              .first();
          }

          // Still nothing: the message is gone. Clear any link we disproved
          // above and leave it undefined, rather than carrying a pointer to a
          // row that does not exist or is not ours.
          if (row?.id === undefined) {
            if (o.message_id !== undefined) {
              await outbox.update(o.outbox_id, { message_id: undefined });
            }
            continue;
          }
          await outbox.update(o.outbox_id, { message_id: row.id });
        }
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

/**
 * Write rows, returning them **as stored**.
 *
 * The returned records are not always the ones passed in: `stampIdentity`
 * replaces a caller-minted `id` with the one already on disk. Callers that
 * publish to an in-memory store must publish THESE rows — publishing their
 * own copies re-introduces the identity split this whole mechanism exists
 * to prevent (the database keeps the stable id, memory shows a fresh one).
 */
export async function upsertMessages(
  db: CacheDB,
  records: MessageRecord[],
): Promise<MessageRecord[]> {
  if (records.length === 0) return [];
  return db.transaction('rw', db.messages, async () => {
    const stamped: StoredMessage[] = [];
    for (const record of records) stamped.push(await stampIdentity(db, record));
    await db.messages.bulkPut(stamped);
    return stamped.map(strip);
  });
}

/** Single-row [`upsertMessages`]; likewise returns the row as stored. */
export async function upsertMessage(
  db: CacheDB,
  record: MessageRecord,
): Promise<MessageRecord> {
  return db.transaction('rw', db.messages, async () => {
    const stamped = await stampIdentity(db, record);
    await db.messages.put(stamped);
    return strip(stamped);
  });
}

/**
 * Give the row its persistent identity, reusing the one already on disk.
 *
 * Callers rebuild `MessageRecord`s from the network freely — a re-opened
 * conversation re-fetches the same history — and each rebuild mints a fresh
 * `id`. Left alone that would either duplicate the row or, since `id` is a
 * unique index, fail the write outright. The stored id wins over the incoming
 * one; only a genuinely new row keeps the caller's.
 *
 * This is the plain-write path only. The ACK does NOT go through here: it
 * changes the row's key, which needs the deletes and the write to be one
 * atomic step — see `applyAckRekey`.
 */
async function stampIdentity(
  db: CacheDB,
  record: MessageRecord,
): Promise<StoredMessage> {
  const stamped = stamp(record);
  const existing = await db.messages.get([stamped.channel_id, stamped.record_key]);
  return existing === undefined ? stamped : { ...stamped, id: existing.id };
}

/**
 * A row other than the one being written already owns this `id`.
 *
 * Not recoverable locally: the identity is account-global, so a duplicate
 * means the invariant was already broken upstream. Surfaced as its own type
 * so callers can tell it apart from an ordinary write failure.
 */
export class MessageIdentityConflictError extends Error {
  readonly id: string;
  readonly conflicting_channel_id: string;
  readonly conflicting_record_key: string;

  constructor(id: string, channel_id: string, record_key: string) {
    super(
      `message id ${id} is already held by ${channel_id}/${record_key}; ` +
        'refusing to overwrite an unrelated row',
    );
    this.name = 'MessageIdentityConflictError';
    this.id = id;
    this.conflicting_channel_id = channel_id;
    this.conflicting_record_key = record_key;
  }
}

/**
 * Give one row a fresh local identity, atomically.
 *
 * The repair for an id collision. The alternative — deleting whichever row
 * currently holds the id — destroys a message that may be perfectly valid
 * and belongs to a different conversation. Re-minting touches only the row
 * that cannot currently be written, and `id` carries no meaning beyond
 * being unique, so nothing else depends on its value.
 *
 * Returns the row as stored, or `undefined` if it is gone.
 *
 * DEPENDENCY MIGRATION: once `pending_dependency` exists, its rows
 * referencing this message as a consumer must be re-keyed to the new id
 * INSIDE this transaction. Splitting the two would leave dependencies
 * pointing at an id no row has — precisely the dangling reference the
 * readiness spec forbids.
 */
export async function remintMessageIdentity(
  db: CacheDB,
  channel_id: string,
  record_key: string,
  id: string,
): Promise<MessageRecord | undefined> {
  return db.transaction('rw', db.messages, async () => {
    const row = await db.messages.get([channel_id, record_key]);
    if (row === undefined) return undefined;
    const clash = await db.messages.get({ id });
    if (clash !== undefined && clash.record_key !== record_key) {
      throw new MessageIdentityConflictError(id, clash.channel_id, clash.record_key);
    }
    const next: StoredMessage = { ...row, id };
    await db.messages.put(next);
    return strip(next);
  });
}

/** True when no row holds this id. Used to pick a replacement identity. */
export async function isMessageIdFree(db: CacheDB, id: string): Promise<boolean> {
  return (await db.messages.get({ id })) === undefined;
}

/**
 * Move a pending row onto its server key when the ACK lands. Atomic.
 *
 * The pending row's `id` wins, unconditionally. The competing row is the
 * self-push: the server can echo our own message back to us before the ACK
 * for it returns, creating a row under `s:{serverId}` with an id of its own.
 * If that id were allowed to win, every dependency and projection recorded
 * against the pending row — which is what the UI has been showing since the
 * moment the user hit send — would dangle. So the push-created row is
 * discarded and the pending identity is carried onto the server key.
 *
 * Both deletes and the write are one transaction. A crash mid-way must not
 * be able to leave the message twice in the timeline (pending + acked) or
 * zero times.
 *
 * Returns the row as persisted, so callers publish exactly what is durable.
 */
export async function applyAckRekey(
  db: CacheDB,
  channel_id: string,
  _channel_type: number,
  pending_record_key: string,
  acked: MessageRecord,
): Promise<MessageRecord> {
  return db.transaction('rw', db.messages, async () => {
    const stamped = stamp(acked);
    const pending = await db.messages.get([channel_id, pending_record_key]);
    const selfPush =
      stamped.record_key === pending_record_key
        ? undefined
        : await db.messages.get([channel_id, stamped.record_key]);

    // Precedence: the pending row, then a self-push row already on disk,
    // then the caller's. The middle case is what happens when the pending
    // write failed but the push landed — taking the caller's freshly minted
    // id there would orphan whatever already referenced the stored row.
    const id = pending?.id ?? selfPush?.id ?? stamped.id;

    await db.messages.delete([channel_id, pending_record_key]);
    if (selfPush !== undefined) {
      await db.messages.delete([channel_id, stamped.record_key]);
    }

    // `id` is account-global. Anything else still holding it is not a race
    // this function can resolve — it means a broken migration, a corrupted
    // database, or a caller reusing an id. Deleting that row to make room
    // would silently destroy an unrelated message, possibly in another
    // conversation. Throw and let the transaction roll back.
    const clash = await db.messages.get({ id });
    if (clash !== undefined) {
      throw new MessageIdentityConflictError(id, clash.channel_id, clash.record_key);
    }

    const row: StoredMessage = { ...stamped, id };
    await db.messages.put(row);
    return strip(row);
  });
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
