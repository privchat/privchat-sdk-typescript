// IndexedDB adapter via Dexie. Owns the schema + low-level CRUD; does NOT
// own observer fan-out (that lives in MessageStore).
//
// Identity model (v3):
//   - channels primary: `channel_id` (string)
//   - messages_v2 primary: the stable `id`; the persisted `sort_key`
//     derives from server_message_id || local_message_id (see
//     `displaySortKey` in ./types.ts).
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
  nextLocalMessageRecordId,
  type ChannelRecord,
  type FriendshipRecord,
  type GroupRecord,
  type MessageRecord,
  type OutboxEntry,
  type SyncStateRecord,
  type UserRecord,
  compareDisplayOrder,
  displaySortKey,
  encodeSortKey,
} from './types.js';

/** Persisted shape — adds the derived, fixed-width `sort_key` so IndexedDB
 *  can range-scan a channel in display order without loading and re-sorting
 *  it. Derived on write, never read by callers. Not exposed outside the cache
 *  module. */
interface StoredMessage extends MessageRecord {
  sort_key: string;
}

interface CacheMetadataRecord {
  key: string;
  value: string;
}

const CACHE_OWNER_KEY = 'owner_user_id';
/** High-water mark for `local_order_seq`. Account-global and monotonic; it is
 *  read, bumped and used inside one transaction, because allocating outside
 *  the write is how two tabs hand out the same number. */
const LOCAL_ORDER_SEQ_KEY = 'local_order_seq_high_water';

export class CacheDB extends Dexie {
  channels!: Table<ChannelRecord, string>;
  messages_v2!: Table<StoredMessage, string>;

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

        /** A command may only point at the message of its own send: same
         *  channel, same `local_message_id`. The match is exact — a row with
         *  no local_message_id is an inbound message, i.e. one we never sent,
         *  and letting a command claim one is how a damaged link ends up
         *  rewriting somebody else's message into ours. */
        const owns = (
          row: { channel_id?: string; local_message_id?: string } | undefined,
          o: { channel_id?: string; local_message_id?: string },
        ): boolean =>
          row !== undefined &&
          row.channel_id === o.channel_id &&
          row.local_message_id === o.local_message_id;

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

