import {
  PacketType,
  TransportClient,
  type Transport,
  type TransportClientOptions,
  type TransportContext,
} from '@msgtrans/client';
import {
  classifyAuthErrorCode,
  parseAuthErrorPrefix,
  type AuthErrorKind,
} from './auth-error.js';
import {
  EventBus,
  type ConnectionState,
  type OutboxStateChangedEvent,
  type SdkEvent,
  type SequencedSdkEvent,
} from './events.js';
import {
  CacheDB,
  FriendshipStore,
  GroupStore,
  MessageStore,
  UserStore,
  deleteFriendships as cacheDeleteFriendships,
  deleteMessageByRecordKey as cacheDeleteMessageByRecordKey,
  deleteOutboxEntry as cacheDeleteOutboxEntry,
  getMessageWindow as cacheGetMessageWindow,
  getOutboxEntry as cacheGetOutboxEntry,
  getSyncState as cacheGetSyncState,
  listFriendships as cacheListFriendships,
  listGroups as cacheListGroups,
  listOutboxEntries as cacheListOutboxEntries,
  listUsers as cacheListUsers,
  maxFriendshipSyncVersion as cacheMaxFriendshipSyncVersion,
  maxGroupSyncVersion as cacheMaxGroupSyncVersion,
  maxUserSyncVersion as cacheMaxUserSyncVersion,
  mergeOnPushAbsorb,
  messageRecordKey,
  putOutboxEntry as cachePutOutboxEntry,
  updateOutboxStatus as cacheUpdateOutboxStatus,
  pushToMessageRecord,
  upsertChannels as cacheUpsertChannels,
  upsertFriendships as cacheUpsertFriendships,
  upsertGroups as cacheUpsertGroups,
  upsertMessage as cacheUpsertMessage,
  upsertMessages as cacheUpsertMessages,
  upsertSyncState as cacheUpsertSyncState,
  upsertUsers as cacheUpsertUsers,
  type ChannelRecord,
  type ConversationPatch,
  type ConversationSnapshot,
  type FriendshipRecord,
  type GroupRecord,
  type ListOutboxOptions,
  type MessageRecord,
  type OutboxEntry,
  type OutboxStatus,
  type UserRecord,
} from './cache/index.js';
import type {
  ChannelReadCursorNotification,
  GetDifferenceRequest,
  GetDifferenceResponse,
  HistoricalMessage,
  MarkReadRequest,
  MarkReadResult,
} from './api-types.js';
import {
  SyncEngine,
  SyncRpcError,
  SYNC_GET_DIFFERENCE_ROUTE,
  type SyncResult,
} from './sync-engine.js';
import {
  OutboxEngine,
  type OutboxEngineConfig,
  type OutboxFlushOptions,
  type OutboxFlushResult,
} from './outbox-engine.js';
import {
  decodeAuthorizationResponse,
  encodeAuthorizationRequest,
  type AuthorizationRequest,
  type AuthorizationResponse,
  type ClientInfo,
  type DeviceInfo,
} from './codec/auth.js';
import {
  decodePongResponse,
  encodePingRequest,
  type PingRequest,
  type PongResponse,
} from './codec/ping.js';
import {
  decodePushBatchRequest,
  decodePushMessageRequest,
  encodePushBatchResponse,
  encodePushMessageResponse,
  type PushBatchRequest,
  type PushMessageRequest,
} from './codec/push.js';
import {
  decodePublishRequest,
  type PublishRequest,
} from './codec/publish.js';
import { parseRpcJson } from './codec/safe-json.js';
import { derivePreview } from './preview.js';
import {
  decodeRpcResponse,
  encodeRpcRequest,
  type RpcRequest,
  type RpcResponse,
} from './codec/rpc.js';
import {
  decodeSendMessageResponse,
  encodeSendMessageRequest,
  type SendMessageRequest,
  type SendMessageResponse,
} from './codec/send.js';
import {
  decodeSubscribeResponse,
  encodeSubscribeRequest,
  type SubscribeRequest,
  type SubscribeResponse,
} from './codec/subscribe.js';
import {
  decodeTransferResponse,
  encodeTransferRequest,
  type TransferRequest,
  type TransferResponse,
} from './codec/transfer.js';
import {
  defaultClientInfo,
  defaultDeviceInfo,
  defaultProtocolVersion,
  generateLocalMessageId,
} from './defaults.js';
import { MessageType, SubscribeAction } from './message-type.js';

export interface PrivchatClientOptions
  extends Omit<TransportClientOptions, 'transport'> {
  /**
   * Pre-built transport (e.g. an in-memory test double). Mutually exclusive
   * with `url` — pass exactly one. Mirrors `TransportClientOptions.transport`
   * but typed strictly as a `Transport` instance (no string discriminator).
   */
  transport?: Transport;
  /**
   * Override the auto-detected ClientInfo used by `authenticate()`. Has no
   * effect on Layer-1 `authorize()` (caller passes the full request).
   */
  defaultClientInfo?: ClientInfo;
  /**
   * Override the auto-detected DeviceInfo used by `authenticate()`.
   * `device_id` from the call site always wins.
   */
  defaultDeviceInfo?: Omit<DeviceInfo, 'device_id'>;
  /** L1 event ring-buffer capacity for `eventsSince` / `recentEvents` (default 1024). */
  eventHistoryLimit?: number;
  /** Auto-reconnect tuning. Default: enabled, 1s → 2s → 4s → ... → 30s, infinite attempts. */
  reconnect?: ReconnectOptions;
  /** Idle-heartbeat tuning. Default: enabled, 30s idle interval, 10s ping timeout. */
  heartbeat?: HeartbeatOptions;
  /** Phase 4: opt-in IndexedDB message cache. Default: disabled. When
   *  disabled, all cache-related methods (`bootstrapChannels`,
   *  `openConversation`, `scrollHistory`, `getCachedMessages`,
   *  `observeConversation`) throw `CacheDisabledError`. Existing Phase 3
   *  callers see no behaviour change. */
  cache?: CacheOptions;
  /** Phase 5C: outbox tuning. No-op when cache is disabled. */
  outbox?: OutboxOptions;
}

export interface CacheOptions {
  enabled?: boolean;
  /** IndexedDB database name (default 'privchat'). */
  dbName?: string;
}

export interface OutboxOptions extends OutboxEngineConfig {
  /** Disable the outbox even when cache is enabled. Default: enabled
   *  whenever cache is enabled. */
  enabled?: boolean;
}

export interface ReconnectOptions {
  /** Disable auto-reconnect entirely. Default: true. */
  enabled?: boolean;
  /** First retry delay in ms (default 1000). */
  initialDelayMs?: number;
  /** Maximum retry delay in ms after exponential growth (default 30_000). */
  maxDelayMs?: number;
  /** Backoff multiplier (default 2). */
  multiplier?: number;
  /** Stop after this many consecutive failures. Default: Infinity. */
  maxAttempts?: number;
}

/**
 * Idle-heartbeat tuning. The SDK sends `PingRequest` packets while the
 * connection is `authenticated` AND has been idle for at least
 * [intervalMs]. "Idle" means no inbound or outbound packets within
 * [intervalMs]; any traffic resets the timer. A failed ping (timeout
 * or transport error) closes the transport, which triggers the
 * existing auto-reconnect path.
 *
 * Why: WebSocket connections behind NAT / corporate proxies / mobile
 * radios time out after a few minutes of silence. Periodic pings keep
 * the path warm and surface zombie connections quickly.
 *
 * Not the WebSocket control-frame ping (browser handles those
 * automatically and doesn't expose a way to send them). This is the
 * application-level `PingRequest` packet that the server expects.
 */
export interface HeartbeatOptions {
  /** Disable the idle heartbeat loop. Default: true. */
  enabled?: boolean;
  /** Idle threshold; if no traffic flows for this long, send a ping.
   *  Also the resume cadence after a ping. Default: 30_000. */
  intervalMs?: number;
  /** Maximum time to wait for a Pong before treating the connection as
   *  dead. Default: 10_000. */
  timeoutMs?: number;
}

export interface RequestOptions {
  /** Override default request timeout (ms). Pass 0 to disable. */
  timeoutMs?: number;
}

/** Wire shape of `account/auth/refresh` request body. */
export interface RefreshAccessTokenRequest {
  refresh_token: string;
  device_id: string;
}

/**
 * Wire shape of `account/auth/refresh` response body. B1 non-rotation:
 * server omits `refresh_token` and the caller keeps the original.
 */
export interface RefreshAccessTokenResult {
  access_token: string;
  expires_at: number;
  /** Present only when the server rotates (Phase B2+); undefined in B1. */
  refresh_token?: string;
}

const AUTH_REFRESH_ROUTE = 'account/auth/refresh';
const ENTITY_SYNC_ROUTE = 'entity/sync_entities';

export interface BootstrapChannelsOptions {
  /** Resume token for the channel page; default 0 = full bootstrap. */
  sinceChannelVersion?: number;
  /** Resume token for the cursor page; default 0 = full bootstrap. */
  sinceCursorVersion?: number;
  /** Page size; default 100, server caps to 1..=200. */
  limit?: number;
}

interface BootstrapEntityResponse<P> {
  items: Array<{
    entity_id: string;
    version: number;
    deleted: boolean;
    payload?: P;
  }>;
  next_version: number;
  has_more: boolean;
  min_version?: number;
}

interface BootstrapChannelPayload {
  channel_id?: number;
  channel_type?: number;
  type?: number;
  channel_name?: string;
  name?: string;
  unread_count?: number;
  last_msg_content?: string;
  last_msg_timestamp?: number;
}

interface BootstrapCursorPayload {
  channel_id?: number;
  channel_type?: number;
  type?: number;
  reader_id?: number;
  last_read_pts?: number;
  updated_at?: number;
}

/** R2A: shape of `entity/sync_entities("user")` payload items. The
 *  server emits `avatar`; the SDK normalises that to `avatar_url` at
 *  the boundary. `nickname` is server-defaulted to `username` so it's
 *  effectively always populated, but we keep both fields optional to
 *  stay forward-compat. */
interface BootstrapUserPayload {
  user_id?: number;
  uid?: number;
  username?: string;
  nickname?: string;
  avatar?: string;
  avatar_url?: string;
  user_type?: number;
  status?: number;
  updated_at?: number;
}

/** R2A: shape of `entity/sync_entities("group")` payload items. Server
 *  emits both `avatar` and `avatar_url` for backward-compat. */
interface BootstrapGroupPayload {
  group_id?: number;
  name?: string;
  description?: string;
  avatar?: string;
  avatar_url?: string;
  owner_id?: number;
  member_count?: number;
  updated_at?: number;
}

/** R2.1: `entity/sync_entities("friend")` payload. Server nests the
 *  caller-set `alias` inside `payload.user` (which also carries a
 *  snapshot of the friend's profile). The friendship-side fields
 *  (`is_pinned`, `tags`, timestamps) live at the top level. SDK
 *  flattens to `FriendshipRecord`. */
interface BootstrapFriendPayload {
  user_id?: number;
  uid?: number;
  is_pinned?: boolean;
  pinned?: boolean;
  tags?: string;
  created_at?: number;
  updated_at?: number;
  user?: {
    username?: string;
    nickname?: string;
    name?: string;
    alias?: string;
    avatar?: string;
    user_type?: number;
  };
}

function userPayloadToRecord(
  payload: BootstrapUserPayload,
  version: number,
): UserRecord | null {
  const id = payload.user_id ?? payload.uid;
  if (id === undefined) return null;
  return {
    user_id: String(id),
    username: payload.username ?? '',
    nickname:
      payload.nickname !== undefined && payload.nickname !== ''
        ? payload.nickname
        : undefined,
    avatar_url:
      payload.avatar_url !== undefined && payload.avatar_url !== ''
        ? payload.avatar_url
        : payload.avatar !== undefined && payload.avatar !== ''
          ? payload.avatar
          : undefined,
    user_type: payload.user_type ?? 0,
    is_friend: false, // populated by R2.1 friendship sync; bootstrap leaves false
    sync_version: version,
  };
}

function groupPayloadToRecord(
  payload: BootstrapGroupPayload,
  version: number,
): GroupRecord | null {
  const id = payload.group_id;
  if (id === undefined) return null;
  return {
    group_id: String(id),
    name: payload.name ?? '',
    avatar_url:
      payload.avatar_url !== undefined && payload.avatar_url !== ''
        ? payload.avatar_url
        : payload.avatar !== undefined && payload.avatar !== ''
          ? payload.avatar
          : undefined,
    member_count: payload.member_count ?? 0,
    sync_version: version,
  };
}

function friendPayloadToRecord(
  payload: BootstrapFriendPayload,
  version: number,
): FriendshipRecord | null {
  const id = payload.user_id ?? payload.uid;
  if (id === undefined) return null;
  // alias may be undefined (no remark set) or empty string (cleared
  // remark). Both collapse to undefined locally.
  const aliasRaw = payload.user?.alias;
  return {
    user_id: String(id),
    alias: aliasRaw !== undefined && aliasRaw !== '' ? aliasRaw : undefined,
    created_at: payload.created_at ?? 0,
    updated_at: payload.updated_at ?? 0,
    sync_version: version,
  };
}

interface BootstrapChannelItem {
  item: BootstrapEntityResponse<BootstrapChannelPayload>['items'][number];
  payload: BootstrapChannelPayload;
}

const DEFAULT_OPEN_LIMIT = 50;
const MARK_READ_ROUTE = 'message/status/read_pts';
/** ContentMessageType::System (privchat-protocol/src/message.rs:64). The
 *  server uses this on PushMessageRequest to flag SDK-internal sync
 *  notifications (read-cursor updates, future receipts, etc). */
const CONTENT_MESSAGE_TYPE_SYSTEM = 5;

export interface OpenConversationOptions {
  /** Max messages to fetch from the server (default 50). */
  limit?: number;
}

export interface ScrollHistoryOptions {
  /** Max messages to fetch (default 50). */
  limit?: number;
  /** Wire param `before_server_message_id` (snowflake). Defaults to the
   *  oldest in-memory record that has a `server_message_id`. */
  beforeServerMessageId?: string | number;
}

export interface MarkReadOptions {
  /** Optional message_id of the highest message the user has visually
   *  consumed; helps the server's delivery_tracker stay aligned. */
  lastReadMessageId?: string | number;
  /** Optional "I have only seen up to X" pts (clamps server's effective
   *  read position to MIN(read_pts, clientVisiblePts)). */
  clientVisiblePts?: string | number;
}

/** Result of an in-cache read-cursor MAX-merge. `advanced` discriminates
 *  whether the cache row actually moved; the L1 `read_cursor_updated`
 *  event fires only when it did. `previous_read_pts` is omitted when
 *  the channel had no prior row in the cache. */
interface ApplyReadCursorUpdateResult {
  advanced: boolean;
  previous_read_pts?: string;
  read_pts: string;
}

