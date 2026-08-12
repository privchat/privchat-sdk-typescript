// IndexedDB OPERATIONS — free functions over an injected `CacheDB`
// instance. Deliberately dexie-free at runtime: `CacheDB` is imported as a
// TYPE only, so these functions can sit on the main entry without dragging
// dexie into every consumer's bundle. The class itself (and the dexie
// dependency) lives in `idb-schema.ts`, exported via `@privchat/sdk/cache-idb`.

import type { CacheDB, StoredMessage } from './idb-schema.js';
import {
  CACHE_OWNER_KEY,
  LOCAL_ORDER_SEQ_KEY,
  orderModeKey,
} from './idb-keys.js';
export type { CacheDB } from './idb-schema.js';
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
    const modes = new Map<string, ChannelOrderMode>();
    for (const record of records) {
      let mode = modes.get(record.channel_id);
      if (mode === undefined) {
        mode = await getChannelOrderMode(db, record.channel_id);
        modes.set(record.channel_id, mode);
      }
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
      // 发送时间按**精度**合并，不按到达顺序：一条消息的发送时间在服务端是不变量，
      // 所以唯一合法的分歧是分辨率（push 只有秒，history/sync 有毫秒）。低精度永不
      // 覆盖高精度，否则 history 拿到的 .317 会被随后到达的 push 改成 .000。
      const time = mergeSentAt(
        existing === undefined
          ? undefined
          : {
              ms: existing.timestamp,
              precision: existing.timestamp_precision ?? 'milliseconds',
            },
        {
          ms: record.timestamp,
          precision: record.timestamp_precision ?? 'milliseconds',
        },
      );
      if (time.conflict) {
        // 同精度但值不同 = 某一端的数据坏了。保留先到的，别让 replay 覆盖，
        // 但要留下痕迹：静默地二选一是这类问题查不出来的原因。
        console.warn(
          `[privchat] send time conflict for server_message_id=${record.server_message_id}: ` +
            `${existing?.timestamp} vs ${record.timestamp}`,
        );
      }
      // 一条已有的行被再次写入时，只有**带正文的**写入才有资格改动展示字段。
      //
      // 这里原来是 `{...record, id: existing?.id ?? record.id}`：身份保住了，其余
      // 字段一律被 incoming 覆盖。状态推送（同一 server_message_id、空 payload、
      // from_uid 是确认方）走到这里就把用户自己那条消息的正文清空、作者改成对方、
      // 状态从 sent 退回 received——2026-07-29 web/H5「发出去就消失」的持久层成因。
      //
      // 与内存侧 `mergeOnPushAbsorb` 同一条规则：**再次写入可以补充事实，不能抹掉
      // 事实**。两处都要有，因为两处都能单独把行写坏。
      // 只认**非空正文**。不能把「有 payload」当成「有消息体」：状态推送同样带
      // payload（那是状态信封，不是消息内容），实测就是它绕过了第一版守卫，
      // 把正文擦成空、作者改成确认方。
      const incomingHasBody = record.content !== undefined && record.content !== '';
      const keepDisplay = existing !== undefined && !incomingHasBody;
      const merged: MessageRecord = {
        ...record,
        id: existing?.id ?? record.id,
        content: keepDisplay ? existing.content : record.content,
        payload:
          keepDisplay || (existing !== undefined && (record.payload?.length ?? 0) === 0)
            ? (existing?.payload ?? record.payload)
            : record.payload,
        message_type: keepDisplay ? existing.message_type : record.message_type,
        from_uid: keepDisplay ? existing.from_uid : record.from_uid,
        // 状态只前进：已确认发出的行不得被推送的默认 'received' 拉回去。
        status:
          existing !== undefined &&
          (existing.status === 'sent' || existing.status === 'pending') &&
          !incomingHasBody
            ? existing.status === 'pending'
              ? record.status
              : 'sent'
            : record.status,
        // 撤回是单调的。
        revoked:
          existing?.revoked === true || record.revoked === true
            ? true
            : record.revoked,
        timestamp: time.ms,
        timestamp_precision: time.precision,
        local_order_seq:
          existing?.local_order_seq ?? record.local_order_seq ?? (next += 1),
      };
      const stamped = stamp(merged, mode);
      // The row may be moving off a key another row holds (pending row that
      // just gained its server id). Delete by the old primary key first so
      // the unique index does not see two.
      if (existing !== undefined && existing.id !== stamped.id) {
        await db.messages_v2.delete(existing.id);
      }
      await db.messages_v2.put(stamped);
      out.push(stamped);
    }
    // Modes last, once the rows are in: a channel that just received its
    // first pts-less confirmed row degrades here, and one whose gaps sync
    // just filled comes back to pts order. Same transaction, so the keys and
    // the flag can never be observed disagreeing.
    const finalModes = new Map<string, ChannelOrderMode>();
    for (const cid of modes.keys()) finalModes.set(cid, await reconcileOrderMode(db, cid));
    // Re-read anything a mode change rewrote, so callers get the keys that
    // are actually on disk.
    return Promise.all(
      out.map(async (row) =>
        finalModes.get(row.channel_id) === modes.get(row.channel_id)
          ? strip(row)
          : strip((await db.messages_v2.get(row.id)) ?? row),
      ),
    );
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

