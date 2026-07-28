// Cache record shapes for Phase 4. Mirrors the Rust `privchat-sdk`
// terminology where it exists: `pts` for the per-channel sequence,
// `server_message_id` and `local_message_id` as distinct identities
// Local row identity: `MessageRecord.id` is this cache's equivalent of the
// Rust SDK's SQLite `message.id` (SDK_ENTITY_MODEL_SPEC §2.6.1). It is
// generated locally, never changes across the ack, never goes on the wire,
// and is the primary key of the message store.
//
// It used to share that job with a `record_key` derived from
// `local_message_id` before the ack and `server_message_id` after — a primary
// key that moved mid-flight. Every piece of rekey, identity-conflict and
// repair machinery around the outbox existed to survive that one decision,
// and all of it went away with it.
//
// Authority rules (don't move):
//   - server pts always wins on conflict; cache is read-through, not authoritative
//   - IndexedDB rows are wipeable + re-populatable from the server
//   - read_pts is a per-user/per-channel high-water mark, not a list of read ids

import { decodeMessagePayloadEnvelope } from '../codec/payload.js';
import type { PushMessageRequest } from '../codec/push.js';
import { contentTypeFromWireTag } from '../content-type.js';
import { normalizeMessageDisplayContent } from '../message-content.js';
import { canonicalFromPush } from './canonical-inbound.js';

/** All u64-grade ids stay as decimal strings at the public boundary —
 *  snowflake IDs exceed `Number.MAX_SAFE_INTEGER` in production. */
export type IdString = string;

/**
 * Cached user profile. Single source of truth for "who is this uid" —
 * UI title resolution, message-bubble sender label, contact card all
 * read off this record.
 *
 * Hydrated from `entity/sync_entities("user")`, which returns the
 * caller's friends + every uid that appears in any joined channel
 * (members of group channels, peer of direct channels). Increments
 * by `sync_version` like every other entity sync.
 *
 * Field set is intentionally narrow:
 *   - `is_friend` is here as a flag, populated by R2.1 friendship
 *     sync (the `entity/sync_entities("user")` payload itself doesn't
 *     carry this — it's a relation, not a profile attribute). Until
 *     R2.1 lands, this stays `false` and UI ignores it.
 *   - `is_online` and `alias` (a.k.a. remark_name) are NOT here:
 *     online status is a presence dimension and alias is a friendship
 *     dimension; both will live on separate stores when wired.
 */
export interface UserRecord {
  user_id: IdString;
  username: string;
  /** Display name. Server's entity sync falls back to `username` when
   *  the user has no nickname set, so this field is effectively always
   *  populated, but we keep it optional to mirror the Kotlin DTO and
   *  stay forward-compat with future server schemas that may emit
   *  `null`. */
  nickname?: string;
  /** Profile photo URL. Server emits `avatar` on the wire; the SDK
   *  normalises to `avatar_url` here for consistency with other
   *  *_url fields and the Kotlin DTO. */
  avatar_url?: string;
  /** 0 = normal, 1 = system, 2 = bot, etc. Mirrors server config; UI
   *  uses this to decide whether to show "系统通知" badges on rows. */
  user_type: number;
  /**
   * Cached friendship flag. Default `false` until friend-sync is wired.
   * UI must NOT use this for "show this person as friend" decoration
   * yet — present in the schema only so R2.1 can populate it without
   * a second IndexedDB schema bump.
   */
  is_friend: boolean;
  /** Monotonic increment from `entity/sync_entities("user").items[*].version`. */
  sync_version: number;
}

/**
 * Cached group summary. Hydrated from `entity/sync_entities("group")`.
 * Exposes only the fields the UI needs at the conversation-list /
 * panel-header level. Member roster, settings, mute state, etc. live
 * elsewhere and are pulled lazily.
 */
export interface GroupRecord {
  group_id: IdString;
  name: string;
  avatar_url?: string;
  /** Best-effort cached count. Real-time membership changes flow
   *  through `group_member` entity sync (out of R2A scope). */
  member_count: number;
  sync_version: number;
}