/**
 * Try to decode a PushMessageRequest payload as a
 * ChannelReadCursorNotification. Returns null when the payload isn't
 * valid JSON or the shape doesn't match — the SDK then treats the push
 * as a regular system message (which today means "no specific
 * handling; fall through").
 */
function tryDecodeReadCursorNotification(
  payload: Uint8Array,
): ChannelReadCursorNotification | null {
  try {
    const json = JSON.parse(new TextDecoder().decode(payload)) as unknown;
    if (typeof json !== 'object' || json === null) return null;
    const obj = json as Record<string, unknown>;
    const meta = obj['metadata'];
    if (typeof meta !== 'object' || meta === null) return null;
    const m = meta as Record<string, unknown>;
    if (m['notification_type'] !== 'channel_read_cursor_updated') return null;
    if (
      m['visibility'] !== 'self_read_pts_updated' &&
      m['visibility'] !== 'peer_read_pts_updated'
    ) {
      return null;
    }
    return json as ChannelReadCursorNotification;
  } catch {
    return null;
  }
}

/** Convert an RPC `HistoricalMessage` into a cache `MessageRecord`. */
function historicalMessageToRecord(
  msg: HistoricalMessage,
  channel_id: string,
  channel_type: number,
  /** Currently-authenticated user's id; used to decide whether a row is
   *  self-sent vs received. May be undefined when the call is made before
   *  authentication completes — in that case rows fall back to 'received'
   *  (the original conservative behaviour). */
  selfUid: string | undefined,
): MessageRecord {
  // Server's `message/history/get` now emits `message_seq` per row
  // (same value as `SendMessageResponse.message_seq` and inbound push
  // `PushMessageRequest.message_seq`). It's the per-channel pts the
  // cache needs to project `read_by_peer` correctly. Legacy rows
  // pre-dating server-side pts assignment may still come back with
  // `message_seq` undefined — we tolerate that gracefully.
  const fromUid = String(msg.sender_id);
  // Senders see their own historical rows as 'sent', not 'received' —
  // otherwise reloading the page or paging older history visually
  // demotes acked outbound messages back to "incoming". Server-side
  // delivery / read receipts (when wired through) will further promote
  // 'sent' to 'delivered' / 'read'.
  const isSelf = selfUid !== undefined && fromUid === selfUid;
  return {
    channel_id,
    channel_type,
    server_message_id: String(msg.message_id),
    from_uid: fromUid,
    message_type: msg.message_type,
    content: msg.content,
    payload: new Uint8Array(),
    timestamp: msg.timestamp,
    pts: msg.message_seq !== undefined ? String(msg.message_seq) : undefined,
    status: isSelf ? 'sent' : 'received',
    revoked: msg.revoked === true,
  };
}

/** Mirrors Rust `SessionSnapshot`. Token is intentionally NOT exposed in plaintext. */
export interface SessionSnapshot {
  user_id?: string;
  device_id?: string;
  connection_state: ConnectionState;
  has_access_token: boolean;
  last_event_sequence_id: number;
}

export interface SendTextInput {
  channel_id: string;
  channel_type: number;
  from_uid: string;
  /** Plain text content. For media variants this is the caption /
   *  fallback string used by the message-list preview. */
  content: string;
  /** Optional override; auto-generated when absent. */
  local_message_id?: string;
  /** Optional client_seq (default 0). */
  client_seq?: number;
  /** Application content-type tag (default 0 = Text). See
   *  `ContentMessageType` (Text=0, Voice=1, Image=2, Video=3, File=4,
   *  System=5, Sticker=6, ContactCard=7, Location=8, Link=9,
   *  Forward=10). */
  message_type?: number;
  /** Override the auto-computed payload bytes. Default:
   *  `TextEncoder.encode(content)`. Media / structured variants set
   *  this to a JSON-encoded `LocalMessagePayloadEnvelope` so the
   *  receiving SDK can pull `metadata` for renderer dispatch. */
  payload?: Uint8Array;
  /** Quote/reply target — the server_message_id of the original
   *  message this one replies to. When set, the SDK switches the wire
   *  payload to a JSON `LocalMessagePayloadEnvelope` so the receiver
   *  can show the quoted preview. Ignored if `payload` is also given
   *  (caller already built the envelope). */
  reply_to_message_id?: string;
  /** uids the message @-mentions. Same JSON-envelope behavior as
   *  reply_to. Ignored if `payload` is also given. */
  mentioned_user_ids?: string[];
}

/**
 * Outcome of `sendTextMessage` (Phase 5C contract). Discriminated union
 * — branch on `status`:
 *
 *   - `'sent'`: the server ACKed inline. The full `SendMessageResponse`
 *     wire object is exposed verbatim under `response`; cache row is
 *     `sent`.
 *   - `'queued'`: the call was enqueued to the persistent outbox —
 *     either because the client is offline / unauthenticated, or
 *     because a synchronous send attempt failed. `outbox_id` is the
 *     row's primary key (alias of `local_message_id` in 5C). Cache row
 *     remains `pending` (will replay later).
 *
 * The Promise rejects only when enqueue itself is impossible (cache
 * disabled AND offline, or IndexedDB write failure). Cache-disabled
 * clients keep the strict reject-on-disconnect contract because there's
 * no outbox to fall back to — for them, the result is always `'sent'`
 * (or the call rejects).
 */
export type SendTextOperationResult =
  | {
      status: 'sent';
      local_message_id: string;
      /** Raw `SendMessageRequest` ACK — `server_message_id`,
       *  `message_seq` (per-channel pts), `client_seq`, `reason_code`. */
      response: SendMessageResponse;
    }
  | {
      status: 'queued';
      local_message_id: string;
      /** Outbox row primary key. Aliases `local_message_id` in 5C. */
      outbox_id: string;
    };

export type Unsubscribe = () => void;

export class PrivchatClient {
  private readonly transport: TransportClient;
  private readonly clientInfo: ClientInfo;
  private readonly deviceInfo: Omit<DeviceInfo, 'device_id'>;
  private readonly bus: EventBus;
  private readonly reconnectOpts: Required<ReconnectOptions>;

  private state: ConnectionState = 'disconnected';
  /** Captured on successful `authenticate()` so reconnect can replay it. Cleared on disconnect(). */
  private lastAuth: { user_id: string; access_token: string; device_id: string } | null = null;
  /** Phase 4: IndexedDB cache + in-memory store. Both null when cache disabled. */
  private readonly cacheDb: CacheDB | null;
  private readonly cacheStore: MessageStore | null;
  /** R2A: user / group profile caches. Both null when cache disabled. */
  private readonly userStore: UserStore | null;
  private readonly groupStore: GroupStore | null;
  /** R2.1: friendship cache (alias / contact relation). */
  private readonly friendshipStore: FriendshipStore | null;
  /** Phase 5B-1: gap-fill sync engine. Null when cache disabled. */
  private readonly syncEngine: SyncEngine | null;
  /** Phase 5C: outbound queue engine. Null when cache or outbox disabled. */
  private readonly outboxEngine: OutboxEngine | null;
  /** Phase 5C-1e: outbox snapshot observers. Each callback is invoked
   *  with a fresh `OutboxEntry[]` snapshot on subscribe and after every
   *  outbox state mutation. */
  private readonly outboxObservers = new Set<(entries: OutboxEntry[]) => void>();
  /** Tracks whether the outbox was non-empty on the last notify pass.
   *  Drives `outbox_drained` emits on the empty-transition. */
  private outboxLastNonEmpty = false;
  /** Active subscriptions tracked by `subscribe(req)` / `subscribeChannel()`, keyed by `channel_id::channel_type`. Replayed on reconnect. */
  private readonly activeSubscriptions = new Map<string, SubscribeRequest>();
  /** Set true when caller invokes `disconnect()` so the close handler skips reconnect. */
  private userInitiatedDisconnect = false;
  /** Set true by `dispose()`; subsequent calls to `dispose()` no-op. */
  private disposed = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Resolved heartbeat options (defaults applied). */
  private readonly heartbeatOpts: Required<HeartbeatOptions>;
  /** Idle-heartbeat timer; non-null when armed. */
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  /** Monotonic-ish timestamp of the last inbound OR outbound packet. The
   *  heartbeat tick uses this to skip pings when traffic is already
   *  flowing — no need to ping a busy connection. */
  private lastActivityMs = 0;

  constructor(options: PrivchatClientOptions = {}) {
    const {
      defaultClientInfo: ci,
      defaultDeviceInfo: di,
      eventHistoryLimit,
      reconnect,
      heartbeat,
      cache,
      outbox,
      ...rest
    } = options;
    this.transport = new TransportClient({
      ...rest,
      transport: options.transport,
    });
    this.clientInfo = ci ?? defaultClientInfo();
    this.deviceInfo = di ?? omitId(defaultDeviceInfo(''));
    this.bus = new EventBus({ historyLimit: eventHistoryLimit });
    this.reconnectOpts = {
      enabled: reconnect?.enabled ?? true,
      initialDelayMs: reconnect?.initialDelayMs ?? 1_000,
      maxDelayMs: reconnect?.maxDelayMs ?? 30_000,
      multiplier: reconnect?.multiplier ?? 2,
      maxAttempts: reconnect?.maxAttempts ?? Infinity,
    };
    this.heartbeatOpts = {
      enabled: heartbeat?.enabled ?? true,
      intervalMs: heartbeat?.intervalMs ?? 30_000,
      timeoutMs: heartbeat?.timeoutMs ?? 10_000,
    };

    if (cache?.enabled) {
      this.cacheDb = new CacheDB(cache.dbName ?? 'privchat');
      this.cacheStore = new MessageStore();
      this.userStore = new UserStore();
      this.groupStore = new GroupStore();
      this.friendshipStore = new FriendshipStore();
      this.syncEngine = new SyncEngine({
        db: this.cacheDb,
        store: this.cacheStore,
        callDifference: (req) => this.callSyncGetDifference(req),
        openConversation: (cid, ct) => this.openConversation(cid, ct),
        getCurrentUserId: () => this.lastAuth?.user_id,
        emit: (event) => this.bus.emit(event),
      });
      this.outboxEngine = outbox?.enabled === false
        ? null
        : new OutboxEngine({
            db: this.cacheDb,
            store: this.cacheStore,
            sendMessage: (req) => this.sendMessage(req),
            getConnectionState: () => this.state,
            config: {
              initialDelayMs: outbox?.initialDelayMs,
              maxDelayMs: outbox?.maxDelayMs,
              maxAttempts: outbox?.maxAttempts,
            },
            hooks: {
              onStateChanged: (event) => this.onOutboxMutation(event),
            },
          });
    } else {
      this.cacheDb = null;
      this.cacheStore = null;
      this.userStore = null;
      this.groupStore = null;
      this.friendshipStore = null;
      this.syncEngine = null;
      this.outboxEngine = null;
    }

    this.transport.on('message', (ctx) => this.handleIncoming(ctx));
    this.transport.on('close', () => this.handleTransportClose());
    // Outbound packets count as activity for the idle-heartbeat tracker;
    // an actively-sending client doesn't need synthetic pings to keep
    // the path warm.
    this.transport.on('messageSent', () => {
      this.lastActivityMs = Date.now();
    });
  }

  /** True when constructor opted into the cache. */
  isCacheEnabled(): boolean {
    return this.cacheDb !== null;
  }

  /** Internal — throws CacheDisabledError if cache wasn't opted in. */
  private requireCache(): { db: CacheDB; store: MessageStore } {
    if (this.cacheDb === null || this.cacheStore === null) {
      throw new CacheDisabledError();
    }
    return { db: this.cacheDb, store: this.cacheStore };
  }

  // ----- Lifecycle -----

  async connect(): Promise<void> {
    this.cancelReconnect();
    this.userInitiatedDisconnect = false;
    this.setState('connecting');
    try {
      await this.transport.connect();
      this.setState('connected');
    } catch (e) {
      this.setState('disconnected', stringifyReason(e));
      throw e;
    }
  }

  async disconnect(): Promise<void> {
    this.userInitiatedDisconnect = true;
    this.cancelReconnect();
    this.setState('closing');
    try {
      await this.transport.disconnect();
    } finally {
      this.lastAuth = null;
      this.activeSubscriptions.clear();
      this.setState('disconnected');
    }
  }