    // v12: the message store's primary key becomes the stable `id`.
    //
    // Dexie cannot change an object store's primary key in place
    // (`UpgradeError: Not yet support for changing primary key`), so this
    // creates `messages_v2` and moves the rows across inside the upgrade
    // transaction, together with the outbox references that point at them.
    // Migrating the messages first and the outbox afterwards would leave a
    // window where a crash strands commands pointing at a table that no
    // longer exists.
    //
    // What goes away with the old key: `record_key` was derived from
    // `local_message_id` before the ack and `server_message_id` after, so the
    // primary key moved mid-flight. Rekeying on ack, identity-conflict
    // detection, re-minting and the repair pass around them all existed to
    // survive that. None of them are needed once the key stops moving.
    this.version(12)
      .stores({
        messages_v2:
          '&id, [channel_id+sort_key], &[channel_id+server_message_id], [channel_id+local_message_id], channel_id',
        // Old store stays declared so the upgrade can read it; dropped in v13.
        messages:
          '&[channel_id+record_key], &id, [channel_id+timestamp], [channel_id+server_message_id]',
      })
      .upgrade(async (tx) => {
        const oldMessages = tx.table('messages');
        const v2 = tx.table('messages_v2');
        const outbox = tx.table('outbox');
        const meta = tx.table('cache_metadata');

        const rows: Array<Record<string, unknown>> = await oldMessages.toArray();

        // Deterministic, repeatable numbering (SDK_ENTITY_MODEL_SPEC
        // §2.6.2.1). Per channel: while ANY confirmed row lacks pts, that
        // channel's confirmed rows are ordered by server_message_id alone —
        // a server-issued snowflake needing no local inference. Ordering them
        // by "has pts" would claim the local write path tells us the server's
        // order, which it does not.
        const byChannel = new Map<string, Array<Record<string, unknown>>>();
        for (const r of rows) {
          const cid = String(r.channel_id ?? '');
          const list = byChannel.get(cid);
          if (list === undefined) byChannel.set(cid, [r]);
          else list.push(r);
        }

        const cmp = (a: string | undefined, b: string | undefined): number => {
          const x = encodeSortKey(a);
          const y = encodeSortKey(b);
          return x < y ? -1 : x > y ? 1 : 0;
        };

        let seq = 0;
        const ordered: Array<Record<string, unknown>> = [];
        for (const list of byChannel.values()) {
          const confirmed = list.filter(
            (r) => r.server_message_id !== undefined && r.server_message_id !== '',
          );
          const pendingRows = list.filter(
            (r) => r.server_message_id === undefined || r.server_message_id === '',
          );
          const anyMissingPts = confirmed.some(
            (r) => r.pts === undefined || r.pts === '',
          );
          confirmed.sort((a, b) =>
            anyMissingPts
              ? cmp(a.server_message_id as string, b.server_message_id as string)
              : cmp(a.pts as string, b.pts as string) ||
                cmp(a.server_message_id as string, b.server_message_id as string),
          );
          // Pending last, in their existing persisted order. Rows with no
          // outbox row left carry no authoritative order at all, so timestamp
          // is used — acceptable for one-shot deterministic numbering, and
          // not a runtime ordering rule.
          pendingRows.sort(
            (a, b) =>
              Number(a.timestamp ?? 0) - Number(b.timestamp ?? 0) ||
              String(a.id ?? '').localeCompare(String(b.id ?? '')),
          );
          ordered.push(...confirmed, ...pendingRows);
        }

        const idByOldKey = new Map<string, string>();
        for (const r of ordered) {
          seq += 1;
          const id = String(r.id ?? nextLocalMessageRecordId());
          const { record_key, ...rest } = r as { record_key?: string };
          if (record_key !== undefined) {
            idByOldKey.set(`${String(r.channel_id ?? '')}|${record_key}`, id);
          }
          const migrated = { ...rest, id, local_order_seq: seq } as MessageRecord;
          await v2.put({ ...migrated, sort_key: displaySortKey(migrated) });
        }
        await meta.put({ key: LOCAL_ORDER_SEQ_KEY, value: String(seq) });

        // Outbox references, in the same transaction. A command whose
        // message_id already resolves is left alone; otherwise its stale
        // record_key is translated once, while the mapping still exists.
        const commands: Array<Record<string, unknown>> = await outbox.toArray();
        for (const o of commands) {
          if (o.message_id !== undefined) continue;
          const key = `${String(o.channel_id ?? '')}|${String(o.record_key ?? '')}`;
          const id = idByOldKey.get(key);
          if (id !== undefined) await outbox.update(o.outbox_id as string, { message_id: id });
        }
      });