/**
 * Cached friendship row — the relation half of a contact, separate
 * from the contact's profile (`UserRecord`). Source is
 * `entity/sync_entities("friend")`. Server filters its SQL with
 * `WHERE status != 0` so the SDK only ever sees ACCEPTED rows; pending
 * applications and blocked / unfriended rows do not land here. When
 * a friendship is deleted server-side, the next sync emits a
 * tombstone (`deleted: true`) and the local `FriendshipRecord` is
 * removed — the corresponding `UserRecord` stays put because the
 * uid may still appear in unrelated channels (group membership,
 * stranger DMs, message history).
 *
 * Field naming mirrors the wire (`alias`, NOT Kotlin's `remark`) and
 * the Rust SDK's `StoredFriend.alias`. Per the resolver priority,
 * `alias` is the highest-precedence non-system source for direct-
 * channel titles.
 */
export interface FriendshipRecord {
  /** Friend's `user_id` — equals the server's `entity_id` for this
   *  row. The current user's uid is implicit (single-account SDK). */
  user_id: IdString;
  /** Caller-set remark / nickname for this friend. Each direction is
   *  independent (the server stores `(user_id, friend_id)` per row),
   *  so this field reflects what `currentUser` typed for `friend`,
   *  not the reverse. */
  alias?: string;
  /** Friendship row created_at on the server (ms). */
  created_at: number;
  /** Friendship row updated_at on the server (ms). Bumps when the
   *  caller edits alias / pin state / etc. */
  updated_at: number;
  /** Monotonic, from `entity/sync_entities("friend").items[*].version`. */
  sync_version: number;
}

/** Stored channel summary. The unit the channel-list UI binds against. */
export interface ChannelRecord {
  channel_id: IdString;
  channel_type: number;
  title?: string;
  /** Direct-channel peer's uid (from the channel entity sync). Undefined
   *  for group channels or when the server didn't emit it. UI seeds the
   *  peer avatar and detects the system account by this uid so colors /
   *  labels match the group-collage member cells (which key off uid). */
  peer_user_id?: IdString;
  /** Latest known per-channel pts. Lifted by inbound push (push.message_seq),
   *  send-ACK on own messages, and the sync engine. NOT lifted by
   *  openConversation/scrollHistory (history wire has no pts) and NOT
   *  lifted by 20900 resync recovery. Defaults to `"0"` at bootstrap;
   *  reset to `"0"` after a SyncChannelResyncRequired-driven resync. */
  latest_pts: IdString;
  /** Per-user high-water mark from `channel_read_cursor.last_read_pts`.
   *  Defaults to `"0"` on bootstrap when the server has no cursor row
   *  for this channel (fresh account / never marked read). */
  read_pts: IdString;
  /**
   * Direct-channel peer's read cursor — the highest `pts` the OTHER
   * party has marked as read. Used by UI to project "已读" on outbound
   * messages: `from_uid===self && pts<=peer_read_pts ⇒ read_by_peer`.
   *
   * Mirrors Rust SDK's `channel_extra.peer_read_pts`. Persisted and
   * MAX-merged on inbound `peer_read_pts_updated` push. Undefined when
   * the SDK has not observed any peer read activity yet — cold-start
   * baseline (server entity sync) is a separate roadmap item.
   *
   * Group channels: not populated. Group "已读 N/M" semantics need a
   * different data shape (per-member cursors).
   */
  peer_read_pts?: IdString;
  /** Server's live channel pts as observed from a 20900 error envelope or
   *  a successful sync pass. Observability-only — host UI may use this to
   *  show "X messages may have been missed" hints. MUST NOT be consulted
   *  by merge / dedup / cursor logic. */
  server_current_pts?: IdString;
  unread_count: number;
  last_message_preview?: string;
  /** Canonical content type of the most-recent message ('text' / 'image'
   *  / 'system' / …), as resolved by `derivePreview`. The conversation-
   *  list UI shows `last_message_preview` verbatim for `text` and renders
   *  a locale-specific placeholder ("[图片]" / "[Image]") for every other
   *  type. Undefined for older cached rows written before this field
   *  existed — the UI falls back to showing `last_message_preview`. */
  last_message_type?: string;
  /**
   * `true` when the channel's most-recent message has been revoked.
   * Set by the push-absorb path when a `deleted=true` push lands AND
   * its pts equals `latest_pts`; cleared when a fresher message
   * arrives. Surfaced so the conversation-list UI can render
   * "[已撤回]" instead of the original (now stale) preview text.
   *
   * Cleared default for older cached rows (cache schema v6 didn't
   * have this field — IDB v7 migration backfills `false`).
   */
  last_message_revoked?: boolean;
  /** User pinned this channel to the top of the list. Server-side
   *  persistent — set via `channel/pin`. R6.c. */
  pinned?: boolean;
  /** User muted this channel — UI suppresses the unread badge color
   *  and skips notification ping. Server-side persistent. R6.c. */
  muted?: boolean;
  /** User hid this channel from the list. Server tombstones server-
   *  side; the local cache may still have the row briefly until the
   *  next entity sync removes it. R6.c. */
  hidden?: boolean;
  /** Last activity timestamp (server-emitted ms). Used for channel list sort. */
  updated_at: number;
  /** sync_version from entity/sync_entities; used by Phase 5 incremental sync. */
  sync_version: number;
}