  /**
   * Terminal lifecycle: release every resource this `PrivchatClient`
   * instance holds. After `dispose()`, the client must not be used
   * again — construct a fresh instance if needed.
   *
   * What `dispose()` does:
   *   - cancels the reconnect timer
   *   - closes the transport (if not already closed via `disconnect()`)
   *   - clears in-memory auth + subscription registry
   *   - clears outbox observer registrations
   *   - closes the IndexedDB Dexie handle (`db.close()`)
   *   - emits a final `connection_state_changed` with reason `'disposed'`
   *
   * What `dispose()` does NOT do:
   *   - DOES NOT delete persisted IndexedDB data (channels / messages /
   *     sync_state / outbox). A freshly-constructed client with the same
   *     `cache.dbName` resumes from where this one left off.
   *   - DOES NOT log the user out server-side.
   *   - DOES NOT cascade to other tabs (no BroadcastChannel logic in core).
   *
   * Use the right tool:
   *   - `disconnect()` → "I'm closing the WebSocket; resume later".
   *   - `dispose()` → "this JS instance's lifecycle is over; release handles".
   *   - logout / clear cache → host responsibility (e.g.
   *     `await db.delete()` on the Dexie instance, or wipe localStorage).
   *
   * Idempotent — second and subsequent calls are no-ops.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;

    this.cancelReconnect();

    // Close the transport if still open. Reuse `disconnect()`'s state
    // machine when the user hasn't already invoked it; otherwise the
    // transport is already closed and we just need to tidy.
    if (!this.userInitiatedDisconnect) {
      this.userInitiatedDisconnect = true;
      this.setState('closing', 'disposed');
      try {
        await this.transport.disconnect();
      } catch {
        /* swallow — instance is going away regardless */
      }
      this.lastAuth = null;
      this.activeSubscriptions.clear();
      this.setState('disconnected', 'disposed');
    }

    // Outbox snapshot observers held a reference into the (now-doomed)
    // bus + cache; drop them so any host-app handle that wasn't unsub'd
    // can't keep the closure alive past this instance.
    this.outboxObservers.clear();

    // Close the Dexie handle. IndexedDB rows persist; only the
    // in-process connection is released. A fresh `new PrivchatClient`
    // with the same `dbName` reopens the store cleanly.
    if (this.cacheDb !== null) {
      try {
        this.cacheDb.close();
      } catch {
        /* swallow */
      }
    }
  }

  /**
   * E2E / integration-test helper. Forces the underlying transport to close
   * WITHOUT marking the disconnect as user-initiated, so the close handler
   * engages auto-reconnect the same way an actual network drop would.
   *
   * Production callers should use `disconnect()` for orderly shutdown —
   * `disconnect()` sets `userInitiatedDisconnect=true` to suppress reconnect.
   * This method exists because exercising the post-reconnect sync path
   * end-to-end against a real server requires a close that the SDK treats
   * as "unexpected", and there is no other public surface that does so.
   */
  async simulateUnexpectedDisconnect(): Promise<void> {
    await this.transport.close();
  }

  isConnected(): boolean {
    return this.transport.isConnected();
  }

  // ----- State queries (mirror Rust `connection_state` / `session_snapshot`) -----

  /** Current SDK connection lifecycle state. Synchronous, side-effect-free. */
  connectionState(): ConnectionState {
    return this.state;
  }

  /**
   * Snapshot of the SDK's authoritative session state. Returns `undefined`
   * fields when not yet authenticated. Does NOT expose the access token in
   * plaintext — only a presence boolean. Mirrors Rust `session_snapshot()`.
   */
  sessionSnapshot(): SessionSnapshot {
    return {
      user_id: this.lastAuth?.user_id,
      device_id: this.lastAuth?.device_id,
      connection_state: this.state,
      has_access_token: this.lastAuth !== null,
      last_event_sequence_id: this.bus.lastSequenceId(),
    };
  }

  /**
   * Current access token if the caller authenticated this session.
   * Mirrors Rust `get_current_access_token()`. Null when not authenticated.
   */
  currentAccessToken(): string | null {
    return this.lastAuth?.access_token ?? null;
  }

  // ----- Layer 1: Protocol facade -----

  async authorize(
    req: AuthorizationRequest,
    opts: RequestOptions = {},
  ): Promise<AuthorizationResponse> {
    const raw = await this.transport.request(encodeAuthorizationRequest(req), {
      bizType: MessageType.AuthorizationRequest,
      timeoutMs: opts.timeoutMs,
    });
    return decodeAuthorizationResponse(raw);
  }

  async sendMessage(
    req: SendMessageRequest,
    opts: RequestOptions = {},
  ): Promise<SendMessageResponse> {
    const raw = await this.transport.request(encodeSendMessageRequest(req), {
      bizType: MessageType.SendMessageRequest,
      timeoutMs: opts.timeoutMs,
    });
    return decodeSendMessageResponse(raw);
  }

  async subscribe(
    req: SubscribeRequest,
    opts: RequestOptions = {},
  ): Promise<SubscribeResponse> {
    const raw = await this.transport.request(encodeSubscribeRequest(req), {
      bizType: MessageType.SubscribeRequest,
      timeoutMs: opts.timeoutMs,
    });
    const resp = decodeSubscribeResponse(raw);
    // Track on success so reconnect can replay; key is channel_id+channel_type.
    if (resp.reason_code === 0) {
      if (req.action === SubscribeAction.Subscribe) {
        this.activeSubscriptions.set(subKey(req.channel_id, req.channel_type), req);
      } else if (req.action === SubscribeAction.Unsubscribe) {
        this.activeSubscriptions.delete(subKey(req.channel_id, req.channel_type));
      }
    }
    return resp;
  }

  /**
   * Wire-level unsubscribe — sends a SubscribeRequest with `action` set to
   * the unsubscribe code. `req.action` is forced to `SubscribeAction.Unsubscribe`,
   * any value the caller passes is ignored.
   */
  async unsubscribe(
    req: SubscribeRequest,
    opts: RequestOptions = {},
  ): Promise<SubscribeResponse> {
    return this.subscribe({ ...req, action: SubscribeAction.Unsubscribe }, opts);
  }

  async rpc(
    req: RpcRequest,
    opts: RequestOptions = {},
  ): Promise<RpcResponse> {
    const raw = await this.transport.request(encodeRpcRequest(req), {
      bizType: MessageType.RpcRequest,
      timeoutMs: opts.timeoutMs,
    });
    return decodeRpcResponse(raw);
  }

  /**
   * Channel Transfer client→app RPC (biz_type=19).
   *
   * Sends a wire `TransferRequest` to the application service bound to the
   * given channel and awaits the matching `TransferResponse` (biz_type=20).
   *
   * - `request_id` MUST be unique per attempt; SDK does NOT generate it for
   *   the caller because application idempotency keys on `(user_id, channel_id,
   *   request_id)` — caller controls retry semantics.
   * - `body` is opaque route-defined bytes; the wire codec does not interpret.
   * - Typical routes: `bot/menu/get`, `bot/menu/click`, `game/poker/raise`.
   *
   * Spec: `02-server/CHANNEL_TRANSFER_SPEC.md` v2.0,
   *       `07-application/BOT_INTERACTION_SPEC.md`.
   */
  async transfer(
    req: TransferRequest,
    opts: RequestOptions = {},
  ): Promise<TransferResponse> {
    const raw = await this.transport.request(encodeTransferRequest(req), {
      bizType: MessageType.TransferRequest,
      timeoutMs: opts.timeoutMs,
    });
    return decodeTransferResponse(raw);
  }

  async ping(
    req: PingRequest = { timestamp: Date.now() },
    opts: RequestOptions = {},
  ): Promise<PongResponse> {
    const raw = await this.transport.request(encodePingRequest(req), {
      bizType: MessageType.PingRequest,
      timeoutMs: opts.timeoutMs,
    });
    return decodePongResponse(raw);
  }

  // ----- Layer 2: Rust-style convenience -----

  /**
   * Mirrors Rust `PrivchatSdk::authenticate(user_id, token, device_id)`.
   * Builds a default AuthorizationRequest (auth_type=jwt, sensible
   * client_info/device_info), runs the layer-1 `authorize()`, and throws
   * `AuthorizationError` when the server returns `success=false`.
   */
  async authenticate(
    user_id: string,
    token: string,
    device_id: string,
    opts: RequestOptions = {},
  ): Promise<AuthorizationResponse> {
    const req: AuthorizationRequest = {
      auth_type: 'jwt',
      auth_token: token,
      client_info: this.clientInfo,
      device_info: { ...this.deviceInfo, device_id },
      protocol_version: defaultProtocolVersion(),
      properties: {
        user_id,
        client_timestamp: Date.now().toString(),
      },
    };
    this.setState('authenticating');
    const resp = await this.authorize(req, opts);
    if (!resp.success) {
      const err = new AuthorizationError(resp);
      // State transition follows recovery class: recoverable keeps the
      // transport viable (caller will refresh + retry), terminal drops
      // back to disconnected so the caller knows to re-login fully.
      this.setState(err.errorKind === 'terminal' ? 'disconnected' : 'connected', err.message);
      this.bus.emit({
        type: 'auth_expired',
        reason: err.errorKind === 'terminal' ? 'terminal' : 'recoverable',
        error_code: err.errorCode,
        message: resp.error_message,
      });
      throw err;
    }
    this.lastAuth = { user_id, access_token: token, device_id };
    this.setState('authenticated');
    return resp;
  }

  /**
   * Refresh an expired access token. Mirrors Rust
   * `PrivchatSdk::refresh_access_token(refresh_token, device_id)`.
   *
   * Per `TOKEN_REFRESH_SPEC` (frozen, B1 non-rotation):
   *   - SDK does NOT hold or persist `refresh_token` — caller must own
   *     it (e.g. localStorage / Tauri keychain) and pass it in.
   *   - Server returns `{ access_token, expires_at }` (no refresh_token
   *     rotation in B1). Caller should keep using the same refresh_token.
   *   - On success, caller must subsequently call `authenticate(uid,
   *     newAccessToken, deviceId)` to apply the new token to the connection.
   *   - This method is a pure RPC wrapper: no state-machine mutation,
   *     no auto-`authenticate`, no token persistence.
   *
   * Throws `RefreshTokenError` when the server rejects the refresh — the
   * caller must force re-login (10009 / 10010 = terminal).
   */
  async refreshAccessToken(
    refreshToken: string,
    deviceId: string,
    opts: RequestOptions = {},
  ): Promise<RefreshAccessTokenResult> {
    try {
      return await this.rpcCallTyped<
        RefreshAccessTokenRequest,
        RefreshAccessTokenResult
      >(
        AUTH_REFRESH_ROUTE,
        { refresh_token: refreshToken, device_id: deviceId },
        opts,
      );
    } catch (e) {
      if (e instanceof RpcError) {
        throw new RefreshTokenError(e.response.code, e.response.message);
      }
      throw e;
    }
  }

  /**
   * Mirrors Rust `subscribe_channel(channel_id, channel_type, token?)`.
   * Throws `SubscribeError` when the server returns a non-zero reason_code.
   */
  async subscribeChannel(
    channel_id: string,
    channel_type: number,
    token?: string,
  ): Promise<SubscribeResponse> {
    const resp = await this.subscribe({
      setting: 0,
      local_message_id: '0',
      channel_id,
      channel_type,
      action: SubscribeAction.Subscribe,
      param: token ?? '',
    });
    if (resp.reason_code !== 0) {
      throw new SubscribeError('subscribe', resp);
    }
    return resp;
  }

  /**
   * Mirrors Rust `unsubscribe_channel(channel_id, channel_type)`.
   * Throws `SubscribeError` when the server returns a non-zero reason_code.
   */
  async unsubscribeChannel(
    channel_id: string,
    channel_type: number,
  ): Promise<SubscribeResponse> {
    const resp = await this.subscribe({
      setting: 0,
      local_message_id: '0',
      channel_id,
      channel_type,
      action: SubscribeAction.Unsubscribe,
      param: '',
    });
    if (resp.reason_code !== 0) {
      throw new SubscribeError('unsubscribe', resp);
    }
    return resp;
  }

  /**
   * Mirrors Rust `rpc_call(route, body_json) -> string`. Body is UTF-8
   * encoded into the RpcRequest; response data is decoded back to UTF-8.
   * Throws `RpcError` when `code !== 0`.
   */
  async rpcCall(
    route: string,
    bodyJson: string,
    opts: RequestOptions = {},
  ): Promise<string> {
    const resp = await this.rpc(
      { route, body: new TextEncoder().encode(bodyJson) },
      opts,
    );
    if (resp.code !== 0) {
      throw new RpcError(route, resp);
    }
    return resp.data ? new TextDecoder().decode(resp.data) : '';
  }

  /**
   * Mirrors Rust `rpc_call_typed<Req, Resp>(route, &req) -> Resp`.
   * JSON-serialises the request, calls `rpcCall`, then JSON-parses the
   * response. Side-effect application (e.g. local DB updates) from the
   * Rust version is intentionally absent — Phase 2 has no local store.
   */
  async rpcCallTyped<Req, Resp>(
    route: string,
    req: Req,
    opts: RequestOptions = {},
  ): Promise<Resp> {
    const raw = await this.rpcCall(route, JSON.stringify(req), opts);
    // Use precision-preserving parse: snowflake-sized u64 fields come
    // back as strings instead of being silently rounded by JSON.parse.
    // Safe-int values still come back as `number`, so existing call
    // sites keep working without type churn.
    return parseRpcJson<Resp>(raw);
  }

  /**
   * Direct protocol send of a Text-typed message. Builds a SendMessageRequest
   * with the supplied content as the FlatBuffers payload and invokes the
   * layer-1 `sendMessage()`.
   *
   * When the cache is enabled, this method also performs a **local echo**:
   *   1. insert a `pending` MessageRecord into the cache before the RPC,
   *      so the UI sees the message immediately (no server round-trip wait).
   *   2. on success, replace the pending record with the server-acked one
   *      (status `sent`, populated `server_message_id` + `message_seq`).
   *   3. on failure, mark the pending record `failed` so the UI can offer
   *      a retry affordance.
   *
   * When the cache is disabled, this degrades to the Phase 2 thin direct-send.
   *
   * NOT equivalent to Rust `PrivchatSdk::send_message()` — that goes through
   * a persistent outbound queue (Phase 5). Phase 4's local echo lives only
   * in memory + IndexedDB; a process restart loses pending records.
   */
  async sendTextMessage(input: SendTextInput): Promise<SendTextOperationResult> {
    // Media variants pre-encode their JSON envelope and pass it via
    // `input.payload`. Reply / mention need an envelope too — auto
    // build one when `reply_to_message_id` / `mentioned_user_ids` are
    // present and the caller didn't provide a custom payload. Default
    // path stays raw text bytes for plain text, preserving the
    // pre-existing wire shape across clients that don't yet do
    // JSON-first decode.
    let payload: Uint8Array;
    if (input.payload !== undefined) {
      payload = input.payload;
    } else if (
      input.reply_to_message_id !== undefined ||
      (input.mentioned_user_ids !== undefined &&
        input.mentioned_user_ids.length > 0)
    ) {
      const envelope: Record<string, unknown> = {
        content: input.content,
        mentioned_user_ids:
          input.mentioned_user_ids?.map((u) => Number(u)) ?? [],
      };
      if (input.reply_to_message_id !== undefined) {
        envelope.reply_to_message_id = input.reply_to_message_id;
      }
      payload = new TextEncoder().encode(JSON.stringify(envelope));
    } else {
      payload = new TextEncoder().encode(input.content);
    }
    const localMsgId = input.local_message_id ?? generateLocalMessageId();
    const req: SendMessageRequest = {
      setting: { need_receipt: false, signal: 0 },
      client_seq: input.client_seq ?? 0,
      local_message_id: localMsgId,
      stream_no: '',
      channel_id: input.channel_id,
      message_type: input.message_type ?? 0,
      expire: 0,
      from_uid: input.from_uid,
      topic: '',
      payload,
    };

    // Cache-disabled path: thin wrapper, no outbox, classical strict
    // semantics (transport throws / sendMessage rejects propagate to
    // the caller). The Layer-1 `sendMessage` keeps its own contract.
    if (this.cacheStore === null || this.cacheDb === null) {
      const resp = await this.sendMessage(req);
      return {
        status: 'sent',
        local_message_id: localMsgId,
        response: resp,
      };
    }

    // 1. Insert pending local-echo record. Identity is local_message_id
    //    (no server_message_id yet); record_key derives from it. The
    //    cache row stays `pending` throughout this method — even on
    //    failure paths, because the outbox now owns retry semantics
    //    and the UI should not regress to `failed` while a retry is
    //    pending.
    const pending: MessageRecord = {
      channel_id: input.channel_id,
      channel_type: input.channel_type,
      local_message_id: localMsgId,
      from_uid: input.from_uid,
      message_type: String(input.message_type ?? 0),
      content: input.content,
      payload,
      timestamp: Date.now(),
      status: 'pending',
    };
    this.cacheStore.upsertMessage(pending, false);
    const pendingKey = messageRecordKey(pending);
    void cacheUpsertMessage(this.cacheDb, pending).catch(() => {});

    // 2. Offline gate. If we are not authenticated, skip the wire and
    //    enqueue immediately. Catches: never-connected client, mid-
    //    reconnect window, post-`disconnect()` state. The reconnect
    //    flush hook (5C-1d) will pick the row up later.
    if (this.state !== 'authenticated') {
      await this.enqueueOutboxRow(localMsgId, input, payload, 'pending');
      return {
        status: 'queued',
        local_message_id: localMsgId,
        outbox_id: localMsgId,
      };
    }

    // 3. Try synchronous send.
    let resp: SendMessageResponse;
    try {
      resp = await this.sendMessage(req);
    } catch (e) {
      // Transport failure mid-send → enqueue as `failed (transient)`.
      // Cache row stays `pending` so the UI reflects "still trying".
      await this.enqueueOutboxRow(
        localMsgId,
        input,
        payload,
        'failed',
        formatTransientError(e),
      );
      return {
        status: 'queued',
        local_message_id: localMsgId,
        outbox_id: localMsgId,
      };
    }

    if (resp.reason_code !== 0) {
      // Server rejected (rate-limit, permission, etc). Enqueue as
      // `failed (rejected)` — the engine will not auto-retry, host UI
      // must surface the rejection state via the outbox observer.
      await this.enqueueOutboxRow(
        localMsgId,
        input,
        payload,
        'failed',
        `rejected: code=${resp.reason_code}`,
      );
      return {
        status: 'queued',
        local_message_id: localMsgId,
        outbox_id: localMsgId,
      };
    }

    // 4. ACK: swap pending record for the server-acked one. The acked
    //    record's identity is `server_message_id`, so its record_key
    //    differs from the pending one — the patch carries the old
    //    record_key in `removed` so observers drop the stale row.
    const acked: MessageRecord = {
      ...pending,
      server_message_id: resp.server_message_id,
      pts: String(resp.message_seq),
      status: 'sent',
    };
    this.cacheStore.replaceMessage(
      input.channel_id,
      input.channel_type,
      pendingKey,
      acked,
      false,
    );
    // IndexedDB: delete pending row + put acked (different record_key).
    void this.cacheDb
      .transaction('rw', this.cacheDb.messages, async () => {
        await cacheDeleteMessageByRecordKey(
          this.cacheDb!,
          input.channel_id,
          input.channel_type,
          pendingKey,
        );
        await cacheUpsertMessage(this.cacheDb!, acked);
      })
      .catch(() => {});

    // Refresh channel-list view fields off this just-sent message: the
    // preview should mirror the row the user just put in the timeline,
    // and updated_at should bump so the conversation rises to the top.
    // Push absorb's self-echo path also does this for inbound copies,
    // but doing it here too means the list reacts immediately on send,
    // before the self-echo push lands (or in case it doesn't arrive at
    // all — different multi-device topologies vary).
    this.refreshChannelOnSend(acked);

    return {
      status: 'sent',
      local_message_id: localMsgId,
      response: resp,
    };
  }

  /**
   * Bump `last_message_preview` / `updated_at` / `latest_pts` on the
   * channel record after a successful self-send. Pure helper, idempotent
   * if the same record arrives twice (compare-and-set on each field).
   * No-op when cache is disabled.
   */
  private refreshChannelOnSend(acked: MessageRecord): void {
    if (this.cacheStore === null || this.cacheDb === null) return;
    const channel = this.cacheStore.getChannel(acked.channel_id, acked.channel_type);
    if (!channel) return;
    let next = channel;
    let mutated = false;
    if (acked.pts !== undefined && BigInt(acked.pts) > BigInt(channel.latest_pts)) {
      next = { ...next, latest_pts: acked.pts };
      mutated = true;
    }
    if (acked.timestamp > channel.updated_at) {
      next = { ...next, updated_at: acked.timestamp };
      mutated = true;
    }
    const ackPreview = derivePreview(acked.content, acked.message_type);
    // Skip only an empty *text* preview (keep the prior line); non-text
    // always carries a type the UI renders a placeholder for.
    const ackHasPreview = ackPreview.content_type !== 'text' || ackPreview.text !== '';
    if (
      ackHasPreview &&
      (next.last_message_preview !== ackPreview.text ||
        next.last_message_type !== ackPreview.content_type)
    ) {
      next = {
        ...next,
        last_message_preview: ackPreview.text,
        last_message_type: ackPreview.content_type,
      };
      mutated = true;
    }
    if (mutated) {
      this.cacheStore.upsertChannel(next);
      void this.cacheDb.channels.put(next).catch(() => {});
    }
  }

  /**
   * Internal: persist an outbox row. Caller has already inserted the
   * cache `pending` row and decided which terminal status applies for
   * THIS attempt:
   *   - `'pending'`: never-attempted (offline path).
   *   - `'failed'`: an attempt was made and failed; `last_error`
   *     describes whether it was transient (auto-retryable) or
   *     rejected (host-action-required) via a string prefix.
   *
   * The 5C-1c engine reads `last_error` to decide retry eligibility.
   * No event emit here — observer/event wiring lands in 5C-1e.
   */
  private async enqueueOutboxRow(
    outbox_id: string,
    input: SendTextInput,
    payload: Uint8Array,
    status: OutboxStatus,
    last_error?: string,
  ): Promise<void> {
    if (this.cacheDb === null) return;
    const now = Date.now();
    const entry: OutboxEntry = {
      outbox_id,
      record_key: `l:${outbox_id}`,
      channel_id: input.channel_id,
      channel_type: input.channel_type,
      local_message_id: outbox_id,
      from_uid: input.from_uid,
      content_type: 'text',
      payload,
      created_at: now,
      updated_at: now,
      attempt_count: status === 'failed' ? 1 : 0,
      next_attempt_at: now,
      last_error,
      status,
    };
    await cachePutOutboxEntry(this.cacheDb, entry);
    // Surface the new row to outbox listeners + L1 stream. The engine
    // path uses the same fan-out for sending/sent/failed transitions
    // — see OutboxEngineHooks wiring in the constructor.
    this.onOutboxMutation({
      type: 'outbox_state_changed',
      outbox_id: entry.outbox_id,
      local_message_id: entry.local_message_id,
      channel_id: entry.channel_id,
      channel_type: entry.channel_type,
      status,
      last_error,
    });
  }

  // ----- Phase 4: Cache APIs (require `cache.enabled: true` in constructor) -----

  /**
   * Bootstrap the channel list + read cursors for the current user. Pulls
   * via `entity/sync_entities` (channel + channel_read_cursor), joins the
   * two by channel_id, writes the result into IndexedDB and the in-memory
   * store. Subsequent calls pass `since_version` for incremental sync.
   *
   * Returns the merged channel list.
   *
   * Per the `read_pts` fallback rule (phase06 finding): when the server
   * has no cursor row for a channel (fresh account / never marked read),
   * `read_pts` defaults to `"0"`. `unread_count` is taken verbatim from
   * the server — the SDK does NOT recompute it locally.
   *
   * `latest_pts` is NOT populated at bootstrap time (the entity-sync
   * channel payload doesn't carry pts). It gets populated lazily by
   * inbound push (push.message_seq → record.pts → channel.latest_pts)
   * and, in Phase 5+, by the sync engine.
   */
  async bootstrapChannels(opts: BootstrapChannelsOptions = {}): Promise<ChannelRecord[]> {
    const { db, store } = this.requireCache();
    const sinceChannel = opts.sinceChannelVersion ?? 0;
    const sinceCursor = opts.sinceCursorVersion ?? 0;
    const limit = opts.limit ?? 100;

    // 1. fetch all channels (paged) under entity_type="channel"
    const channelItems: BootstrapChannelItem[] = [];
    let cursor = sinceChannel;
    let safety = 0;
    while (safety++ < 1000) {
      const page = await this.rpcCallTyped<
        { entity_type: string; since_version: number; limit: number },
        BootstrapEntityResponse<BootstrapChannelPayload>
      >(ENTITY_SYNC_ROUTE, {
        entity_type: 'channel',
        since_version: cursor,
        limit,
      });
      for (const item of page.items) {
        if (!item.deleted && item.payload) {
          channelItems.push({ item, payload: item.payload });
        }
      }
      cursor = page.next_version;
      if (!page.has_more) break;
    }

    // 2. fetch all read cursors paged under entity_type="channel_read_cursor"
    //
    // Server returns TWO row classes per page (B-step protocol):
    //   - self rows  — caller's cursor on every channel
    //   - peer rows  — for direct channels (channel_type=1 per the
    //                  TS/messages-table convention), the OTHER party's
    //                  cursor on the same channel; routed by reader_id
    //
    // Bucket cursor rows by channel_id with explicit self/peer slots so
    // the join below can hydrate both `read_pts` and `peer_read_pts`.
    // Baseline hydration must NOT emit `peer_read_cursor_updated` —
    // that event is reserved for live `peer_read_pts_updated` push
    // advances. UI re-renders pick up the cold-start `peer_read_pts`
    // via the channel-list snapshot stream instead.
    interface CursorBucket {
      self?: BootstrapCursorPayload;
      peer?: BootstrapCursorPayload;
    }
    const cursorByChannel = new Map<string, CursorBucket>();
    const selfUid = this.lastAuth?.user_id;
    let cur2 = sinceCursor;
    safety = 0;
    while (safety++ < 1000) {
      const page = await this.rpcCallTyped<
        { entity_type: string; since_version: number; limit: number },
        BootstrapEntityResponse<BootstrapCursorPayload>
      >(ENTITY_SYNC_ROUTE, {
        entity_type: 'channel_read_cursor',
        since_version: cur2,
        limit,
      });
      for (const item of page.items) {
        if (item.deleted || !item.payload) continue;
        const ch = item.payload.channel_id;
        if (ch === undefined) continue;
        const channel_id = String(ch);
        const reader_id =
          item.payload.reader_id !== undefined
            ? String(item.payload.reader_id)
            : undefined;
        let bucket = cursorByChannel.get(channel_id);
        if (bucket === undefined) {
          bucket = {};
          cursorByChannel.set(channel_id, bucket);
        }
        if (
          selfUid !== undefined &&
          reader_id !== undefined &&
          reader_id !== selfUid
        ) {
          // Peer cursor — server only emits these for direct channels.
          bucket.peer = item.payload;
        } else {
          // Self row (or legacy server / unauthenticated test setup
          // where we can't disambiguate; default to self for backward
          // compat).
          bucket.self = item.payload;
        }
      }
      cur2 = page.next_version;
      if (!page.has_more) break;
    }

    // 3. join → ChannelRecord
    const records: ChannelRecord[] = channelItems.map(({ item, payload }) => {
      const channel_id = String(payload.channel_id ?? item.entity_id);
      const channel_type = (payload.channel_type ?? payload.type ?? 0) as number;
      const bucket = cursorByChannel.get(channel_id);
      const selfPts = bucket?.self?.last_read_pts;
      const peerPts = bucket?.peer?.last_read_pts;
      // Server only sends `last_msg_content` (no type); for non-text rows
      // it is the raw message JSON envelope. `derivePreview` sniffs the
      // type out of it so the UI can render a placeholder instead of JSON.
      const preview =
        payload.last_msg_content !== undefined
          ? derivePreview(payload.last_msg_content)
          : undefined;
      return {
        channel_id,
        channel_type,
        title: payload.channel_name ?? payload.name,
        // Phase 4: latest_pts is populated by inbound push, not bootstrap.
        latest_pts: '0',
        read_pts: selfPts !== undefined ? String(selfPts) : '0',
        peer_read_pts: peerPts !== undefined ? String(peerPts) : undefined,
        unread_count: payload.unread_count ?? 0,
        last_message_preview: preview?.text,
        last_message_type: preview?.content_type,
        updated_at: payload.last_msg_timestamp ?? 0,
        sync_version: item.version,
      };
    });

    // 4. persist + emit
    await cacheUpsertChannels(db, records);
    store.upsertChannels(records);

    // 5. user + group profile baseline (R2A). These are independent of
    //    the channel list — failures must NOT block conversation entry.
    //    A flaky profile-sync RPC would otherwise lock the user out of
    //    their inbox, which is the wrong trade-off. Each sync pages
    //    its own `since_version` independently.
    void this.bootstrapProfilesBestEffort(opts.limit ?? 100);

    return records;
  }

  /**
   * Page through `entity/sync_entities("user")` and `("group")` to fill
   * the local profile cache. Best-effort: any error is logged and
   * swallowed. Each sync starts from the highest `sync_version` known
   * locally so subsequent calls are incremental. Public callers should
   * not need to invoke this directly — it runs from `bootstrapChannels`.
   */
  private async bootstrapProfilesBestEffort(limit: number): Promise<void> {
    const db = this.cacheDb;
    const userStore = this.userStore;
    const groupStore = this.groupStore;
    const friendshipStore = this.friendshipStore;
    if (
      db === null ||
      userStore === null ||
      groupStore === null ||
      friendshipStore === null
    ) {
      return;
    }

    // Cold-start hydration. The in-memory stores are constructed empty
    // every page load; without this step a freshly-mounted UI sees an
    // empty list until the server sync below populates it. That fails
    // closed when the server returns 0 rows (because `since_version` is
    // taken from IDB's max — already up-to-date), leaving the friend
    // list permanently empty after refresh. Hydrate from IDB first so
    // observers fire immediately and the server sync only delivers
    // genuine deltas.
    await this.hydrateProfileStoresFromIdb(db, userStore, groupStore, friendshipStore);

    await Promise.all([
      this.bootstrapUsers(db, userStore, limit).catch((e: unknown) => {
        // eslint-disable-next-line no-console
        console.warn('[privchat] user profile sync failed (non-fatal)', e);
      }),
      this.bootstrapGroups(db, groupStore, limit).catch((e: unknown) => {
        // eslint-disable-next-line no-console
        console.warn('[privchat] group profile sync failed (non-fatal)', e);
      }),
      this.bootstrapFriendships(db, friendshipStore, limit).catch((e: unknown) => {
        // eslint-disable-next-line no-console
        console.warn('[privchat] friendship sync failed (non-fatal)', e);
      }),
    ]);
  }

  /** Pull all rows from IDB into the in-memory profile/friendship stores
   *  on cold start. Idempotent: subsequent calls find non-empty stores
   *  and skip. Errors are logged and swallowed — a missing local cache
   *  is recoverable via the server sync that follows. */
  private async hydrateProfileStoresFromIdb(
    db: CacheDB,
    userStore: UserStore,
    groupStore: GroupStore,
    friendshipStore: FriendshipStore,
  ): Promise<void> {
    await Promise.all([
      userStore.size() === 0
        ? cacheListUsers(db)
            .then((rows) => userStore.upsertMany(rows))
            .catch((e: unknown) => {
              // eslint-disable-next-line no-console
              console.warn('[privchat] user cache hydrate failed', e);
            })
        : Promise.resolve(),
      groupStore.size() === 0
        ? cacheListGroups(db)
            .then((rows) => groupStore.upsertMany(rows))
            .catch((e: unknown) => {
              // eslint-disable-next-line no-console
              console.warn('[privchat] group cache hydrate failed', e);
            })
        : Promise.resolve(),
      friendshipStore.size() === 0
        ? cacheListFriendships(db)
            .then((rows) => friendshipStore.upsertMany(rows))
            .catch((e: unknown) => {
              // eslint-disable-next-line no-console
              console.warn('[privchat] friendship cache hydrate failed', e);
            })
        : Promise.resolve(),
    ]);
  }

  private async bootstrapUsers(
    db: CacheDB,
    store: UserStore,
    limit: number,
  ): Promise<void> {
    // Start from the highest sync_version we already know locally so
    // re-bootstrap on auto-login is cheap. The server returns rows
    // strictly greater than this cursor.
    let since = Math.max(store.maxSyncVersion(), await cacheMaxUserSyncVersion(db));
    const aggregated: UserRecord[] = [];
    let safety = 0;
    while (safety++ < 1000) {
      const page = await this.rpcCallTyped<
        { entity_type: string; since_version: number; limit: number },
        BootstrapEntityResponse<BootstrapUserPayload>
      >(ENTITY_SYNC_ROUTE, {
        entity_type: 'user',
        since_version: since,
        limit,
      });
      for (const item of page.items) {
        if (item.deleted || !item.payload) continue;
        const record = userPayloadToRecord(item.payload, item.version);
        if (record !== null) aggregated.push(record);
      }
      since = page.next_version;
      if (!page.has_more) break;
    }
    if (aggregated.length === 0) return;
    await cacheUpsertUsers(db, aggregated);
    store.upsertMany(aggregated);
  }

  private async bootstrapGroups(
    db: CacheDB,
    store: GroupStore,
    limit: number,
  ): Promise<void> {
    let since = Math.max(store.maxSyncVersion(), await cacheMaxGroupSyncVersion(db));
    const aggregated: GroupRecord[] = [];
    let safety = 0;
    while (safety++ < 1000) {
      const page = await this.rpcCallTyped<
        { entity_type: string; since_version: number; limit: number },
        BootstrapEntityResponse<BootstrapGroupPayload>
      >(ENTITY_SYNC_ROUTE, {
        entity_type: 'group',
        since_version: since,
        limit,
      });
      for (const item of page.items) {
        if (item.deleted || !item.payload) continue;
        const record = groupPayloadToRecord(item.payload, item.version);
        if (record !== null) aggregated.push(record);
      }
      since = page.next_version;
      if (!page.has_more) break;
    }
    if (aggregated.length === 0) return;
    await cacheUpsertGroups(db, aggregated);
    store.upsertMany(aggregated);
  }

  /**
   * Page through `entity/sync_entities("friend")` and reconcile the
   * friendship cache. Two row classes per page:
   *   - `deleted: true` rows (tombstones for unfriend / block) →
   *     remove from in-memory store and IndexedDB. The corresponding
   *     UserRecord is intentionally NOT removed: that uid may still
   *     appear in unrelated channels (group membership, stranger DMs,
   *     message history) and dropping the user profile would break
   *     title resolution there.
   *   - normal rows → upsert.
   *
   * Both classes share `sync_version`. Wire shape: payload nests
   * alias inside `payload.user.alias`; this method flattens.
   */
  private async bootstrapFriendships(
    db: CacheDB,
    store: FriendshipStore,
    limit: number,
  ): Promise<void> {
    let since = Math.max(
      store.maxSyncVersion(),
      await cacheMaxFriendshipSyncVersion(db),
    );
    const upserted: FriendshipRecord[] = [];
    const tombstoneIds: string[] = [];
    let safety = 0;
    while (safety++ < 1000) {
      const page = await this.rpcCallTyped<
        { entity_type: string; since_version: number; limit: number },
        BootstrapEntityResponse<BootstrapFriendPayload>
      >(ENTITY_SYNC_ROUTE, {
        entity_type: 'friend',
        since_version: since,
        limit,
      });
      for (const item of page.items) {
        if (item.deleted) {
          // Tombstone — entity_id carries the friend's uid as a string.
          tombstoneIds.push(item.entity_id);
          continue;
        }
        if (!item.payload) continue;
        const record = friendPayloadToRecord(item.payload, item.version);
        if (record !== null) upserted.push(record);
      }
      since = page.next_version;
      if (!page.has_more) break;
    }
    if (upserted.length === 0 && tombstoneIds.length === 0) return;
    if (upserted.length > 0) await cacheUpsertFriendships(db, upserted);
    if (tombstoneIds.length > 0) await cacheDeleteFriendships(db, tombstoneIds);
    store.applyDelta(upserted, tombstoneIds);
  }

  /** Returns the cached channel list (in-memory). Empty when bootstrap not yet run. */
  cachedChannels(): ChannelRecord[] {
    return this.requireCache().store.listChannels();
  }

  /** Subscribe to channel-list updates (bootstrap, push-driven re-sort, etc). */
  observeChannelList(cb: (channels: ChannelRecord[]) => void): Unsubscribe {
    return this.requireCache().store.observeChannelList(cb);
  }

  // ----- R2A: User profile cache -----

  /** Look up a single user profile by id. Returns `undefined` when the
   *  uid hasn't been seen yet (call `bootstrapChannels` first, or wait
   *  for an inbound message from this user to surface). */
  cachedUser(user_id: string): UserRecord | undefined {
    if (this.userStore === null) throw new CacheDisabledError();
    return this.userStore.get(user_id);
  }

  /** Snapshot of every cached user profile. Order is unspecified; the
   *  caller should sort/filter for display. */
  cachedUsers(): UserRecord[] {
    if (this.userStore === null) throw new CacheDisabledError();
    return this.userStore.list();
  }

  /** Subscribe to user-list updates (bootstrap pages, future push-driven
   *  profile updates). The callback receives a fresh snapshot on every
   *  change. */
  observeUserList(cb: (users: UserRecord[]) => void): Unsubscribe {
    if (this.userStore === null) throw new CacheDisabledError();
    return this.userStore.observe(cb);
  }

  // ----- R2A: Group profile cache -----

  cachedGroup(group_id: string): GroupRecord | undefined {
    if (this.groupStore === null) throw new CacheDisabledError();
    return this.groupStore.get(group_id);
  }

  cachedGroups(): GroupRecord[] {
    if (this.groupStore === null) throw new CacheDisabledError();
    return this.groupStore.list();
  }

  observeGroupList(cb: (groups: GroupRecord[]) => void): Unsubscribe {
    if (this.groupStore === null) throw new CacheDisabledError();
    return this.groupStore.observe(cb);
  }

  // ----- R2.1: Friendship cache -----

  /**
   * Look up the friendship row for a given uid. Returns `undefined`
   * when the uid isn't a friend (the title resolver treats this as
   * "no alias known" and falls back to nickname / username).
   */
  cachedFriendship(user_id: string): FriendshipRecord | undefined {
    if (this.friendshipStore === null) throw new CacheDisabledError();
    return this.friendshipStore.get(user_id);
  }

  cachedFriendships(): FriendshipRecord[] {
    if (this.friendshipStore === null) throw new CacheDisabledError();
    return this.friendshipStore.list();
  }

  /** Subscribe to friendship-list mutations (alias edits, new friends,
   *  unfriend tombstones). Callback receives a fresh full snapshot. */
  observeFriendshipList(cb: (friendships: FriendshipRecord[]) => void): Unsubscribe {
    if (this.friendshipStore === null) throw new CacheDisabledError();
    return this.friendshipStore.observe(cb);
  }

  /**
   * Force an incremental friendship sync from the server, MAX-merging
   * any new rows / tombstones into the local cache and notifying
   * `observeFriendshipList` listeners. Idempotent — uses the current
   * highest known `sync_version` as the cursor, so the round-trip is
   * cheap when nothing changed.
   *
   * Use this when the SDK can't otherwise hear about an external
   * friendship change: peer accepts an outgoing apply (we sent
   * friendApply, they tap accept on their device — we have no push
   * channel for that today), peer sets / clears an alias, etc. The
   * matching `friendAccept` RPC reply already builds the local row on
   * the accepting side, so callers there don't strictly need to call
   * this — but doing so is harmless and convergent.
   *
   * No-op when the cache is disabled.
   */
  async refreshFriendships(limit: number = 100): Promise<void> {
    const db = this.cacheDb;
    const store = this.friendshipStore;
    if (db === null || store === null) return;
    await this.bootstrapFriendships(db, store, limit);
  }

  /**
   * Sync read: messages currently held in memory for this channel
   * (sorted ascending by message_seq). Returns empty before any open
   * or push has populated the buffer.
   */
  getCachedMessages(channel_id: string, channel_type: number): MessageRecord[] {
    return this.requireCache().store.getMessages(channel_id, channel_type);
  }

  /**
   * Subscribe to per-conversation updates (snapshot + patch). The first
   * emit happens via openConversation (cached, then remote). Subsequent
   * emits come from inbound push, scrollHistory, local-echo replace, etc.
   */
  observeConversation(
    channel_id: string,
    channel_type: number,
    cb: (snapshot: ConversationSnapshot, patch: ConversationPatch) => void,
  ): Unsubscribe {
    return this.requireCache().store.observeConversation(channel_id, channel_type, cb);
  }

  /**
   * Open a conversation: emit cached window first (if any), then RPC the
   * latest server window, merge, persist, emit again. Returns the merged
   * remote window. Canonical flow per SDK_EVENT_SURFACE_AND_API_SHAPE_SPEC §8.
   *
   * `channel.latest_pts` is NOT lifted here — `message/history/get` doesn't
   * carry per-channel pts. latest_pts gets populated by inbound push
   * (push.message_seq) and by Phase 5+ sync engine.
   */
  async openConversation(
    channel_id: string,
    channel_type: number,
    opts: OpenConversationOptions = {},
  ): Promise<MessageRecord[]> {
    const { db, store } = this.requireCache();
    const limit = opts.limit ?? DEFAULT_OPEN_LIMIT;

    // 1. Synchronous emit of the cached window (if any).
    const cached = await cacheGetMessageWindow(db, channel_id, channel_type, limit);
    if (cached.length > 0) {
      store.replaceWindow(channel_id, channel_type, cached, false);
    }

    // 2. Fetch remote latest window.
    const remote = await this.messageHistory(Number(channel_id), limit);
    const selfUid = this.lastAuth?.user_id;
    const records = remote.messages.map((m) =>
      historicalMessageToRecord(m, channel_id, channel_type, selfUid),
    );

    if (records.length > 0) {
      // 3. Persist + emit. replaceWindow preserves out-of-range pending
      //    records (local echoes for messages just sent).
      await cacheUpsertMessages(db, records);
      store.replaceWindow(channel_id, channel_type, records, true);

      // 4. Update sync_state window bounds (timestamp-based).
      const timestamps = records.map((r) => r.timestamp);
      const minAt = Math.min(...timestamps);
      const maxAt = Math.max(...timestamps);
      await cacheUpsertSyncState(db, {
        channel_id,
        channel_type,
        min_loaded_at: minAt,
        max_loaded_at: maxAt,
        last_sync_at: Date.now(),
      });
    }

    return store.getMessages(channel_id, channel_type);
  }

  /**
   * Page older history backwards. Wire cursor is `before_server_message_id`
   * (snowflake). Defaults to the oldest in-memory message's
   * `server_message_id` when the caller doesn't supply one.
   *
   * Returns the new page (empty when no more older history exists).
   */
  async scrollHistory(
    channel_id: string,
    channel_type: number,
    opts: ScrollHistoryOptions = {},
  ): Promise<MessageRecord[]> {
    const { db, store } = this.requireCache();
    const limit = opts.limit ?? DEFAULT_OPEN_LIMIT;

    let beforeId: number | undefined = opts.beforeServerMessageId !== undefined
      ? Number(opts.beforeServerMessageId)
      : undefined;
    if (beforeId === undefined) {
      const inMem = store.getMessages(channel_id, channel_type);
      // Find the oldest record with a server_message_id (skip pending rows).
      const oldestServerSide = inMem.find((m) => m.server_message_id !== undefined);
      if (oldestServerSide?.server_message_id !== undefined) {
        beforeId = Number(oldestServerSide.server_message_id);
      }
    }

    const remote = await this.messageHistory(Number(channel_id), limit, beforeId);
    if (remote.messages.length === 0) return [];

    const selfUid = this.lastAuth?.user_id;
    const records = remote.messages.map((m) =>
      historicalMessageToRecord(m, channel_id, channel_type, selfUid),
    );
    await cacheUpsertMessages(db, records);
    store.upsertMessages(channel_id, channel_type, records, true);

    // Push min_loaded_at downward.
    const newMinAt = Math.min(...records.map((r) => r.timestamp));
    const existing = await cacheGetSyncState(db, channel_id, channel_type);
    const minAt =
      existing?.min_loaded_at !== undefined && existing.min_loaded_at < newMinAt
        ? existing.min_loaded_at
        : newMinAt;
    await cacheUpsertSyncState(db, {
      channel_id,
      channel_type,
      min_loaded_at: minAt,
      max_loaded_at: existing?.max_loaded_at,
      last_sync_at: Date.now(),
    });

    return records;
  }

  /**
   * Mark messages in a channel as read up to `read_pts`. Exposed as a
   * first-class SDK primitive (the Rust SDK doesn't expose mark-read
   * outbound — it only consumes the inbound `peer_read_pts_updated` push).
   *
   * Request → `message/status/read_pts`. The server clamps:
   *   - `read_pts < channel.last_read_pts` → no advance, no broadcast
   *     (idempotent; no-op locally because we MAX-merge).
   *   - `read_pts > channel.current_pts` → ValidationError (wrapped as
   *     MarkReadValidationError so callers can distinguish).
   *
   * On success, the server's `accepted_read_pts` is the canonical truth
   * (post-clamp). When the cache is enabled, we update the local
   * channel's `read_pts = MAX(old, accepted)` and zero `unread_count`.
   * The same projection function fires when the server pushes
   * `self_read_pts_updated` back to us — RPC and push paths converge
   * via the shared `applyReadCursorUpdate` (idempotent under MAX).
   *
   * `cache-disabled` callers get the raw RPC response only; no local
   * state is touched.
   */
  async markRead(
    channel_id: string,
    channel_type: number,
    read_pts: string,
    opts: MarkReadOptions = {},
  ): Promise<MarkReadResult> {
    const reqBody: MarkReadRequest = {
      channel_id: Number(channel_id),
      read_pts: Number(read_pts),
    };
    if (opts.lastReadMessageId !== undefined) {
      reqBody.last_read_message_id = Number(opts.lastReadMessageId);
    }
    if (opts.clientVisiblePts !== undefined) {
      reqBody.client_visible_pts = Number(opts.clientVisiblePts);
    }

    let resp: MarkReadResult;
    try {
      resp = await this.rpcCallTyped<MarkReadRequest, MarkReadResult>(
        MARK_READ_ROUTE,
        reqBody,
      );
    } catch (e) {
      if (e instanceof RpcError) {
        throw new MarkReadValidationError(
          channel_id,
          channel_type,
          read_pts,
          e.response,
        );
      }
      throw e;
    }

    // Server is the truth source. Prefer accepted_read_pts (post-clamp)
    // over last_read_pts (raw); fall back to the request value only when
    // both are missing (shouldn't happen against a healthy server).
    const accepted =
      resp.accepted_read_pts !== undefined
        ? String(resp.accepted_read_pts)
        : resp.last_read_pts !== undefined
          ? String(resp.last_read_pts)
          : read_pts;

    if (this.cacheStore !== null && this.cacheDb !== null) {
      const result = await this.applyReadCursorUpdate(channel_id, channel_type, accepted);
      this.maybeEmitReadCursorUpdated(
        result,
        channel_id,
        channel_type,
        this.lastAuth?.user_id ?? '',
        // markRead RPC echo doesn't carry server wall-clock — the
        // server-side `updated_at` only ships on the push variant.
      );
    }
    return resp;
  }

  // ----- Phase 5C: outbound queue -----

  /**
   * Drain due outbox rows (`pending` / `failed` with
   * `next_attempt_at <= now`). Per-channel FIFO; cross-channel runs
   * in parallel via the engine's per-channel mutex.
   *
   * - Requires `cache.enabled: true` AND `outbox.enabled !== false`.
   *   Throws `CacheDisabledError` otherwise.
   * - Skips rows when the client is not `'authenticated'` — safe to
   *   call mid-reconnect. The skipped count surfaces in the result;
   *   rows are picked up on the next flush.
   * - Transient failures bump `attempt_count` and schedule a backoff
   *   retry; rejected (`reason_code !== 0`) failures freeze the row.
   * - Successful rows ACK-swap the cache `pending` record to `sent`
   *   (same patch shape as the inline `sendTextMessage` ACK path) and
   *   delete the outbox row in a single rw transaction.
   */
  async flushOutbox(options: OutboxFlushOptions = {}): Promise<OutboxFlushResult> {
    if (this.outboxEngine === null) {
      throw new CacheDisabledError();
    }
    return this.outboxEngine.flushOutbox(options);
  }

  /**
   * Snapshot of outbox rows. Sorted by `created_at` ascending. Optional
   * filters narrow by status / channel / count.
   * Throws `CacheDisabledError` when the outbox isn't available.
   */
  async outboxEntries(
    options: ListOutboxOptions & { channel_id?: string; channel_type?: number } = {},
  ): Promise<OutboxEntry[]> {
    if (this.outboxEngine === null || this.cacheDb === null) {
      throw new CacheDisabledError();
    }
    let entries = await cacheListOutboxEntries(this.cacheDb, {
      statuses: options.statuses,
      limit: options.limit,
    });
    if (options.channel_id !== undefined) {
      entries = entries.filter(
        (e) =>
          e.channel_id === options.channel_id &&
          (options.channel_type === undefined || e.channel_type === options.channel_type),
      );
    } else if (options.channel_type !== undefined) {
      entries = entries.filter((e) => e.channel_type === options.channel_type);
    }
    return entries;
  }

  /**
   * Subscribe to full outbox snapshots. The callback fires with an
   * initial snapshot on subscribe (microtask-async — the snapshot is
   * read from IndexedDB), and again on every persisted state mutation
   * thereafter. Use `observeEvents` for per-transition granularity
   * (the L1 `outbox_state_changed` stream).
   *
   * No-op (returns a noop unsubscribe + never fires) when the outbox
   * isn't available — keeps host code simple in cache-disabled
   * configurations.
   */
  observeOutbox(cb: (entries: OutboxEntry[]) => void): Unsubscribe {
    if (this.outboxEngine === null || this.cacheDb === null) {
      return () => {
        /* noop */
      };
    }
    this.outboxObservers.add(cb);
    // Initial snapshot — async; fires on the next microtask so the
    // caller sees a clean "subscribe → state" transition.
    void this.snapshotOneObserver(cb);
    return () => {
      this.outboxObservers.delete(cb);
    };
  }

  /**
   * Drop an outbox row WITHOUT sending. Removes the matching cache
   * `pending` row too (so the user-visible message disappears) and
   * emits `outbox_state_changed { status: 'discarded' }`.
   *
   * Throws `CacheDisabledError` when the outbox isn't available, or a
   * generic `Error` when no row matches.
   */
  async discardOutboxEntry(outbox_id: string): Promise<void> {
    if (this.outboxEngine === null || this.cacheDb === null || this.cacheStore === null) {
      throw new CacheDisabledError();
    }
    const entry = await cacheGetOutboxEntry(this.cacheDb, outbox_id);
    if (!entry) {
      throw new Error(`outbox row not found: outbox_id=${outbox_id}`);
    }
    await cacheDeleteOutboxEntry(this.cacheDb, outbox_id);
    // Drop the matching cache MessageRecord. Memory removal emits a
    // patch with `removed=[recordKey]`; IDB deletion is fire-and-forget.
    this.cacheStore.removeMessage(entry.channel_id, entry.channel_type, entry.record_key);
    void cacheDeleteMessageByRecordKey(
      this.cacheDb,
      entry.channel_id,
      entry.channel_type,
      entry.record_key,
    ).catch(() => {});
    this.onOutboxMutation({
      type: 'outbox_state_changed',
      outbox_id: entry.outbox_id,
      local_message_id: entry.local_message_id,
      channel_id: entry.channel_id,
      channel_type: entry.channel_type,
      status: 'discarded',
    });
  }

  /**
   * User-triggered retry of a single outbox row. Resets the row's
   * backoff (`next_attempt_at = 0`, `attempt_count = 0`,
   * `last_error` cleared) and kicks the engine. Works on both
   * `failed` rows and frozen-after-max-attempts rows; for already-
   * `pending` / `sending` rows the engine's flush is a no-op so this
   * is harmless to spam.
   *
   * Cache-row mirroring: doesn't touch `MessageRecord.status` (which
   * stays `'pending'` end-to-end during outbox-managed retries — same
   * contract as the original send path). The next ACK / failure
   * propagation happens through the engine's normal hooks.
   *
   * Throws `CacheDisabledError` when the outbox isn't available, or a
   * generic `Error` when no row matches.
   */
  async retryOutboxEntry(outbox_id: string): Promise<void> {
    if (this.outboxEngine === null || this.cacheDb === null) {
      throw new CacheDisabledError();
    }
    const entry = await cacheGetOutboxEntry(this.cacheDb, outbox_id);
    if (!entry) {
      throw new Error(`outbox row not found: outbox_id=${outbox_id}`);
    }
    // Reset backoff state so the engine treats this row as immediately
    // due. Clearing `last_error` keeps the UI from showing stale errors
    // while the new attempt is in flight.
    await cacheUpdateOutboxStatus(this.cacheDb, outbox_id, {
      status: 'pending',
      attempt_count: 0,
      next_attempt_at: 0,
      last_error: null,
    });
    // Kick the engine. Narrow to the row's channel so we don't drag
    // unrelated channels into a flush; the engine itself caps per-row
    // concurrency.
    await this.flushOutbox({
      channel_id: entry.channel_id,
      channel_type: entry.channel_type,
    });
  }

  // ----- Internal: outbox event / observer wiring -----

  /**
   * Single fan-out point for outbox mutations. Emits the L1 event
   * synchronously, then schedules a snapshot push to observers (which
   * also handles the `outbox_drained` transition). Fire-and-forget on
   * the snapshot side — observers should not block the engine.
   */
  private onOutboxMutation(event: OutboxStateChangedEvent): void {
    this.bus.emit(event);
    void this.notifyOutboxObservers();
  }

  private async notifyOutboxObservers(): Promise<void> {
    if (this.cacheDb === null) return;
    let entries: OutboxEntry[];
    try {
      entries = await cacheListOutboxEntries(this.cacheDb);
    } catch {
      return;
    }
    for (const cb of [...this.outboxObservers]) {
      try {
        cb(entries);
      } catch {
        /* observer errors must not break the fan-out */
      }
    }
    const nonEmpty = entries.length > 0;
    if (this.outboxLastNonEmpty && !nonEmpty) {
      this.bus.emit({ type: 'outbox_drained' });
    }
    this.outboxLastNonEmpty = nonEmpty;
  }

  private async snapshotOneObserver(
    cb: (entries: OutboxEntry[]) => void,
  ): Promise<void> {
    if (this.cacheDb === null) return;
    try {
      const entries = await cacheListOutboxEntries(this.cacheDb);
      cb(entries);
    } catch {
      /* swallow */
    }
  }

  // ----- Phase 5B-1: sync engine -----

  /**
   * Per-channel gap-fill against `sync/get_difference`. Pulls every commit
   * the cache missed since the last known per-channel pts, merges into
   * the in-memory store + IndexedDB, and lifts `channel.latest_pts` to
   * the new high-water mark.
   *
   * - Requires `cache.enabled: true` (throws CacheDisabledError otherwise).
   * - Per-channel serialised: a second concurrent call against the same
   *   `(channel_id, channel_type)` reuses the in-flight promise.
   * - On `SyncChannelResyncRequired` (20900): wipes the channel buffer +
   *   re-hydrates via `openConversation`. `latest_pts` is reset to "0"
   *   (NOT lifted to `current_pts` from the error envelope — see
   *   PHASE5B_SYNC_ENGINE_PLAN.md).
   * - On `SyncFullRebuildRequired` (20902): emits a
   *   `sync_full_rebuild_required` L1 event; cache is left untouched
   *   (host app decides recovery).
   *
   * Does NOT touch `read_pts` — that stays Phase 5A's responsibility
   * (`markRead` / inbound read-cursor pushes).
   */
  async syncChannel(
    channel_id: string,
    channel_type: number,
  ): Promise<SyncResult> {
    if (this.syncEngine === null) {
      throw new CacheDisabledError();
    }
    return this.syncEngine.syncChannel(channel_id, channel_type);
  }

  /**
   * Internal RPC adapter used by the sync engine. Translates the SDK's
   * RpcError into the engine's SyncRpcError (which carries the raw
   * response bytes for `current_pts` extraction on 20900). The wire
   * carries u64 ids as JSON strings (`GetDifferenceRequest` /
   * `GetDifferenceResponse` are string-typed on those fields), so this
   * adapter is now a thin wrapper — no number coercion required.
   */
  private async callSyncGetDifference(
    req: GetDifferenceRequest,
  ): Promise<GetDifferenceResponse> {
    try {
      return await this.rpcCallTyped<GetDifferenceRequest, GetDifferenceResponse>(
        SYNC_GET_DIFFERENCE_ROUTE,
        req,
      );
    } catch (e) {
      if (e instanceof RpcError) {
        throw new SyncRpcError({
          code: e.response.code,
          message: e.response.message,
          dataBytes: e.response.data,
        });
      }
      throw e;
    }
  }

  // ----- L1 event surface -----

  /**
   * Subscribe to the strong-typed L1 event stream
   * (`SDK_EVENT_SURFACE_AND_API_SHAPE_SPEC §2.1`). Returns an
   * unsubscribe function. Use this for new code; the per-type
   * helpers below (`onPushMessage` etc.) remain as backward-compat
   * filters on the same bus.
   */
  observeEvents(cb: (env: SequencedSdkEvent) => void): Unsubscribe {
    return this.bus.subscribe(cb);
  }

  /** Latest sequence_id allocated by the bus (0 before any emit). */
  lastEventSequenceId(): number {
    return this.bus.lastSequenceId();
  }

  /** Most recent N events from the in-memory ring (oldest first). */
  recentEvents(limit: number): SequencedSdkEvent[] {
    return this.bus.recentEvents(limit);
  }

  /**
   * Catch-up replay: events with `sequence_id > fromSequenceId`,
   * capped at `limit`. Returns empty when caller is fully caught up.
   * Pair with `lastEventSequenceId()` to bookmark consumption.
   */
  eventsSince(fromSequenceId: number, limit: number): SequencedSdkEvent[] {
    return this.bus.eventsSince(fromSequenceId, limit);
  }

  // ----- Push handlers (compat helpers; thin filters on the L1 bus) -----

  onPushMessage(cb: (msg: PushMessageRequest) => void): Unsubscribe {
    return this.bus.subscribe((env) => {
      if (env.event.type === 'message_received') cb(env.event.message);
    });
  }

  onPushBatch(cb: (msg: PushBatchRequest) => void): Unsubscribe {
    return this.bus.subscribe((env) => {
      if (env.event.type === 'message_batch_received') cb(env.event.batch);
    });
  }

  onPong(cb: (msg: PongResponse) => void): Unsubscribe {
    return this.bus.subscribe((env) => {
      if (env.event.type === 'pong_received') cb(env.event.pong);
    });
  }

  /** Subscribe specifically to `auth_expired` events (recoverable / terminal). */
  onAuthExpired(cb: (event: SdkEvent & { type: 'auth_expired' }) => void): Unsubscribe {
    return this.bus.subscribe((env) => {
      if (env.event.type === 'auth_expired') cb(env.event);
    });
  }

  /** Subscribe specifically to `connection_state_changed` events. */
  onConnectionStateChanged(
    cb: (event: SdkEvent & { type: 'connection_state_changed' }) => void,
  ): Unsubscribe {
    return this.bus.subscribe((env) => {
      if (env.event.type === 'connection_state_changed') cb(env.event);
    });
  }

  /** Phase 5D: subscribe to self-side read-cursor advances. Fires only
   *  on actual `read_pts` advance — duplicate / out-of-order pushes
   *  that fail the MAX-merge are suppressed. */
  onReadCursorUpdated(
    cb: (event: SdkEvent & { type: 'read_cursor_updated' }) => void,
  ): Unsubscribe {
    return this.bus.subscribe((env) => {
      if (env.event.type === 'read_cursor_updated') cb(env.event);
    });
  }

  /** Phase 5D: subscribe to peer-side read-cursor advances (1:1
   *  channels only). Fires for every incoming peer push — the SDK
   *  does not maintain peer state to diff against. */
  onPeerReadCursorUpdated(
    cb: (event: SdkEvent & { type: 'peer_read_cursor_updated' }) => void,
  ): Unsubscribe {
    return this.bus.subscribe((env) => {
      if (env.event.type === 'peer_read_cursor_updated') cb(env.event);
    });
  }

  // ----- Transport pass-throughs -----

  onClose(cb: (event?: unknown) => void): Unsubscribe {
    return this.transport.on('close', cb);
  }

  onError(cb: (err: unknown) => void): Unsubscribe {
    return this.transport.on('error', cb);
  }

  // ----- Internal: incoming dispatch -----

  private handleIncoming(ctx: TransportContext): void {
    // Any inbound packet is a sign of life — bump the idle-heartbeat
    // activity tracker so we don't ping a busy connection.
    this.lastActivityMs = Date.now();
    // Auto-ACK Request-typed pushes BEFORE invoking user callbacks, so a
    // throwing handler can't leave the server hanging. Mirrors Rust SDK.
    if (ctx.packet.packetType === PacketType.Request) {
      switch (ctx.bizType) {
        case MessageType.PushMessageRequest:
          void ctx
            .respond(encodePushMessageResponse({ succeed: true }), {
              bizType: MessageType.PushMessageResponse,
            })
            .catch(() => {});
          break;
        case MessageType.PushBatchRequest:
          void ctx
            .respond(encodePushBatchResponse({ succeed: true }), {
              bizType: MessageType.PushBatchResponse,
            })
            .catch(() => {});
          break;
        // Other Request-typed inbound bizTypes are ignored for now.
      }
    }

    // Decode + emit on the L1 bus regardless of OneWay vs Request. The
    // bus owns fan-out + listener-error containment. When the cache is
    // enabled, also normalise + upsert into the local store (memory
    // synchronously, IndexedDB async).
    switch (ctx.bizType) {
      case MessageType.PushMessageRequest: {
        const message = decodePushMessageRequest(ctx.data);
        // Phase 5A: read-cursor system notifications piggyback on
        // PushMessageRequest with message_type=System (5). Intercept
        // BEFORE any user-visible event — these are SDK-internal sync
        // signals, not user messages, and must not surface via
        // onPushMessage / cache / unread_count.
        if (this.maybeConsumeReadCursorPush(message)) return;
        this.bus.emit({ type: 'message_received', message });
        this.absorbPushIntoCache(message);
        return;
      }
      case MessageType.PushBatchRequest: {
        // Server's send_read_cursor_event uses single-push routing, not
        // batches, so we don't expect system read-cursor notifications
        // inside PushBatch in practice. If that assumption breaks, add
        // a per-item filter here.
        const batch = decodePushBatchRequest(ctx.data);
        this.bus.emit({ type: 'message_batch_received', batch });
        for (const m of batch.messages) this.absorbPushIntoCache(m);
        return;
      }
      case MessageType.PongResponse:
        this.bus.emit({
          type: 'pong_received',
          pong: decodePongResponse(ctx.data),
        });
        return;
      case MessageType.PublishRequest:
        this.handlePublishRequest(ctx.data);
        return;
      default:
        // Unknown bizType — ignore. Application-layer logging belongs in
        // a future observability hook, not the protocol facade.
        return;
    }
  }

  /**
   * Dispatch a `PublishRequest` packet (msgtrans subscribe/publish channel).
   * The packet's `topic` decides what kind of notification this is:
   *
   *   - `"typing"`: TypingStatusNotification JSON → `typing_received` L1 event
   *   - other: ignored (forward-compat)
   *
   * Payload is JSON bytes (server uses serde_json + raw bytes wrapped
   * inside the FlatBuffers `payload` field). Decode failures are logged
   * and dropped — typing is best-effort and must not crash the inbound
   * loop.
   */
  private handlePublishRequest(bytes: Uint8Array): void {
    let parsed: PublishRequest;
    try {
      parsed = decodePublishRequest(bytes);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[privchat] failed to decode PublishRequest', e);
      return;
    }
    if (parsed.topic === 'typing') {
      this.dispatchTypingNotification(parsed);
      return;
    }
    // Non-typing topics → generic `channel_publish_received` event so the
    // application layer (e.g. game module table-state fan-out) can consume
    // room broadcasts. SDK does not interpret the payload; forward topic +
    // UTF-8-decoded payload text (game server publishes JSON).
    let payloadText = '';
    if (parsed.payload.length > 0) {
      try {
        payloadText = new TextDecoder().decode(parsed.payload);
      } catch {
        payloadText = '';
      }
    }
    this.bus.emit({
      type: 'channel_publish_received',
      channel_id: parsed.channel_id,
      topic: parsed.topic,
      payload_text: payloadText,
      publisher: parsed.publisher,
      timestamp: parsed.timestamp,
    });
  }

  /** Parse a TypingStatusNotification JSON payload and emit it as an
   *  L1 `typing_received` event. The wire shape mirrors server's
   *  `presence::TypingStatusNotification` Rust struct verbatim. */
  private dispatchTypingNotification(envelope: PublishRequest): void {
    if (envelope.payload.length === 0) return;
    let notif: {
      user_id?: number | string;
      channel_id?: number | string;
      channel_type?: number;
      is_typing?: boolean;
      action_type?: string | null;
      timestamp?: number;
    };
    try {
      notif = JSON.parse(new TextDecoder().decode(envelope.payload));
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[privchat] typing payload not JSON', e);
      return;
    }
    if (notif.user_id === undefined || notif.channel_id === undefined) return;
    if (notif.is_typing === undefined) return;
    this.bus.emit({
      type: 'typing_received',
      channel_id: String(notif.channel_id),
      channel_type: notif.channel_type ?? 0,
      user_id: String(notif.user_id),
      is_typing: notif.is_typing,
      action_type: notif.action_type ?? undefined,
      timestamp: notif.timestamp ?? Math.floor(Date.now() / 1000),
    });
  }

  // ----- Internal: cache write path -----

  /**
   * Apply a read-cursor advance to the local channel cache. Shared by
   * both `markRead()` (RPC success path) and the inbound
   * `self_read_pts_updated` system-push handler. MAX-merge against the
   * current `read_seq` so out-of-order RPC/push delivery is idempotent
   * and never regresses the cursor.
   *
   * Phase 5A semantics: a successful read advance zeros `unread_count`.
   * Phase 5B will refine this (server-returned partial unread counts).
   *
   * Caller must check `cacheStore !== null` (this method assumes cache
   * is enabled — bare-minimum branch protection).
   */
  private async applyReadCursorUpdate(
    channel_id: string,
    channel_type: number,
    new_read_pts: string,
  ): Promise<ApplyReadCursorUpdateResult> {
    if (this.cacheStore === null || this.cacheDb === null) {
      return { advanced: false, read_pts: new_read_pts };
    }
    const channel = this.cacheStore.getChannel(channel_id, channel_type);
    if (!channel) {
      // No local row for this channel yet (bootstrap not run, or new
      // channel arrived via push before bootstrap). Skip silently —
      // when the channel does appear, its server-provided
      // `read_pts` / `unread_count` will already be authoritative.
      // No `previous_read_pts` to report back; the caller treats this
      // as "non-advance" and suppresses the L1 event.
      return { advanced: false, read_pts: new_read_pts };
    }
    const previous = channel.read_pts;
    const incoming = BigInt(new_read_pts);
    const current = BigInt(previous);
    if (incoming <= current) {
      return { advanced: false, previous_read_pts: previous, read_pts: previous };
    }

    const next: ChannelRecord = {
      ...channel,
      read_pts: new_read_pts,
      unread_count: 0,
    };
    this.cacheStore.upsertChannel(next);
    void this.cacheDb.channels.put(next).catch(() => {});
    return { advanced: true, previous_read_pts: previous, read_pts: new_read_pts };
  }

  /** Centralised emit so both sources (`markRead` RPC echo + push
   *  handler) speak the same event shape. No-op when the merge didn't
   *  advance the local cursor — Phase 5D Decisions §3. */
  private maybeEmitReadCursorUpdated(
    result: ApplyReadCursorUpdateResult,
    channel_id: string,
    channel_type: number,
    reader_id: string,
    updated_at?: number,
  ): void {
    if (!result.advanced) return;
    this.bus.emit({
      type: 'read_cursor_updated',
      channel_id,
      channel_type,
      reader_id,
      read_pts: result.read_pts,
      previous_read_pts: result.previous_read_pts,
      updated_at,
    });
  }

  /**
   * Try to interpret an inbound PushMessageRequest as a system
   * `channel_read_cursor_updated` notification. Returns `true` when the
   * push WAS a read-cursor system event and was fully consumed (caller
   * MUST short-circuit and not run the normal message-absorb path).
   * Returns `false` for any other push.
   *
   * `self_read_pts_updated` → `applyReadCursorUpdate` (multi-device
   *     convergence with the local markRead path) + emit
   *     `read_cursor_updated` L1 event when the cache actually advanced.
   * `peer_read_pts_updated` → emit `peer_read_cursor_updated` L1 event
   *     (Phase 5D). Defensively suppressed when `channel_type !== 1`
   *     because group peer reads are query-based on the server, not
   *     push-based — receiving one is a server bug.
   * Unknown `visibility` → return `false` so the push falls through to
   *     normal handling. Forward-compat hatch for future system
   *     notifications.
   */
  private maybeConsumeReadCursorPush(push: PushMessageRequest): boolean {
    if (push.message_type !== CONTENT_MESSAGE_TYPE_SYSTEM) return false;
    const notif = tryDecodeReadCursorNotification(push.payload);
    if (notif === null) return false;
    const meta = notif.metadata;
    const channel_id = String(meta.channel_id);
    const channel_type = meta.channel_type;
    const reader_id = meta.reader_id;
    const read_pts = String(meta.read_pts);
    const updated_at = meta.updated_at;
    const visibility = meta.visibility;

    if (visibility === 'self_read_pts_updated') {
      // Apply asynchronously — the cache write is awaited inside
      // `applyReadCursorUpdate`, but we don't block the inbound
      // dispatch loop on it. Emit lands in the same microtask chain
      // AFTER the cache has been mutated, so handlers reading the
      // cache from inside the event observer see the new value.
      void this.applyReadCursorUpdate(channel_id, channel_type, read_pts).then(
        (result) => {
          this.maybeEmitReadCursorUpdated(
            result,
            channel_id,
            channel_type,
            reader_id,
            updated_at,
          );
        },
      );
      return true;
    }
    if (visibility === 'peer_read_pts_updated') {
      if (channel_type !== 1) {
        // eslint-disable-next-line no-console
        console.warn(
          `[privchat] dropped peer_read_pts_updated with channel_type=${channel_type} (expected 1; group peer reads are query-only)`,
          { channel_id, reader_id, read_pts },
        );
        return true;
      }
      // Persist the peer's read cursor on the local channel record. This
      // is the authoritative high-water mark — the UI projects "read by
      // peer" by comparing each self-sent message's pts against this
      // cursor. We deliberately do NOT mutate MessageRecord.status: read
      // receipts are a separate dimension from the send-state machine
      // (mirrors Rust SDK's `channel_extra.peer_read_pts` model).
      //
      // Only emit `peer_read_cursor_updated` when the cursor actually
      // advanced — duplicate / out-of-order pushes are silently
      // absorbed. This matches `self_read_pts_updated` / markRead's
      // monotonic semantics.
      const advanced = this.absorbPeerReadCursor(channel_id, channel_type, read_pts);
      if (!advanced) return true;

      this.bus.emit({
        type: 'peer_read_cursor_updated',
        channel_id,
        channel_type,
        reader_id,
        read_pts,
        updated_at,
      });
      return true;
    }
    return false;
  }

  /**
   * Patch the local cache + IDB with new pinned/muted/hidden flags
   * after a successful `channelPin` / `channelMute` / `channelHide`
   * RPC. The server has already persisted; this is the local-cache
   * mirror so observers (`observeChannelList`) fire and the UI
   * reflects the change without waiting for the next entity sync.
   *
   * Pure flag patch: only the keys provided in `flags` are written;
   * `undefined` fields are skipped. No-op when cache is disabled or
   * the channel doesn't exist locally yet.
   */
  applyChannelFlags(
    channel_id: string,
    flags: { pinned?: boolean; muted?: boolean; hidden?: boolean },
  ): void {
    if (this.cacheStore === null || this.cacheDb === null) return;
    // R6.c: channel_id is the canonical identity; the message store's
    // `getChannel` accepts the legacy compound signature but the
    // channel_type arg is ignored (cache key collapsed to channel_id
    // in v3/v4).
    const channel = this.cacheStore.getChannel(channel_id, 0);
    if (!channel) return;
    let next = channel;
    let mutated = false;
    if (flags.pinned !== undefined && next.pinned !== flags.pinned) {
      next = { ...next, pinned: flags.pinned };
      mutated = true;
    }
    if (flags.muted !== undefined && next.muted !== flags.muted) {
      next = { ...next, muted: flags.muted };
      mutated = true;
    }
    if (flags.hidden !== undefined && next.hidden !== flags.hidden) {
      next = { ...next, hidden: flags.hidden };
      mutated = true;
    }
    if (!mutated) return;
    this.cacheStore.upsertChannel(next);
    void this.cacheDb.channels.put(next).catch(() => {});
  }

  /**
   * MAX-merge an inbound peer cursor into `ChannelRecord.peer_read_pts`.
   * Returns `true` iff the persisted cursor advanced (and observers
   * therefore should be notified). No-op when cache is disabled or the
   * channel record is not yet known locally.
   */
  private absorbPeerReadCursor(
    channel_id: string,
    channel_type: number,
    peer_read_pts: string,
  ): boolean {
    if (this.cacheStore === null || this.cacheDb === null) return false;
    const channel = this.cacheStore.getChannel(channel_id, channel_type);
    if (!channel) return false;

    const incoming = BigInt(peer_read_pts);
    const previous =
      channel.peer_read_pts !== undefined ? BigInt(channel.peer_read_pts) : -1n;
    if (incoming <= previous) return false;

    const next: ChannelRecord = { ...channel, peer_read_pts };
    this.cacheStore.upsertChannel(next);
    void this.cacheDb.channels.put(next).catch(() => {});
    return true;
  }

  /**
   * Absorb an inbound PushMessageRequest into the cache. Synchronous in
   * memory (so observers fire immediately), async in IndexedDB (UI
   * doesn't wait on storage). Bumps channel.latest_pts + unread_count
   * + last_message_preview when applicable.
   *
   * No-op when cache is disabled.
   */
  private absorbPushIntoCache(push: PushMessageRequest): void {
    if (this.cacheStore === null || this.cacheDb === null) return;
    const incoming = pushToMessageRecord(push);

    // Local-trumps-self-push merge. Direct-channel push fan-out delivers
    // a copy of our own outgoing message back to us; without this guard
    // the push (status='received', content='') would silently regress
    // a row our local-echo / outbox-flush ACK already promoted to
    // 'sent'. See `cache/merge.ts` for the rule set.
    const incomingKey = messageRecordKey(incoming);
    const existing = this.cacheStore
      .getMessages(incoming.channel_id, incoming.channel_type)
      .find((m) => messageRecordKey(m) === incomingKey);
    const record = mergeOnPushAbsorb(existing, incoming, {
      currentUserId: this.lastAuth?.user_id,
    });

    // 1. Memory: synchronous emit to observers.
    this.cacheStore.upsertMessage(record, true);

    // 2. Channel-side bookkeeping: latest_pts + last_message_preview + unread.
    const channel = this.cacheStore.getChannel(record.channel_id, record.channel_type);
    if (channel && record.pts !== undefined) {
      const ptsBig = BigInt(record.pts);
      let next = channel;
      let mutated = false;
      // Track whether this push is the channel's new latest: when so,
      // a fresh non-revoked message clears the prior `last_message_revoked`
      // flag, while a revoked-pts-equal-latest push raises it.
      const wasLatest = ptsBig === BigInt(channel.latest_pts);
      const becomesLatest = ptsBig > BigInt(channel.latest_pts);
      if (becomesLatest) {
        next = { ...next, latest_pts: record.pts };
        mutated = true;
      }
      if (record.timestamp > channel.updated_at) {
        next = { ...next, updated_at: record.timestamp };
        mutated = true;
        // Refresh the channel-list preview to the most recent message.
        // Only when timestamp is actually advancing (so an out-of-order
        // push doesn't replace a newer preview with an older one) and only
        // for non-revoked rows. `derivePreview` resolves the content type
        // (the UI renders a localized placeholder for non-text); an empty
        // *text* preview is dropped — keep the prior line.
        if (!record.revoked) {
          const preview = derivePreview(record.content, record.message_type);
          if (preview.content_type !== 'text' || preview.text !== '') {
            next = {
              ...next,
              last_message_preview: preview.text,
              last_message_type: preview.content_type,
            };
          }
        }
      }
      // Latest-message revoke handling. Two cases land here:
      //   - the latest message was just revoked (existing row's
      //     `revoked` flipped via mergeOnPushAbsorb; record.revoked
      //     is now true and pts === channel.latest_pts)
      //   - a brand-new revoke push happens to be the highest pts
      //     yet (becomesLatest && record.revoked)
      // Either way, set the channel-side `last_message_revoked` flag
      // so the conversation-list VM renders "[已撤回]" instead of the
      // stale preview text.
      if (record.revoked && (wasLatest || becomesLatest)) {
        if (next.last_message_revoked !== true) {
          next = { ...next, last_message_revoked: true };
          mutated = true;
        }
      } else if (
        becomesLatest &&
        !record.revoked &&
        next.last_message_revoked === true
      ) {
        // A fresh non-revoked message replaced the previously-revoked
        // tail — clear the flag.
        next = { ...next, last_message_revoked: false };
        mutated = true;
      }
      // Bump unread_count when this push is NEW past read_pts AND not
      // sent by the current user (best-effort: lastAuth.user_id check).
      const isOwnMessage = this.lastAuth?.user_id === record.from_uid;
      if (!isOwnMessage && !record.revoked && ptsBig > BigInt(channel.read_pts)) {
        next = { ...next, unread_count: channel.unread_count + 1 };
        mutated = true;
      }
      if (mutated) {
        this.cacheStore.upsertChannel(next);
        void this.cacheDb.channels.put(next).catch(() => {});
      }
    }

    // 3. IndexedDB: async, fire-and-forget. UI never waits.
    void cacheUpsertMessage(this.cacheDb, record).catch(() => {});
  }

  // ----- Internal: state + reconnect -----

  private setState(next: ConnectionState, reason?: string): void {
    if (this.state === next) return;
    const prev = this.state;
    this.state = next;
    this.bus.emit({ type: 'connection_state_changed', state: next, reason });
    // Idle-heartbeat: arm only while authenticated. Any other transition
    // (closing, disconnected, reconnecting, authenticating, connected,
    // connecting) must stop the timer so we don't ping a half-ready or
    // teardown-in-progress connection.
    if (next === 'authenticated') {
      this.startHeartbeat();
    } else if (prev === 'authenticated') {
      this.stopHeartbeat();
    }
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempt = 0;
  }

  // ----- Internal: idle heartbeat -----

  /** Arm the idle-heartbeat timer. Called on transition into
   *  `authenticated`. Idempotent — re-arming an already-armed timer
   *  cancels the old one first. */
  private startHeartbeat(): void {
    if (!this.heartbeatOpts.enabled) return;
    this.stopHeartbeat();
    // Treat the moment we became authenticated as the baseline activity
    // — otherwise the first tick would fire a ping immediately after
    // login.
    this.lastActivityMs = Date.now();
    this.heartbeatTimer = setTimeout(
      () => this.heartbeatTick(),
      this.heartbeatOpts.intervalMs,
    );
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * Heartbeat tick handler. Fired by the timer. Behaviour:
   *
   *   - If state is no longer `authenticated`, bail (defensive — setState
   *     should have already stopped us, but a queued tick could land
   *     after).
   *   - If recent activity is within `intervalMs`, reschedule without
   *     sending a ping (idle-aware).
   *   - Otherwise send `client.ping()` with `timeoutMs`. On success,
   *     reschedule. On failure, close the transport — `handleTransportClose`
   *     then drives the existing auto-reconnect path.
   */
  private heartbeatTick(): void {
    this.heartbeatTimer = null;
    if (this.state !== 'authenticated') return;

    const sinceLast = Date.now() - this.lastActivityMs;
    if (sinceLast < this.heartbeatOpts.intervalMs) {
      // Recent traffic; reschedule for the remaining slice + small fudge.
      this.heartbeatTimer = setTimeout(
        () => this.heartbeatTick(),
        Math.max(1_000, this.heartbeatOpts.intervalMs - sinceLast),
      );
      return;
    }

    void this.runHeartbeatPing();
  }

  private async runHeartbeatPing(): Promise<void> {
    try {
      await this.ping(
        { timestamp: Date.now() },
        { timeoutMs: this.heartbeatOpts.timeoutMs },
      );
    } catch {
      // Treat any failure (timeout, transport error, auth race) the
      // same way: close the transport so the existing close-handler
      // schedules reconnect with replay credentials. We do NOT call
      // setState here — `transport.close()` → `handleTransportClose()`
      // owns the transition.
      try {
        await this.transport.close();
      } catch {
        // Best-effort: even if close throws, the next inbound/outbound
        // failure will eventually trip the same path.
      }
      return;
    }
    // Success: pong arrived (handleIncoming already bumped lastActivityMs).
    // Reschedule for the next interval.
    if (this.state === 'authenticated' && this.heartbeatOpts.enabled) {
      this.heartbeatTimer = setTimeout(
        () => this.heartbeatTick(),
        this.heartbeatOpts.intervalMs,
      );
    }
  }

  /**
   * Transport closed unexpectedly. If the caller initiated `disconnect()`,
   * we already handled it; otherwise schedule reconnect (when enabled and
   * a previous `authenticate` exists to replay).
   */
  private handleTransportClose(): void {
    if (this.userInitiatedDisconnect) {
      // disconnect() already drove the state machine; nothing to do.
      return;
    }
    if (!this.reconnectOpts.enabled || this.lastAuth === null) {
      // No replay credentials → can't auto-restore. Settle to disconnected.
      this.setState('disconnected', 'transport closed');
      return;
    }
    this.setState('reconnecting', 'transport closed');
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempt >= this.reconnectOpts.maxAttempts) {
      this.setState('disconnected', 'reconnect attempts exhausted');
      this.reconnectAttempt = 0;
      return;
    }
    const attempt = this.reconnectAttempt++;
    const delay = Math.min(
      this.reconnectOpts.maxDelayMs,
      this.reconnectOpts.initialDelayMs * Math.pow(this.reconnectOpts.multiplier, attempt),
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.attemptReconnect();
    }, delay);
  }

  private async attemptReconnect(): Promise<void> {
    if (this.userInitiatedDisconnect || this.lastAuth === null) return;
    try {
      await this.transport.connect();
    } catch (e) {
      this.scheduleReconnect();
      return;
    }
    this.setState('connected');
    // Replay last authenticate (clears lastAuth on terminal failure).
    const { user_id, access_token, device_id } = this.lastAuth;
    try {
      await this.authenticate(user_id, access_token, device_id);
    } catch (e) {
      // authenticate() already emitted auth_expired + adjusted state.
      // Stop the reconnect cycle — business layer must refresh / re-login.
      if (e instanceof AuthorizationError && e.errorKind === 'terminal') {
        this.lastAuth = null;
      }
      this.cancelReconnect();
      return;
    }
    // Auth succeeded → replay subscriptions (best-effort; surface failures via events).
    for (const req of this.activeSubscriptions.values()) {
      try {
        await this.subscribe(req);
      } catch {
        /* keep going; failed re-subscribes can be retried by the app */
      }
    }
    // Phase 5B-1d: gap-fill sync after subscriptions are restored. Best-effort —
    // a per-channel sync failure does NOT regress the reconnect state. The next
    // reconnect (or an explicit `syncChannel`) is the natural retry point.
    await this.syncOnReconnect();
    // Phase 5C-1d: flush the outbox AFTER sync. Order is load-bearing —
    // sync-arrived ACKs (server committed our send but the original ACK
    // never reached us) drop the matching outbox row first, so this
    // flush never re-sends a message the server already accepted.
    await this.flushOutboxOnReconnect();
    this.cancelReconnect();
  }

  /**
   * Iterate every active subscription and trigger a per-channel
   * `sync/get_difference` pass. Runs in parallel via `Promise.allSettled`
   * so one channel's failure can't cascade. Per-channel mutex inside
   * `SyncEngine` ensures a redundant in-flight syncChannel call doesn't
   * double-RPC a channel.
   *
   * No-op when:
   *   - cache is disabled (no `syncEngine`), or
   *   - there are no active subscriptions.
   *
   * Failures emit a `console.warn` only — the SDK does NOT add a per-channel
   * sync-failed L1 event in 5B-1 to keep the surface narrow.
   */
  /**
   * Drain the outbox after reconnect lands. Best-effort — a flush
   * failure does NOT regress the reconnect state. Runs AFTER
   * `syncOnReconnect()` so server-side commits whose ACK was lost in
   * the previous connection are observed first; the engine then
   * deletes the matching outbox row without re-sending.
   *
   * No-op when outbox is disabled (cache off, or
   * `outbox.enabled: false`).
   */
  private async flushOutboxOnReconnect(): Promise<void> {
    if (this.outboxEngine === null) return;
    try {
      await this.flushOutbox();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[privchat:outbox] reconnect-flush failed', {
        error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      });
    }
  }

  private async syncOnReconnect(): Promise<void> {
    if (this.syncEngine === null) return;
    const subs = [...this.activeSubscriptions.values()];
    if (subs.length === 0) return;
    const results = await Promise.allSettled(
      subs.map((sub) => this.syncChannel(sub.channel_id, sub.channel_type)),
    );
    for (let i = 0; i < results.length; i++) {
      const result = results[i]!;
      if (result.status === 'rejected') {
        const sub = subs[i]!;
        // eslint-disable-next-line no-console
        console.warn('[privchat:sync] reconnect-sync failed', {
          channel_id: sub.channel_id,
          channel_type: sub.channel_type,
          error:
            result.reason instanceof Error
              ? `${result.reason.name}: ${result.reason.message}`
              : String(result.reason),
        });
      }
    }
  }
}

