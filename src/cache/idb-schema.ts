// IndexedDB SCHEMA — the ONLY module in the SDK that imports dexie as a
// value. Split from the operation functions so that dexie is bundled ONLY
// when a consumer actually constructs persistence (via the
// `@privchat/sdk/cache-idb` subpath); the main entry reaches this module
// with `import type` alone, which erases at compile time. A widget that
// never enables the cache no longer ships 31 KB gz of IndexedDB machinery.
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
  hasPtsGap,
  type ChannelOrderMode,
  GroupMemberRecord,
} from './types.js';
import {
  decodeRebuildableContent,
  isRebuildableFromPayload,
} from './rebuild.js';
import { mergeSentAt } from './canonical-inbound.js';
import {
  CACHE_OWNER_KEY,
  LOCAL_ORDER_SEQ_KEY,
  orderModeKey,
} from './idb-keys.js';

/** Persisted shape — adds the derived, fixed-width `sort_key` so IndexedDB
 *  can range-scan a channel in display order without loading and re-sorting
 *  it. Derived on write, never read by callers. Not exposed outside the cache
 *  module. */
export interface StoredMessage extends MessageRecord {
  sort_key: string;
  /** 1 when this row is confirmed but has no pts — the condition that forces
   *  its channel into `server_id` ordering. Stored and indexed so recovery is
   *  an indexed count rather than a full channel scan on every write. */
  pts_gap: 0 | 1;
}

/** A row that could not be admitted under the unique `server_message_id`
 *  index: two different local rows claiming one network identity. Kept rather
 *  than deleted — it is user data, and the conflict is evidence of a bug we
 *  would otherwise destroy the only record of. */
export interface QuarantinedMessage extends MessageRecord {
  quarantine_reason: string;
  quarantined_at: number;
}

export interface CacheMetadataRecord {
  key: string;
  value: string;
}

/** High-water mark for `local_order_seq`. Account-global and monotonic; it is
 *  read, bumped and used inside one transaction, because allocating outside
 *  the write is how two tabs hand out the same number. */