/**
 * One network identity is claimed by two channels.
 *
 * There is no correct merge: the message belongs to one conversation, and
 * writing it into the other would put someone's message in a conversation it
 * was never sent to. The write is refused so the caller — and the bug that
 * produced it — surfaces, rather than the database quietly holding a lie.
 */
export class ServerMessageIdConflictError extends Error {
  constructor(
    readonly server_message_id: string,
    readonly held_by_channel_id: string,
    readonly attempted_channel_id: string,
  ) {
    super(
      `server_message_id ${server_message_id} already belongs to channel ${held_by_channel_id}; ` +
        `refusing to also write it into ${attempted_channel_id}`,
    );
    this.name = 'ServerMessageIdConflictError';
  }
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
    // Global lookup, then verify the channel. The index is account-wide
    // because a network id names exactly one message; searching only within
    // the channel would let the same id be admitted a second time elsewhere,
    // and the write would then fail against the unique index with a
    // ConstraintError far from the cause. Finding it in ANOTHER channel is
    // not a match — it is the conflict, and it is raised as one.
    const bySmid = await db.messages_v2
      .where('server_message_id')
      .equals(record.server_message_id)
      .first();
    if (bySmid !== undefined) {
      if (bySmid.channel_id !== record.channel_id) {
        throw new ServerMessageIdConflictError(
          record.server_message_id,
          bySmid.channel_id,
          record.channel_id,
        );
      }
      return bySmid;
    }
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
    const stamped = stamp(merged, await getChannelOrderMode(db, acked.channel_id));

    // Absorb whichever row we did not keep. One logical message, one row.
    for (const row of [local, remote]) {
      if (row !== undefined && row.id !== stamped.id) {
        await db.messages_v2.delete(row.id);
      }
    }
    await db.messages_v2.put(stamped);
    const mode = await reconcileOrderMode(db, acked.channel_id);
    return strip((await db.messages_v2.get(stamped.id)) ?? stamp(merged, mode));
  });
}

/**
 * Create the local echo and its outbox command in ONE transaction.
 *
 * This is the Command-First invariant (MESSAGE_SPEC §8.3, SYNC_SPEC §3.3),
 * and it is the whole reason the outbox lives in the same database as the
 * message. Written separately, a crash between them leaves either:
 *
 *   - a message row with no command — permanently "sending", with nothing
 *     that will ever send it; or
 *   - a command with no message — the ack has no row to land on.
 *
 * Neither is recoverable from inside the client, which is why the write is
 * not allowed to be two steps. The send attempt happens strictly after this
 * commits: a message that reaches the wire but not the disk is one the ack
 * cannot be applied to.
 */