// ----- Errors -----

export class AuthorizationError extends Error {
  readonly response: AuthorizationResponse;
  /** Numeric auth-band error code (server `error_code`, fallback parsed from message prefix). 0 when absent. */
  readonly errorCode: number;
  /** Recovery classification per `TOKEN_REFRESH_SPEC` — drives whether the
   *  business layer should attempt refresh, force re-login, or just retry. */
  readonly errorKind: AuthErrorKind;
  constructor(response: AuthorizationResponse) {
    const explicit = response.error_code ?? 0;
    const parsed = parseAuthErrorPrefix(response.error_message);
    const code = explicit !== 0 ? explicit : (parsed ?? 0);
    const message = response.error_message ?? 'authorization failed';
    super(`[${code}] ${message}`);
    this.name = 'AuthorizationError';
    this.response = response;
    this.errorCode = code;
    this.errorKind = classifyAuthErrorCode(code);
  }
}

export class SubscribeError extends Error {
  readonly action: 'subscribe' | 'unsubscribe';
  readonly response: SubscribeResponse;
  constructor(action: 'subscribe' | 'unsubscribe', response: SubscribeResponse) {
    super(`${action} failed: reason_code=${response.reason_code}`);
    this.name = 'SubscribeError';
    this.action = action;
    this.response = response;
  }
}