    // v13: the old store has served its purpose.
    this.version(13).stores({ messages: null });

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
      db.messages_v2,
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
      await db.messages_v2.clear();
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

/** Allocate the next `local_order_seq` values inside the caller's
 *  transaction (SDK_ENTITY_MODEL_SPEC §2.6.2.1).
 *
 *  Read, bump and use must be one transaction. Handing out numbers outside
 *  the write is how two tabs get the same one. */
async function allocateOrderSeq(db: CacheDB, count: number): Promise<number> {
  const row = await db.cache_metadata.get(LOCAL_ORDER_SEQ_KEY);
  const start = Number(row?.value ?? '0');
  await db.cache_metadata.put({
    key: LOCAL_ORDER_SEQ_KEY,
    value: String(start + count),
  });
  return start;
}

/**
 * Write rows, returning them **as stored**.
 *
 * Identity and order both come off the row already on disk when there is
 * one: a re-opened conversation re-fetches the same history and rebuilds
 * fresh `MessageRecord`s each time, so keeping the caller's id would either
 * duplicate the row or fail the unique index, and re-allocating
 * `local_order_seq` would make the message jump position in the timeline.
 *
 * A row is matched — in this order — by stable id, by
 * `(channel_id, server_message_id)`, then by
 * `(channel_id, local_message_id)`. The second is what dedupes the same
 * server message arriving by push and by sync; the third is what lets an
 * ack, or our own message echoed back from the server, find the optimistic
 * row instead of inserting beside it.
 */
export async function upsertMessages(
  db: CacheDB,
  records: MessageRecord[],
): Promise<MessageRecord[]> {
  if (records.length === 0) return [];
  return db.transaction('rw', db.messages_v2, db.cache_metadata, async () => {
    // Allocate once for the batch; only genuinely new rows consume one.
    let next = await allocateOrderSeq(db, records.length);
    const out: StoredMessage[] = [];
    for (const record of records) {
      const existing = await findExisting(db, record);
      // `id` is account-global, so a row arriving under an existing id but a
      // different channel is not an update — it is one message being moved
      // into another conversation. `put` would do it silently. Refuse: the
      // caller minted a colliding id, and pretending otherwise loses the row
      // that was there.
      if (existing !== undefined && existing.channel_id !== record.channel_id) {
        throw new Error(
          `message id ${record.id} already belongs to channel ${existing.channel_id}; ` +
            `refusing to move it to ${record.channel_id}`,
        );
      }
      const merged: MessageRecord = {
        ...record,
        id: existing?.id ?? record.id,
        local_order_seq:
          existing?.local_order_seq ?? record.local_order_seq ?? (next += 1),
      };
      const stamped = stamp(merged);
      // The row may be moving off a key another row holds (pending row that
      // just gained its server id). Delete by the old primary key first so
      // the unique index does not see two.
      if (existing !== undefined && existing.id !== stamped.id) {
        await db.messages_v2.delete(existing.id);
      }
      await db.messages_v2.put(stamped);
      out.push(stamped);
    }
    return out.map(strip);
  });
}

/** Single-row [`upsertMessages`]; likewise returns the row as stored. */
export async function upsertMessage(
  db: CacheDB,
  record: MessageRecord,
): Promise<MessageRecord> {
  const [stored] = await upsertMessages(db, [record]);
  return stored!;
}

/** Locate the row this record refers to, by stable id then by either
 *  network identity. Returns undefined for a genuinely new message. */
async function findExisting(
  db: CacheDB,
  record: MessageRecord,
): Promise<StoredMessage | undefined> {
  const byId = await db.messages_v2.get(record.id);
  if (byId !== undefined) return byId;
  if (record.server_message_id !== undefined && record.server_message_id !== '') {
    const bySmid = await db.messages_v2
      .where('[channel_id+server_message_id]')
      .equals([record.channel_id, record.server_message_id])
      .first();
    if (bySmid !== undefined) return bySmid;
  }
  if (record.local_message_id !== undefined && record.local_message_id !== '') {
    const byLmid = await db.messages_v2
      .where('[channel_id+local_message_id]')
      .equals([record.channel_id, record.local_message_id])
      .first();
    if (byLmid !== undefined) return byLmid;
  }
  return undefined;
}

/** The cache row a command was delivering is gone, and its payload cannot
 *  rebuild it — media and structured cards depend on a local file or on
 *  metadata the outbox row never carried.
 *
 *  Repair is to re-hydrate the projection from the server: the message was
 *  accepted, so it can be fetched back by its server id, after which the
 *  original stable id is kept.
 */
export class ProjectionRehydrateRequiredError extends Error {
  constructor(
    readonly message_id: string | undefined,
    readonly conflicting_channel_id: string,
    readonly content_type: string,
  ) {
    super(
      `message ${message_id ?? '(unlinked)'} in ${conflicting_channel_id} is missing from the cache ` +
        `and a ${content_type} payload cannot rebuild it; needs re-hydration from the server`,
    );
    this.name = 'ProjectionRehydrateRequiredError';
  }
}

/**
 * Apply a server ACK to the message the command delivered — in place.
 *
 * The row keeps its primary key, because the key is the stable `id` and the
 * ack does not touch it. What used to happen here was a rekey: the key was
 * derived from `local_message_id` before the ack and `server_message_id`
 * after, so applying an ack meant deleting one row and inserting another,
 * which needed collision detection, identity re-minting and a repair pass to
 * survive. All of that was the cost of a moving key, and it is gone.
 *
 * `local_order_seq` is preserved: the message does not change position in the
 * timeline just because it was acknowledged.
 */
export async function applyAck(
  db: CacheDB,
  acked: MessageRecord,
): Promise<MessageRecord> {
  return db.transaction('rw', db.messages_v2, db.cache_metadata, async () => {
    // Up to two rows can describe this message at ack time: the optimistic
    // one we inserted when the user hit send, and a self-push copy the
    // server fanned back before the ack landed.
    const local =
      acked.local_message_id === undefined
        ? undefined
        : await db.messages_v2
            .where('[channel_id+local_message_id]')
            .equals([acked.channel_id, acked.local_message_id])
            .first();
    const remote =
      acked.server_message_id === undefined
        ? undefined
        : await db.messages_v2
            .where('[channel_id+server_message_id]')
            .equals([acked.channel_id, acked.server_message_id])
            .first();

    // Whose identity survives:
    //
    //   - the optimistic row, when it is still there. It is what the UI
    //     rendered and what dependencies were keyed by.
    //   - otherwise the CALLER's, not the remote row's. A row found only by
    //     server id and carrying no local_message_id is a network copy —
    //     a self-push, or a history row a rehydrate just fetched back. Those
    //     were created seconds ago and nothing references them, while the
    //     caller's id comes off the outbox command and is what the UI and
    //     any dependencies have pointed at all along.
    //
    // Either way the other row is absorbed below, so one message stays one
    // row.
    const keep = local;
    const merged: MessageRecord = {
      ...acked,
      id: keep?.id ?? acked.id,
      // Position does not change just because the message was acknowledged.
      // Position is inherited from whichever row already had one: being
      // acknowledged does not move a message in the timeline.
      local_order_seq:
        keep?.local_order_seq ??
        remote?.local_order_seq ??
        acked.local_order_seq ??
        (await allocateOrderSeq(db, 1)) + 1,
    };
    const stamped = stamp(merged);

    // Absorb whichever row we did not keep. One logical message, one row.
    for (const row of [local, remote]) {
      if (row !== undefined && row.id !== stamped.id) {
        await db.messages_v2.delete(row.id);
      }
    }
    await db.messages_v2.put(stamped);
    return strip(stamped);
  });
}

/** Latest `limit` messages for a channel, in display order (ascending).
 *
 *  Range-scans the persisted `sort_key`, so IndexedDB returns the timeline
 *  already ordered — no load-everything-and-re-sort, and no second ordering
 *  rule that could disagree with the in-memory one. */
export async function getMessageWindow(
  db: CacheDB,
  channel_id: string,
  _channel_type: number,
  limit: number,
): Promise<MessageRecord[]> {
  const desc = await db.messages_v2
    .where('[channel_id+sort_key]')
    .between([channel_id, ''], [channel_id, '\uffff'])
    .reverse()
    .limit(limit)
    .toArray();
  return desc.reverse().map(strip);
}

/** Page strictly older than a cursor, in display order (ascending).
 *
 *  The cursor is the display sort key, not a timestamp: a keyset page has to
 *  walk the same order the list is rendered in, or paging and rendering
 *  disagree at every boundary. This is local only — the network history
 *  cursor stays `before_server_message_id` (SDK_ENTITY_MODEL_SPEC §2.6.3). */
export async function getMessagesBefore(
  db: CacheDB,
  channel_id: string,
  _channel_type: number,
  before: MessageRecord | string,
  limit: number,
): Promise<MessageRecord[]> {
  const cursor = typeof before === 'string' ? before : displaySortKey(before);
  const desc = await db.messages_v2
    .where('[channel_id+sort_key]')
    .between([channel_id, ''], [channel_id, cursor], true, false)
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
  await db.messages_v2
    .where('[channel_id+server_message_id]')
    .equals([channel_id, server_message_id])
    .delete();
}

/** Delete a message by its stable local id. */
export async function deleteMessageById(db: CacheDB, id: string): Promise<void> {
  await db.messages_v2.delete(id);
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
  await db.messages_v2.where('channel_id').equals(channel_id).delete();
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
      db.messages_v2,
      db.sync_state,
      db.outbox,
      db.users,
      db.groups,
      db.friendships,
      db.cache_metadata,
    ],
    async () => {
      await db.channels.clear();
      await db.messages_v2.clear();
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
  return { ...record, sort_key: displaySortKey(record) };
}

function strip(stored: StoredMessage): MessageRecord {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { sort_key: _, ...rest } = stored;
  return rest;
}