/**
 * Stored message. Partial cache; the server is source of truth.
 *
 * Identity:
 *   - `server_message_id`: server-assigned snowflake. Present once the
 *     message is acked/delivered (history rows, push rows, sent rows).
 *   - `local_message_id`: client-side snowflake from sendTextMessage.
 *     Present for pending and sent rows whose origin was a local send.
 *
 * Display order (SDK_ENTITY_MODEL_SPEC §2.6.2) is the tuple
 *   (pending_group, pts, server_message_id, local_order_seq)
 * and `timestamp` is a display value only — wall clocks come from senders,
 * so ordering by one lets a skewed sender misplace its own messages
 * permanently and lets two clients render the same conversation differently.
 * Every read path uses `compareDisplayOrder` / `displaySortKey`; there is no
 * second ordering rule anywhere.
 */
export interface MessageRecord {
  /** Stable local row identity. Assigned once on insert, unchanged by the
   *  ack, never serialized to the wire. Equivalent to Rust's SQLite
   *  `message.id`; the two SDKs agree on semantics and decimal encoding, not
   *  on the value. Use it — never `local_message_id` — as the
   *  projection/dependency identity of a message. */
  id: IdString;
  channel_id: IdString;
  channel_type: number;
  /** Server-assigned snowflake (= Rust SDK's `server_message_id`).
   *  Undefined while a sent message is still pending ACK. */
  server_message_id?: IdString;
  /** Client snowflake from sendTextMessage (= Rust SDK's `local_message_id`).
   *  Undefined for purely-inbound history / push records. */
  local_message_id?: IdString;
  /** Per-channel server pts — the authoritative display order
   *  (SDK_ENTITY_MODEL_SPEC §2.6.2). Populated from
   *  `PushMessageRequest.message_seq` on inbound push,
   *  `SendMessageResponse.message_seq` after a local send is ACKed, and
   *  `HistoricalMessage.message_seq` on history (an earlier comment here
   *  claimed history carries no pts; it does, and
   *  `historicalMessageToRecord` has always written it). Undefined only for
   *  pending rows, which have no ACK yet and sort ahead of everything. */
  pts?: IdString;
  /** Local, persistent, monotonic insertion order (SDK_ENTITY_MODEL_SPEC
   *  §2.6.2.1). Storage ordering only — never on the wire, never across
   *  devices, no part in dedupe or identity.
   *
   *  It exists because `id` cannot serve as the tiebreaker here: this SDK's
   *  is 128 random bits, so consecutive pending sends would come out
   *  shuffled. Rust's is a monotonic rowid and needs no extra column. */
  local_order_seq?: number;
  from_uid: IdString;
  /** Application content type ("text" / "image" / "voice" / ...). String
   *  form mirrors Rust SDK conventions; for FlatBuffers numeric tags use
   *  the `MessageType` enum. */
  message_type: string;
  /** Display content (text body or media caption). */
  content: string;
  /** Raw FlatBuffers payload bytes from PushMessageRequest, or empty
   *  for records reconstructed from message/history/get (which carries
   *  parsed `content` + metadata, not raw payload). */
  payload: Uint8Array;
  /** Wall-clock timestamp (ms). Server-emitted for received rows;
   *  `Date.now()` for local-echo pending rows. Used as the sort key. */
  timestamp: number;
  /** Client-side delivery state. */
  status: MessageStatus;
  revoked?: boolean;
  mime_type?: string;
}

export type MessageStatus =
  | 'received'
  | 'pending'
  | 'sent'
  | 'failed';