export class RpcError extends Error {
  readonly route: string;
  readonly response: RpcResponse;
  /** When `response.code` falls in the auth band (10000..10099), this is its
   *  recovery classification — `undefined` for non-auth RPC failures. */
  readonly errorKind: AuthErrorKind | undefined;
  constructor(route: string, response: RpcResponse) {
    super(`rpc ${route} failed: code=${response.code} message=${response.message}`);
    this.name = 'RpcError';
    this.route = route;
    this.response = response;
    this.errorKind =
      response.code >= 10000 && response.code <= 10099
        ? classifyAuthErrorCode(response.code)
        : undefined;
  }
}

/**
 * Thrown by `refreshAccessToken()` when the server rejects the refresh
 * (10009 RefreshTokenExpired / 10010 RefreshTokenRevoked / etc.). Always
 * `errorKind === 'terminal'` — the business layer must force re-login.
 */
export class RefreshTokenError extends Error {
  readonly errorCode: number;
  readonly errorKind: AuthErrorKind;
  constructor(code: number, message: string) {
    super(`[${code}] ${message}`);
    this.name = 'RefreshTokenError';
    this.errorCode = code;
    this.errorKind = classifyAuthErrorCode(code);
  }
}

/**
 * Thrown by `bootstrapChannels` / `cachedChannels` / `observeChannelList`
 * (and the upcoming `openConversation` / `scrollHistory` / etc.) when
 * `new PrivchatClient(...)` was constructed without `cache.enabled: true`.
 */