/** Per-channel display-order mode, `pts` unless recorded otherwise. */

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
  group_members!: Table<GroupMemberRecord, [string, string]>;
  /** Rows evicted by an identity conflict. Never read by the timeline. */
  quarantine!: Table<QuarantinedMessage, string>;

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
        // `&server_message_id` is account-global, not per channel: a network
        // identity names one message, and the same id appearing in two
        // channels is corruption, not two messages. Per-channel uniqueness
        // could not see it — which is how a message ended up rendered in a
        // conversation it was never sent to. Channel ownership is verified
        // after the lookup instead.
        messages_v2:
          '&id, [channel_id+sort_key], &server_message_id, [channel_id+server_message_id], ' +
          '[channel_id+local_message_id], [channel_id+pts_gap], channel_id',
        quarantine: '&id, channel_id',
        // Old store stays declared so the upgrade can read it; dropped in v13.
        messages:
          '&[channel_id+record_key], &id, [channel_id+timestamp], [channel_id+server_message_id]',
      })
      .upgrade(async (tx) => {
        const oldMessages = tx.table('messages');
        const v2 = tx.table('messages_v2');
        const quarantine = tx.table('quarantine');
        const outbox = tx.table('outbox');
        const meta = tx.table('cache_metadata');

        const rows: Array<Record<string, unknown>> = await oldMessages.toArray();

        // Deterministic, repeatable numbering (SDK_ENTITY_MODEL_SPEC
        // §2.6.2.1). Per channel: while ANY confirmed row lacks pts, that
        // channel's confirmed rows are ordered by server_message_id alone —
        // a server-issued snowflake needing no local inference. Ordering them
        // by "has pts" would claim the local write path tells us the server's
        // order, which it does not. The same condition is recorded as the
        // channel's order mode, so the runtime comparator and the sort keys
        // written here stay one ordering.
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
        const ordered: Array<{ row: Record<string, unknown>; mode: ChannelOrderMode }> = [];
        for (const [cid, list] of byChannel) {
          const confirmed = list.filter(
            (r) => r.server_message_id !== undefined && r.server_message_id !== '',
          );
          const pendingRows = list.filter(
            (r) => r.server_message_id === undefined || r.server_message_id === '',
          );
          const anyMissingPts = confirmed.some(
            (r) => r.pts === undefined || r.pts === '',
          );
          const mode: ChannelOrderMode = anyMissingPts ? 'server_id' : 'pts';
          confirmed.sort((a, b) =>
            mode === 'server_id'
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
          for (const row of [...confirmed, ...pendingRows]) ordered.push({ row, mode });
          if (mode === 'server_id') {
            await meta.put({ key: orderModeKey(cid), value: mode });
          }
        }

        /** Which local row currently holds each network id, so a second
         *  claimant can be recognised before the unique index rejects it —
         *  a ConstraintError inside an upgrade aborts the whole thing and
         *  leaves the database unopenable. */
        const holderBySmid = new Map<string, Record<string, unknown>>();
        const idByOldKey = new Map<string, string>();
        /** Old id → surviving id, for rows merged or quarantined below. */
        const redirect = new Map<string, string>();

        /** More complete wins: a row with pts, then one with a local id
         *  (ours, i.e. the one the UI and outbox point at), then the earlier
         *  one. */
        const completeness = (r: Record<string, unknown>): number =>
          (r.pts !== undefined && r.pts !== '' ? 2 : 0) +
          (r.local_message_id !== undefined ? 1 : 0);

        for (const { row: r, mode } of ordered) {
          seq += 1;
          const id = String(r.id ?? nextLocalMessageRecordId());
          const channel_id = String(r.channel_id ?? '');
          const { record_key, ...rest } = r as { record_key?: string };
          if (record_key !== undefined) {
            idByOldKey.set(`${channel_id}|${record_key}`, id);
          }
          const smid =
            r.server_message_id === undefined || r.server_message_id === ''
              ? undefined
              : String(r.server_message_id);

          if (smid !== undefined) {
            const held = holderBySmid.get(smid);
            if (held !== undefined) {
              // Same channel: one message that got written twice. Keep the
              // more complete row and point everything at it.
              if (String(held.channel_id ?? '') === channel_id) {
                if (completeness(r) > completeness(held)) {
                  // The incoming row wins: retire the one already written.
                  const heldId = String(held.id);
                  await v2.delete(heldId);
                  redirect.set(heldId, id);
                  holderBySmid.set(smid, r);
                } else {
                  redirect.set(id, String(held.id));
                  continue;
                }
              } else {
                // Different channels claiming one network identity. There is
                // no correct merge — keep the first and preserve the other
                // as evidence rather than deleting a user's message.
                await quarantine.put({
                  ...(rest as Record<string, unknown>),
                  id,
                  quarantine_reason: `server_message_id ${smid} already held by row ${String(held.id)} in channel ${String(held.channel_id ?? '')}`,
                  quarantined_at: Date.now(),
                });
                redirect.set(id, String(held.id));
                continue;
              }
            } else {
              holderBySmid.set(smid, r);
            }
          }

          const migrated = { ...rest, id, local_order_seq: seq } as MessageRecord;
          await v2.put({
            ...migrated,
            sort_key: displaySortKey(migrated, mode),
            pts_gap: hasPtsGap(migrated) ? 1 : 0,
          });
        }
        await meta.put({ key: LOCAL_ORDER_SEQ_KEY, value: String(seq) });

        // Outbox references, in the same transaction. Every command must come
        // out of this upgrade either linked to a message row or explicitly
        // marked unrecoverable — a command with no link is not a neutral
        // state: `resolvePending` treats it as damaged data on every single
        // flush, forever, and the user sees a send that neither completes nor
        // fails.
        const commands: Array<Record<string, unknown>> = await outbox.toArray();
        for (const o of commands) {
          const outbox_id = String(o.outbox_id);
          const channel_id = String(o.channel_id ?? '');
          const local_message_id =
            o.local_message_id === undefined ? undefined : String(o.local_message_id);

          /** A command may only point at the message of its own send. */
          const owns = (row: Record<string, unknown> | undefined): boolean =>
            row !== undefined &&
            String(row.channel_id ?? '') === channel_id &&
            row.local_message_id === local_message_id;

          // 1. An existing link, but only if it still resolves to THIS send.
          //    A stale one is worse than none: the ack lands on another row.
          if (o.message_id !== undefined) {
            const target = redirect.get(String(o.message_id)) ?? String(o.message_id);
            const named = await v2.get(target);
            if (owns(named as Record<string, unknown> | undefined)) {
              if (target !== o.message_id) await outbox.update(outbox_id, { message_id: target });
              continue;
            }
          }

          // 2. The old primary key it was written with, translated once while
          //    the mapping still exists.
          const viaKey = idByOldKey.get(`${channel_id}|${String(o.record_key ?? '')}`);
          const byKey = viaKey === undefined ? undefined : await v2.get(viaKey);
          if (owns(byKey as Record<string, unknown> | undefined)) {
            await outbox.update(outbox_id, { message_id: viaKey });
            continue;
          }

          // 3. The send's own idempotency key. An acked row was rekeyed
          //    `l:` → `s:`, so its command's record_key points at nothing —
          //    precisely the commands this rescues.
          if (local_message_id !== undefined) {
            const byLocal = await v2
              .where('[channel_id+local_message_id]')
              .equals([channel_id, local_message_id])
              .first();
            if (byLocal !== undefined) {
              await outbox.update(outbox_id, { message_id: String(byLocal.id) });
              continue;
            }
          }

          // 4. The row is gone. Rebuild it where the payload can — the
          //    command carries the whole body for text and system messages,
          //    so the message the user sent is recoverable exactly.
          const entry = o as unknown as OutboxEntry;
          if (isRebuildableFromPayload(String(o.content_type ?? ''))) {
            seq += 1;
            const rebuilt: MessageRecord = {
              id: nextLocalMessageRecordId(),
              channel_id,
              channel_type: Number(o.channel_type ?? 0),
              local_message_id,
              from_uid: String(o.from_uid ?? ''),
              message_type: String(o.content_type ?? 'text'),
              content: decodeRebuildableContent(entry),
              payload: entry.payload,
              timestamp: Number(o.created_at ?? Date.now()),
              status: 'pending',
              local_order_seq: seq,
            };
            await v2.put({
              ...rebuilt,
              sort_key: displaySortKey(rebuilt, 'pts'),
              pts_gap: 0,
            });
            await meta.put({ key: LOCAL_ORDER_SEQ_KEY, value: String(seq) });
            await outbox.update(outbox_id, { message_id: rebuilt.id });
            continue;
          }

          // 5. Media and structured cards: the payload depends on a local
          //    file or on metadata this row never carried, so rebuilding
          //    would produce a bubble that can never load. Mark it for the
          //    host repair path — a state the UI can act on, unlike silence.
          await outbox.update(outbox_id, {
            message_id: undefined,
            status: 'local_data_error',
            last_error:
              'local message row lost; a ' +
              String(o.content_type ?? 'media') +
              ' payload cannot rebuild it',
            updated_at: Date.now(),
          });
        }
      });

    // v13: the old store has served its purpose.
    this.version(13).stores({ messages: null });

    // v14 (CHANNEL_SPEC §9.2.2 / SDK_ENTITY_MODEL §2.4): local group roster.
    //
    // Until now web/h5 asked the server for the roster every time a member
    // list opened — 126 KB for a 750 member group — while the App had been
    // reading a local projection and syncing incrementally for a long time.
    // This store closes that gap: the compound primary key mirrors the
    // entity model's `PRIMARY KEY (group_id, user_id)`, `group_id` indexes
    // the per-group page read, and `sync_version` is the monotonic guard
    // that keeps a stale response from overwriting a newer row.
    //
    // Only relation fields live here. `display_name` is computed at read
    // time by joining the `users` store (SDK_ENTITY_MODEL §2.4 forbids
    // denormalising it into the relation row) so a profile update shows up
    // without rewriting every member row.
    this.version(14).stores({
      group_members: '[group_id+user_id], group_id, sync_version',
    });

  }
}