// ============================================================
// Outbox (Phase 5C)
// ============================================================
//
// Persistent durability for outgoing messages. The outbox row mirrors
// the cache MessageRecord while a send is unfinished — it is the
// source of truth for "did the server confirm this message yet?", and
// is the only thing that survives a tab reload.
//
// Persisted statuses are intentionally narrow (3 states). The wider
// set surfaced via the L1 `outbox_state_changed` event includes the
// transient outcomes (`sent`, `discarded`) — but those rows are deleted
// before/at emit time and never persist.

/** Persisted outbox row state. See PHASE5C_OUTBOUND_QUEUE_PLAN.md. */
/**
 * Outbox row lifecycle.
 *
 * `ack_pending` and `integrity_error` both mean **the server already has
 * this message**; only the local commit is outstanding. Neither may go back
 * on the wire — re-sending a delivered message is how one send becomes two
 * messages. They are distinct because the recovery differs: `ack_pending`
 * retries the local write, `integrity_error` cannot be fixed by retrying
 * at all and needs cache repair.
 */
export type OutboxStatus =
  | 'pending'
  | 'sending'
  | 'failed'
  /** Delivered; the local ACK commit failed and will be retried locally. */
  | 'ack_pending'
  /** Delivered; the local commit hit an integrity fault. A repair pass
   *  retries it; see `repair_attempts`. */
  | 'integrity_error'
  /** Delivered, and repair gave up. The message is on the server but this
   *  device cannot reconcile it — surface it as broken local data, never
   *  as an endless "syncing". */
  | 'local_data_error';

/** One outgoing message awaiting (or having failed) server ACK.
 *
 * Identity (SDK_ENTITY_MODEL_SPEC §2.6.1):
 *   - `outbox_id` is the command's primary key. It equals
 *     `local_message_id`, and that is correct: a send command *is*
 *     identified by the idempotency key the server dedupes on.
 *   - `local_message_id` is that same idempotency key against the
 *     server's dedup service. Unique at the schema level so the same
 *     client cannot enqueue the same logical message twice.
 *   - `message_id` is the **stable** `MessageRecord.id` this command
 *     will deliver. This is the link to the message, and it never
 *     changes. Optional only because rows written before v11 predate
 *     the field; new rows always carry it.
 *   - `record_key` is the legacy join key, kept for those pre-v11 rows.
 *     Do not reach for it in new code: it is derived from
 *     `local_message_id` before the ACK and from `server_message_id`
 *     after, so it *changes mid-flight* — joining on it means joining
 *     on a moving target, which is what the repair machinery around
 *     this engine exists to survive.
 */