export class CacheDisabledError extends Error {
  constructor() {
    super(
      'Cache is disabled. Pass `cache: { enabled: true }` to the PrivchatClient constructor to use cache APIs.',
    );
    this.name = 'CacheDisabledError';
  }
}

/**
 * Thrown by `markRead()` when the server rejects the request — most
 * commonly when `read_pts > server's current_pts` (race: client thought
 * it had a higher pts than the server has actually emitted). Wraps the
 * underlying RpcResponse so callers can inspect `code` / `message`. The
 * SDK does NOT predict this locally — `channel.latest_pts` may lag the
 * server, so trust the server's verdict.
 */
export class MarkReadValidationError extends Error {
  readonly channel_id: string;
  readonly channel_type: number;
  readonly read_pts: string;
  readonly response: RpcResponse;
  constructor(
    channel_id: string,
    channel_type: number,
    read_pts: string,
    response: RpcResponse,
  ) {
    super(
      `markRead(${channel_id}, ${channel_type}, ${read_pts}) rejected by server: code=${response.code} message=${response.message}`,
    );
    this.name = 'MarkReadValidationError';
    this.channel_id = channel_id;
    this.channel_type = channel_type;
    this.read_pts = read_pts;
    this.response = response;
  }
}

// ----- Internal helpers -----

function omitId(d: DeviceInfo): Omit<DeviceInfo, 'device_id'> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { device_id: _id, ...rest } = d;
  return rest;
}

function subKey(channelId: string, channelType: number): string {
  return `${channelId}::${channelType}`;
}

function stringifyReason(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

/** Format a transient send error for the outbox `last_error` field.
 *  Prefix discriminates transient (auto-retryable) from rejected
 *  (host-action-required) so the 5C-1c flush engine can branch
 *  without re-parsing the entire wire response. */
function formatTransientError(e: unknown): string {
  if (e instanceof Error) return `transient: ${e.name}: ${e.message}`;
  return `transient: ${String(e)}`;
}