export async function createLocalMessageQueued(
  db: CacheDB,
  message: MessageRecord,
  command: OutboxEntry,
): Promise<MessageRecord> {
  return db.transaction(
    'rw',
    db.messages_v2,
    db.outbox,
    db.cache_metadata,
    async () => {
      const seq = (await allocateOrderSeq(db, 1)) + 1;
      const stored = stamp(
        { ...message, local_order_seq: seq },
        await getChannelOrderMode(db, message.channel_id),
      );
      await db.messages_v2.add(stored);
      await db.outbox.add({ ...command, message_id: stored.id });
      return strip(stored);
    },
  );
}

/**
 * Apply the ACK and retire the command in ONE transaction.
 *
 * The pair has to be atomic for the same reason as the enqueue: a committed
 * ack with a surviving command re-sends a delivered message, and a retired
 * command with an unapplied ack loses it.
 */
export async function commitAck(
  db: CacheDB,
  acked: MessageRecord,
  outbox_id: string,
): Promise<MessageRecord> {
  return db.transaction(
    'rw',
    db.messages_v2,
    db.outbox,
    db.cache_metadata,
    async () => {
      const durable = await applyAck(db, acked);
      await db.outbox.delete(outbox_id);
      return durable;
    },
  );
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
  const cursor =
    typeof before === 'string'
      ? before
      : displaySortKey(before, await getChannelOrderMode(db, channel_id));
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

// ----- Internal: derived-column stamping -----

function stamp(record: MessageRecord, mode: ChannelOrderMode): StoredMessage {
  return {
    ...record,
    sort_key: displaySortKey(record, mode),
    pts_gap: hasPtsGap(record) ? 1 : 0,
  };
}

function strip(stored: StoredMessage): MessageRecord {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { sort_key: _s, pts_gap: _g, ...rest } = stored;
  return rest;
}

/**
 * The mode this channel's persisted `sort_key`s were written under.
 *
 * Read inside the caller's transaction — a mode read outside the write it
 * governs is a mode that can change before the row lands, which is how a
 * single row ends up keyed differently from the rest of its channel.
 */
export async function getChannelOrderMode(
  db: CacheDB,
  channel_id: string,
): Promise<ChannelOrderMode> {
  const meta = await db.cache_metadata.get(orderModeKey(channel_id));
  return meta?.value === 'server_id' ? 'server_id' : 'pts';
}

/**
 * Re-decide the channel's order mode after a write, and rewrite its keys if
 * it changed.
 *
 * Both directions matter. A confirmed row with no pts (a history fetch, which
 * carries none) degrades the channel: keeping pts order would sort that row
 * ahead of the entire conversation, since a missing pts encodes as zeros.
 * And once sync has filled the gaps in, the channel must come back — pts is
 * the authoritative order and `server_message_id` only approximates it.
 *
 * The flag and the regenerated keys are one transaction with the write that
 * triggered them, so no read can observe a mode that disagrees with the keys
 * on disk. The check itself is an indexed count on `pts_gap`, not a scan; only
 * an actual transition pays for rewriting the channel.
 */
async function reconcileOrderMode(
  db: CacheDB,
  channel_id: string,
): Promise<ChannelOrderMode> {
  const current = await getChannelOrderMode(db, channel_id);
  const gaps = await db.messages_v2
    .where('[channel_id+pts_gap]')
    .equals([channel_id, 1])
    .count();
  const want: ChannelOrderMode = gaps > 0 ? 'server_id' : 'pts';
  if (want === current) return current;

  const rows = await db.messages_v2.where('channel_id').equals(channel_id).toArray();
  for (const row of rows) {
    await db.messages_v2.put({ ...row, sort_key: displaySortKey(row, want) });
  }
  await db.cache_metadata.put({ key: orderModeKey(channel_id), value: want });
  return want;
}