export interface OutboxEntry {
  outbox_id: IdString;
  /** Stable `MessageRecord.id` of the message this command delivers. */
  message_id: IdString;
  channel_id: IdString;
  channel_type: number;
  local_message_id: IdString;
  from_uid: IdString;
  /** Application content type ("text" / "image" / ...). The flush path
   *  maps this to the wire `MessageType` numeric tag at send time. */
  content_type: string;
  /** How `payload` is encoded — recorded at enqueue, never inferred.
   *
   *  Text is not one encoding: plain text goes as raw UTF-8, but the moment
   *  it carries a reply or a mention the send path wraps it in the same
   *  FlatBuffers envelope media uses. Recovery used to guess by trying to
   *  decode and checking whether the body came out non-empty, which is not a
   *  sound test — FlatBuffers reads arbitrary bytes without complaint, and a
   *  legitimately empty body is indistinguishable from a failed parse. The
   *  send path knows which branch it took, so it says so.
   *
   *  `legacy_unknown` is only for rows written before this field existed. */
  payload_encoding?: 'raw_utf8' | 'message_envelope' | 'legacy_unknown';
  /** Encoded message payload bytes (FlatBuffers-side ready). */
  payload: Uint8Array;
  /** Wall-clock at first enqueue. Drives per-channel FIFO ordering. */
  created_at: number;
  /** Wall-clock of the last state mutation. */
  updated_at: number;
  /** Number of completed send attempts (success-or-fail). 0 = never tried. */
  attempt_count: number;
  /** Earliest wall-clock at which the next attempt is allowed. 0 means
   *  "due now". Engine uses this for backoff scheduling. */
  next_attempt_at: number;
  /** Optional error description from the most recent failed attempt.
   *  Free-form for now; 5C-1c may upgrade this to a structured kind. */
  last_error?: string;
  /**
   * Attempts that reached the server successfully but could not be
   * committed locally (the ACK rekey + row delete transaction failed).
   *
   * Counted apart from `attempt_count` on purpose: that budget exists to
   * stop retrying a send the server keeps refusing, and freezing the row
   * at `maxAttempts` is the right end state for it. A local storage
   * failure is the opposite situation — the message IS delivered — so
   * spending the send budget on it would eventually freeze a message that
   * was successfully sent, leaving it stuck locally forever.
   */
  local_commit_failures?: number;
  /** Server identity captured when the send was acknowledged. Present from
   *  `ack_pending` onwards so recovery can re-apply the ACK **without going
   *  back to the network** — the message is already delivered. */
  acked_server_message_id?: IdString;
  acked_message_seq?: number;
  /**
   * Owner of the current `sending` attempt, and when that ownership
   * expires.
   *
   * `sending` is otherwise a state nothing can leave: the due query skips
   * it, so a tab that crashed between marking the row and finishing the
   * send would strand the message forever. The lease bounds that — once it
   * expires the row becomes claimable again, and the retry reuses the same
   * `local_message_id` so the server dedupes it.
   *
   * It is also what stops two tabs sending the same row: claiming is a
   * compare-and-set inside one IndexedDB transaction, so exactly one wins.
   */
  lease_token?: string;
  lease_until?: number;
  /** Repair passes spent on an `integrity_error` row before giving up. */
  repair_attempts?: number;
  /**
   * What went wrong, in enough detail to repair it after a restart.
   *
   * A repair pass that only knows "this row is broken" and which channel
   * it belongs to cannot fix an id collision: the row holding the id lives
   * in a *different* conversation, and re-syncing this one will never
   * touch it.
   */
  repair_kind?: 'identity_conflict' | 'message_rehydrate';
  /** Local id that could not be written because another row owns it. */
  conflicting_id?: IdString;
  /** Where that other row lives — never modified by repair, only reported. */
  conflicting_channel_id?: IdString;
  /** Repair ownership, same discipline as the send lease. */
  repair_lease_token?: string;
  repair_lease_until?: number;
  /** Earliest wall-clock for the next repair pass (exponential backoff). */
  repair_next_attempt_at?: number;
  status: OutboxStatus;
}

/**
 * What window of message history is locally loaded for a channel.
 * Bounds use `timestamp` (always present); `latest_pts` is server-pts
 * that lives in ChannelRecord — Phase 5 sync engine fills it.
 */
export interface SyncStateRecord {
  channel_id: IdString;
  channel_type: number;
  /** Lowest cached message timestamp (ms). */
  min_loaded_at?: number;
  /** Highest cached message timestamp (ms). */
  max_loaded_at?: number;
  /** Phase 5 PTS engine populates this; Phase 4 leaves it undefined. */
  latest_pts?: IdString;
  last_sync_at: number;
}

// ----- Observer API -----

/** What `observeConversation` callbacks receive. */
export interface ConversationSnapshot {
  channel_id: IdString;
  channel_type: number;
  /** Sorted ascending by `timestamp` (oldest first). */
  messages: MessageRecord[];
  /** True if the snapshot reflects a server response. False for cache /
   *  local-echo emits. */
  is_remote: boolean;
}

/** Patch granularity — emitted alongside snapshot for diff-aware UI. */
export interface ConversationPatch {
  channel_id: IdString;
  channel_type: number;
  /** Inserted or content-changed records. */
  upserted: MessageRecord[];
  /** `MessageRecord.id`s removed from the buffer (revoke, or a window
   *  replace that dropped a row). The ack no longer removes anything: it
   *  updates the row in place, because the id does not change. */
  removed: string[];
  /** Whether this patch came from a remote RPC / push (true) vs
   *  cache / local-echo (false). */
  is_remote: boolean;
}

// ----- Identity helpers -----

/**
 * Internal identity key for a MessageRecord. Used by the in-memory store
 * for dedup and by IndexedDB as the primary key. Prefers `server_message_id`
 * once available; falls back to `local_message_id` for pending records.
 *
 * NOT a public business concept — consumers should query/observe by
 * `server_message_id` / `local_message_id` directly. The key is only
 * exposed in `ConversationPatch.removed` so observers can discard rows
 * that were swapped (e.g. pending → sent).
 */
