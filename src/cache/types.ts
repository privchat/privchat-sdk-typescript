// Cache record shapes for Phase 4. Mirrors the Rust `privchat-sdk`
// terminology where it exists: `pts` for the per-channel sequence,
// `server_message_id` and `local_message_id` as distinct identities
// (the TS web cache has no equivalent of Rust SDK's local DB primary
// `message_id`, so that field is intentionally absent here).
//
// Authority rules (don't move):
//   - server pts always wins on conflict; cache is read-through, not authoritative
//   - IndexedDB rows are wipeable + re-populatable from the server
//   - read_pts is a per-user/per-channel high-water mark, not a list of read ids

import { decodeMessagePayloadEnvelope } from '../codec/payload.js';
import type { PushMessageRequest } from '../codec/push.js';
import { contentTypeFromWireTag } from '../content-type.js';
import { normalizeMessageDisplayContent } from '../message-content.js';

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
 * Sort key: `timestamp` (server ms wall-clock for received rows;
 * `Date.now()` for pending rows). Snowflakes are roughly time-ordered
 * but timestamp is the authoritative sort key for UI display.
 */
export interface MessageRecord {
  channel_id: IdString;
  channel_type: number;
  /** Server-assigned snowflake (= Rust SDK's `server_message_id`).
   *  Undefined while a sent message is still pending ACK. */
  server_message_id?: IdString;
  /** Client snowflake from sendTextMessage (= Rust SDK's `local_message_id`).
   *  Undefined for purely-inbound history / push records. */
  local_message_id?: IdString;
  /** Per-channel server pts. Populated from `PushMessageRequest.message_seq`
   *  on inbound push, or `SendMessageResponse.message_seq` after a local
   *  send is ACKed. Undefined for history rows (server's history wire
   *  doesn't emit pts) and for pending rows (no ACK yet). */
  pts?: IdString;
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
export type OutboxStatus = 'pending' | 'sending' | 'failed';

/** One outgoing message awaiting (or having failed) server ACK.
 *
 * Identity:
 *   - `outbox_id` is the stable primary key. In 5C it equals
 *     `local_message_id`; the field exists separately so future code
 *     can introduce a different identity (e.g. UUID) without rewriting
 *     callers.
 *   - `local_message_id` is the canonical idempotency key against the
 *     server's dedup service. Marked unique at the schema level so the
 *     same client cannot enqueue the same logical message twice.
 *   - `record_key` is the cache MessageRecord's record_key (e.g.
 *     `"l:<local_message_id>"`) — denormalised so the engine can join
 *     to the in-memory cache without recomputing.
 */
export interface OutboxEntry {
  outbox_id: IdString;
  record_key: string;
  channel_id: IdString;
  channel_type: number;
  local_message_id: IdString;
  from_uid: IdString;
  /** Application content type ("text" / "image" / ...). The flush path
   *  maps this to the wire `MessageType` numeric tag at send time. */
  content_type: string;
  /** Encoded message payload bytes (FlatBuffers-side ready). For text
   *  this is `TextEncoder().encode(content)`. */
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
  /** Internal record_keys (see `messageRecordKey`) of records that were
   *  removed from the buffer (revoke / pending → sent ACK swap). */
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
export function messageRecordKey(record: MessageRecord): string {
  if (record.server_message_id !== undefined) {
    return `s:${record.server_message_id}`;
  }
  if (record.local_message_id !== undefined) {
    return `l:${record.local_message_id}`;
  }
  throw new Error('MessageRecord must have either server_message_id or local_message_id');
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
  return {
    channel_id: push.channel_id,
    channel_type: push.channel_type,
    server_message_id: push.server_message_id,
    local_message_id:
      push.local_message_id !== '0' ? push.local_message_id : undefined,
    pts: String(push.message_seq),
    from_uid: push.from_uid,
    // Canonical word form ('text' / 'image' / …) — same representation
    // the history / sync paths store, so dedup comparisons and consumers
    // see ONE representation regardless of ingest path. (Legacy rows
    // persisted as decimal strings are still understood by decoders.)
    message_type: contentTypeFromWireTag(push.message_type),
    content: extractPushContent(push),
    payload: push.payload,
    timestamp: push.timestamp * 1000, // PushMessageRequest.timestamp is seconds
    status: 'received',
    revoked: push.deleted,
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