/**
 * Mint a local row identity for a message.
 *
 * 128 random bits rendered as decimal. Decimal because the two SDKs agree
 * on the encoding of `MessageRecord.id` (spec §3.3); random because the
 * generator has no usable coordination scope on the web. A clock+counter
 * scheme is per-JS-context, and this SDK runs in several at once —
 * multiple tabs of the same account, plus workers, plus a fresh context
 * after every reload. Two of them starting inside the same millisecond
 * would mint the same id and silently merge two unrelated rows, or fail
 * the unique index. Random 128-bit collides at a probability no schedule
 * of tabs can reach.
 *
 * The id carries no ordering. Nothing may sort by it — use `pts` /
 * `timestamp`. It exists to be a name that never changes, including
 * across the ACK, so pending dependencies and projections keep pointing
 * at the same row.
 */
export function nextLocalMessageRecordId(): IdString {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  let value = 0n;
  for (const b of bytes) value = (value << 8n) | BigInt(b);
  return value.toString();
}

/** Fixed-width encoding for storage sort keys (SDK_ENTITY_MODEL_SPEC
 *  §2.6.2.2). IndexedDB compares compound index members lexicographically,
 *  so a decimal string sorts "10" before "2"; 20 digits covers all of u64.
 *  The human-readable fields keep their plain decimal form. */
export const SORT_KEY_WIDTH = 20;

export function encodeSortKey(value: string | number | undefined): string {
  if (value === undefined) return '0'.repeat(SORT_KEY_WIDTH);
  const digits = String(value);
  return digits.length >= SORT_KEY_WIDTH
    ? digits
    : '0'.repeat(SORT_KEY_WIDTH - digits.length) + digits;
}

/** `0` for confirmed rows, `1` for pending — pending sorts last, i.e. at the
 *  newest end of an ascending timeline. */
export function pendingGroup(record: MessageRecord): number {
  const sid = record.server_message_id;
  return sid === undefined || sid === '' || sid === '0' ? 1 : 0;
}

/**
 * How one channel's confirmed rows are ordered.
 *
 * `pts` is the normal mode and the one the contract wants: a per-channel
 * authoritative sequence. `server_id` is the degraded fallback for a channel
 * where at least one confirmed row still has no pts — typically rows fetched
 * through `message/history/*`, which carries no pts.
 *
 * The fallback exists because pts and server_message_id are not comparable to
 * each other: a row with no pts encodes as zeros and would sort ahead of the
 * entire conversation, i.e. exactly the inversion the rule prevents. Inside a
 * degraded channel every confirmed row is keyed by server_message_id instead,
 * which is server-issued, monotonic and present on all of them.
 *
 * The mode is per channel, so the choice is uniform across every row a
 * comparison can involve — the sort key index is `[channel_id+sort_key]` and
 * the in-memory store groups by channel.
 */
export type ChannelOrderMode = 'pts' | 'server_id';

/** `true` when this row is confirmed but carries no pts, i.e. the condition
 *  that puts its channel into `server_id` mode. Persisted as `pts_gap` so the
 *  recovery check is an indexed count instead of a scan. */
export function hasPtsGap(record: MessageRecord): boolean {
  return (
    pendingGroup(record) === 0 &&
    (record.pts === undefined || record.pts === '' || record.pts === '0')
  );
}

/** The persisted compound sort key: `[pending, order, smid, seq]`, where
 *  `order` is pts or server_message_id depending on the channel's mode.
 *  Written on every row so IndexedDB can range-scan the timeline in display
 *  order without loading and re-sorting it. */
export function displaySortKey(
  record: MessageRecord,
  mode: ChannelOrderMode = 'pts',
): string {
  return [
    String(pendingGroup(record)),
    encodeSortKey(mode === 'pts' ? record.pts : record.server_message_id),
    encodeSortKey(record.server_message_id),
    encodeSortKey(record.local_order_seq),
  ].join('|');
}

/** The single comparator. Every in-memory ordering goes through it, with the
 *  same mode the persisted keys were written under — the two orderings are
 *  one ordering, and a comparator that disagreed with the index would make
 *  the timeline reshuffle the moment it was re-read from disk. */
export function compareDisplayOrder(
  a: MessageRecord,
  b: MessageRecord,
  mode: ChannelOrderMode = 'pts',
): number {
  const key = displaySortKey(a, mode);
  const other = displaySortKey(b, mode);
  return key < other ? -1 : key > other ? 1 : 0;
}

// ----- Wire helpers -----

/**
 * Convert an inbound PushMessageRequest into a cache MessageRecord.
 *
 * `pts` is populated from `push.message_seq` (the FlatBuffers wire field
 * name; same concept as Rust's `Message.pts`). `content` is decoded from
 * the FlatBuffers `MessagePayloadEnvelope` carried in `push.payload` —
 * without this step real-time push rows show up as empty bubbles in any
 * UI that reads `content`, while history-fetched rows look fine because
 * `message/history/get` returns parsed `content` directly.
 *
 * Decode failures fall back to an empty string and warn once per push so
 * the call site stays resilient against malformed/empty payloads.
 */
export function pushToMessageRecord(push: PushMessageRequest): MessageRecord {
  // 经 canonical adapter：字段搬运、metadata 提取、时间归一（push 的 timestamp 是
  // 秒）都在那里，与 history / sync / send-ack 共用，也正是门禁测试调用的实现。
  const canonical = canonicalFromPush(
    push,
    extractPushContent(push),
    contentTypeFromWireTag(push.message_type),
  );
  return {
    id: nextLocalMessageRecordId(),
    channel_id: canonical.channel_id,
    channel_type: canonical.channel_type,
    server_message_id: canonical.server_message_id,
    local_message_id: canonical.local_message_id,
    pts: canonical.pts,
    from_uid: canonical.from_uid,
    message_type: canonical.message_type,
    content: canonical.content,
    payload: canonical.payload,
    timestamp: canonical.sent_at_ms,
    status: 'received',
    revoked: canonical.revoked,
  };
}

function extractPushContent(push: PushMessageRequest): string {
  if (push.payload.length === 0) return '';

  // privchat-server currently emits JSON-stringified bytes in push.payload
  // (see `send_message_handler.rs::create_push_message_request`), not the
  // FlatBuffers `MessagePayloadEnvelope` that the protocol nominally
  // defines. Try JSON first; fall back to envelope decode if that fails so
  // we keep working once the server is fixed to honor the spec.
  //
  // The FlatBuffers parser does NOT throw on arbitrary byte sequences —
  // it dereferences offsets blindly and can return plausible-looking
  // strings from random JSON bytes. Hence the JSON-first ordering: an
  // explicit `{...}` object beats a coincidental envelope read.
  try {
    if (push.payload[0] === 0x7b /* '{' */) {
      const text = new TextDecoder().decode(push.payload);
      const obj = JSON.parse(text) as { content?: unknown };
      if (typeof obj.content === 'string') {
        return normalizeMessageDisplayContent(obj.content);
      }
    }
  } catch {
    // Not a protocol JSON envelope. Plain text is allowed to begin with
    // "{" too, so continue with the raw-text discriminator below.
  }

  // Plain text sends carry raw UTF-8 payload bytes. Do this before the
  // FlatBuffers decoder: generated FlatBuffers readers do not validate an
  // arbitrary byte slice and may return a plausible empty table instead of
  // throwing. That previously turned real-time text pushes into empty
  // bubbles until history was reloaded.
  const rawText = decodePlainTextPayload(push.payload);
  if (rawText !== undefined) {
    return normalizeMessageDisplayContent(rawText);
  }

  try {
    const envelope = decodeMessagePayloadEnvelope(push.payload);
    return normalizeMessageDisplayContent(envelope.content);
  } catch (e) {
    console.warn(
      `[privchat] failed to decode push payload for server_message_id=` +
        `${push.server_message_id} (channel_id=${push.channel_id}, ` +
        `message_type=${push.message_type}); falling back to empty content.`,
      e,
    );
    return '';
  }
}

function decodePlainTextPayload(payload: Uint8Array): string | undefined {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(payload);
  } catch {
    return undefined;
  }

  // FlatBuffers headers/tables contain NUL and other C0 control bytes.
  // Preserve the controls users can legitimately type in chat, but reject
  // binary-looking payloads so typed envelopes continue to the FB decoder.
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) {
      return undefined;
    }
  }
  return text;
}
