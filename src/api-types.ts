// Typed RPC Request/Response shapes for the SDK convenience methods.
// Field naming is snake_case to match server wire format. u64 IDs are
// JSON numbers (server-side serde emits them as numbers) — the bigint
// boundary only applies to FlatBuffers fields, not RPC JSON.
//
// IMPORTANT: shapes mirror the WIRE, not necessarily the Rust struct
// definition (which has been observed to drift, e.g. the blacklist
// shapes pre-fix). When in doubt, the server `Ok(json!({ ... }))` is
// the source of truth.

// ---------- account/user/register ----------

export interface UserRegisterRequest {
  username: string;
  password: string;
  device_id: string;
  nickname?: string;
  phone?: string;
  email?: string;
  device_info?: {
    device_id: string;
    device_type: string;
    app_id: string;
    push_token?: string;
    push_channel?: string;
    device_name: string;
    device_model?: string;
    os_version?: string;
    app_version?: string;
    manufacturer?: string;
    device_fingerprint?: string;
  };
}

/** Wire shape for register/login auth bundles. */
export interface AuthResponse {
  user_id: number;
  token: string;
  refresh_token?: string;
  expires_at: number;
  device_id: string;
}

// ---------- account/search/query ----------

export interface AccountSearchQueryRequest {
  query: string;
  page?: number;
  page_size?: number;
  /** Server fills this from auth context; accept 0 from client. */
  from_user_id?: number;
}

export interface SearchedUser {
  user_id: number;
  username: string;
  nickname: string;
  avatar_url?: string;
  user_type: number;
  /** Server-issued opaque token correlating the apply back to the
   *  search query. It's a u64 snowflake and EXCEEDS Number.MAX_SAFE_INTEGER
   *  in production — represented as a decimal string at the SDK boundary
   *  so values like `574978476566777861` don't collapse to nearby
   *  float64 multiples (we hit this in the wild as 10004 "Search record
   *  not found" because `JSON.parse` had rounded the value). */
  search_session_id: string;
  is_friend: boolean;
  can_send_message: boolean;
}

export interface AccountSearchResponse {
  users: SearchedUser[];
  total: number;
  query: string;
}

// ---------- contact/friend/* ----------

// account/bot ------------------------------------------------------------
// Mirrors `privchat_protocol::rpc::account::bot` (Rust).
// Spec: `02-server/SERVICE_ACCOUNT_FOLLOW_SPEC` §2.

export interface BotFollowRequest {
  bot_user_id: number;
}

export interface BotFollowResponse {
  bot_user_id: number;
  /** Direct channel id; subsequent Subscribe / Transfer / SendMessage all use this. */
  channel_id: number;
  /** v1.0 always 2 (Bot); reserved for future System / Official extension. */
  account_user_type: number;
  followed: boolean;
  /** `true` = newly created or revived from unfollowed; `false` = already-followed idempotent reuse. */
  created: boolean;
}

export interface BotUnfollowRequest {
  bot_user_id: number;
}

export interface BotUnfollowResponse {
  bot_user_id: number;
  /** Existing direct channel id (preserved — never deleted by unfollow); `0` if never followed. */
  channel_id: number;
  /** `true` = relation flipped to unfollowed; `false` = no-op (was not following). */
  unfollowed: boolean;
}

export interface FriendApplyRequest {
  target_user_id: number;
  message?: string;
  source?: string;
  source_id?: string;
  /** Server fills from auth ctx. */
  from_user_id?: number;
}

export interface FriendApplyResponse {
  user_id: number;
  username: string;
  status: string;
  added_at: number;
  message?: string | null;
}

export interface FriendAcceptRequest {
  from_user_id: number;
  message?: string;
  /** Server fills from auth ctx. */
  target_user_id?: number;
}

/** Server returns bare u64 channel_id, not a wrapped object. */
export type FriendAcceptResponse = number;

export interface FriendPendingRequest {
  /** Server fills from auth ctx. */
  user_id?: number;
}

export interface FriendPendingItem {
  from_user_id: number;
  user: SearchedUser;
  message?: string;
  created_at: number;
}

export interface FriendPendingResponse {
  requests: FriendPendingItem[];
  total: number;
}

export interface FriendCheckRequest {
  friend_id: number;
  /** Server fills from auth ctx. */
  user_id?: number;
}

/** Wire shape. Server returns is_friend + the IDs it resolved. */
export interface FriendCheckResponse {
  is_friend: boolean;
  user_id: number;
  friend_id: number;
}

export interface FriendRemoveRequest {
  friend_id: number;
  /** Server fills from auth ctx. */
  user_id?: number;
}

export type FriendRemoveResponse = boolean;

export interface FriendSetAliasRequest {
  /** Target friend's user_id (NOT the caller — the caller comes from auth ctx). */
  user_id: number;
  alias: string;
}

export type FriendSetAliasResponse = boolean;

// ---------- file/* ----------

export interface FileRequestUploadTokenRequest {
  user_id: number;
  filename?: string;
  file_size: number;
  mime_type: string;
  /** "image" | "video" | "voice" | "file" | "other" */
  file_type: string;
  /** "message" | "avatar" | "group_avatar" | ... */
  business_type: string;
}

export interface FileRequestUploadTokenResponse {
  token: string;
  upload_url: string;
  /** Empty string at request stage; the actual file_id is returned by
   *  the upload endpoint. */
  file_id: string;
  expires_at?: number;
  max_size?: number;
}

export interface FileUploadCallbackRequest {
  file_id: string;
  user_id: number;
  status: string;
}

export type FileUploadCallbackResponse = boolean;

export interface FileGetUrlRequest {
  file_id: number;
}

export interface FileGetUrlResponse {
  file_url: string;
  expires_at: number;
  file_size: number;
  mime_type: string;
  /** 原始文件名（file 表数据；Scheme B 下 filename/size/mime 均由 get_url 下发，
   *  不进消息 typed metadata）。 */
  original_filename?: string;
  /** 附件加密版本：0=明文 legacy；1=AES-256-GCM。缺省按 0。 */
  encryption_version?: number;
  /** 内容密钥（base64url 32B）；仅鉴权后此响应携带，绝不进 URL/日志。v0 为 null。 */
  cek?: string | null;
}

/**
 * The HTTP `POST /api/app/files/upload` endpoint's response shape (NOT
 * an RPC). Returned by the multipart upload after a successful token
 * exchange.
 */
export interface FileUploadResult {
  /** u64 snowflake; lossless parse → number-or-string (see safe-json). */
  file_id: number | string;
  file_url: string;
  thumbnail_url?: string | null;
  file_size: number;
  original_size?: number | null;
  width?: number | null;
  height?: number | null;
  mime_type: string;
  uploaded_at: number;
  storage_source_id: number;
}

// ---------- contact/blacklist/* ----------

export interface BlacklistAddRequest {
  user_id: number;
  blocked_user_id: number;
}

export type BlacklistAddResponse = boolean;

export interface BlacklistRemoveRequest {
  user_id: number;
  blocked_user_id: number;
}

export type BlacklistRemoveResponse = boolean;

export interface BlacklistListRequest {
  user_id: number;
}

export interface BlacklistUserInfo {
  user_id: number;
  blocked_user_id: number;
  /** ISO8601 / RFC3339 timestamp from server (chrono `DateTime<Utc>`). */
  blocked_at: string;
  reason?: string | null;
}

export interface BlacklistListResponse {
  success: boolean;
  users: BlacklistUserInfo[];
}

export interface BlacklistCheckRequest {
  user_id: number;
  target_user_id: number;
}

export interface BlacklistCheckResponse {
  success: boolean;
  blocked: boolean;
}

// ---------- channel/* ----------

export interface GetOrCreateDirectChannelRequest {
  target_user_id: number;
  source?: string;
  source_id?: string;
  /** Server fills from auth ctx. */
  user_id?: number;
}

export interface GetOrCreateDirectChannelResponse {
  channel_id: number;
  created: boolean;
}

export interface ChannelPinRequest {
  channel_id: number;
  pinned: boolean;
}
export type ChannelPinResponse = boolean;

export interface ChannelHideRequest {
  channel_id: number;
}
export type ChannelHideResponse = boolean;

export interface ChannelMuteRequest {
  channel_id: number;
  muted: boolean;
}
export type ChannelMuteResponse = boolean;

// ---------- group/* ----------

export interface GroupCreateRequest {
  name: string;
  description?: string;
}

export interface GroupCreateResponse {
  group_id: number;
  name: string;
  description: string;
  member_count: number;
  created_at: number;
  creator_id: number;
}

export interface GroupInfoRequest {
  group_id: number;
}

export interface GroupInfo {
  group_id: number;
  name: string;
  description?: string;
  avatar_url?: string;
  owner_id: number;
  created_at: number;
  updated_at: number;
  member_count: number;
  message_count: number;
  is_archived: boolean;
  tags?: string[];
  custom_fields?: Record<string, unknown>;
}

export interface GroupMemberSummary {
  user_id: number;
  role: string;
  joined_at: number;
  last_active: number;
  is_muted: boolean;
  display_name: string;
}

export interface GroupInfoResponse {
  status: string;
  group_info: GroupInfo;
  members: GroupMemberSummary[];
  timestamp: number;
}

export interface GroupMemberAddRequest {
  group_id: number;
  user_id: number;
  role?: string;
}
export type GroupMemberAddResponse = boolean;

export interface GroupMemberListRequest {
  group_id: number;
}

export interface GroupMember {
  user_id: number;
  username: string;
  nickname: string;
  avatar_url?: string;
  role: string;
  joined_at: number;
  is_muted: boolean;
}

export interface GroupMemberListResponse {
  members: GroupMember[];
  total: number;
}

export interface GroupMemberLeaveRequest {
  group_id: number;
}
export type GroupMemberLeaveResponse = boolean;

// ----- Group role / transfer -----
// Wire shape mirrors `privchat_protocol::rpc::group::role_set` and
// `::transfer`. The server reads `operator_id` / `current_owner_id`
// from the request body for the permission check (it does NOT silently
// substitute the session uid), so the SDK forwards them verbatim and
// the caller (React adapter) fills them from `sessionSnapshot()`.

/** Role value carried on the `group/role/set` wire. Owner cannot be
 *  assigned via this RPC — use `group/role/transfer_owner` for that. */
export type GroupRoleSetValue = 'admin' | 'member';

export interface GroupRoleSetRequest {
  group_id: number;
  /** Caller's user id; server validates this is the group owner. */
  operator_id: number;
  /** Member being promoted / demoted. */
  user_id: number;
  role: GroupRoleSetValue;
}

export interface GroupRoleSetResponse {
  group_id: number;
  user_id: number;
  role: string;
  /** Unix epoch ms when the role flipped; absent on no-op (server
   *  observed the member already had that role). */
  updated_at?: number;
}

export interface GroupTransferOwnerRequest {
  group_id: number;
  /** Caller's user id; server validates this matches the current owner. */
  current_owner_id: number;
  new_owner_id: number;
}

export interface GroupTransferOwnerResponse {
  group_id: number;
  new_owner_id: number;
  transferred_at?: number;
}

// ----- Group settings -----
// Wire shape mirrors `privchat_protocol::rpc::group::settings`.
// Server route group: `group/settings/{get, update, mute_all}`.
//
// `name` and `avatar_url` are deliberately ABSENT from the patch
// shape — those are PLATFORM-mode-only fields edited via
// privchat-application HTTP endpoints (parallel to how member
// profile name/avatar are edited). The IM server's RPC layer
// intentionally does NOT carry them. SDKs should display name +
// avatar from `GroupInfoResponse` and route user-side edits through
// the PLATFORM application HTTP path when those endpoints land.

/** All fields optional — caller sends a partial patch; server merges
 *  it into the persisted row. Setting a string field to `''` clears
 *  it; omitting the field leaves it unchanged. */
export interface GroupSettingsPatch {
  join_need_approval?: boolean;
  member_can_invite?: boolean;
  all_muted?: boolean;
  max_members?: number;
  announcement?: string;
  description?: string;
  /** Whether group members may add each other as friends directly. */
  allow_member_add_friend?: boolean;
  /** Whether the group is discoverable via search. */
  allow_search?: boolean;
  /** Join policy: 0 = no join, 1 = approval required, 2 = open join. */
  join_policy?: number;
}

export interface GroupSettingsData {
  join_need_approval: boolean;
  member_can_invite: boolean;
  all_muted: boolean;
  max_members: number;
  announcement?: string;
  description?: string;
  /** Whether group members may add each other as friends directly. */
  allow_member_add_friend?: boolean;
  /** Whether the group is discoverable via search. */
  allow_search?: boolean;
  /** Join policy: 0 = no join, 1 = approval required, 2 = open join. */
  join_policy?: number;
  created_at: number;
  updated_at: number;
}

export interface GroupSettingsGetResponse {
  group_id: number;
  settings: GroupSettingsData;
}

export interface GroupSettingsUpdateResponse {
  success: boolean;
  group_id: string;
  message: string;
  updated_count: number;
  updated_at: number;
}

export interface GroupMuteAllResponse {
  success: boolean;
  group_id: string;
  all_muted: boolean;
  message: string;
  operator_id: string;
  updated_at: number;
}

export interface GroupMemberRemoveRequest {
  group_id: number;
  user_id: number;
}
export type GroupMemberRemoveResponse = boolean;

export interface GroupMemberMuteRequest {
  group_id: number;
  user_id: number;
  /** Mute duration in seconds; 0 = permanent. */
  mute_duration: number;
}
export type GroupMemberMuteResponse = boolean;

export interface GroupMemberUnmuteRequest {
  group_id: number;
  user_id: number;
}
export type GroupMemberUnmuteResponse = boolean;

// ---------- message/pin ----------

/** Pin / unpin a group message (owner / admin only). `pinned=false` unpins. */
export interface MessagePinRequest {
  group_id: number;
  /** Communication channel the message lives in (equals group_id for groups). */
  channel_id: number;
  message_id: number;
  pinned: boolean;
}

export interface MessagePinResponse {
  success: boolean;
  group_id: number;
  message_id: number;
  pinned: boolean;
  /** Pin time in epoch millis; null when unpinned. */
  pinned_at?: number;
  /** Operator who pinned; null when unpinned. */
  pinned_by?: number;
}

export interface MessagePinListRequest {
  group_id: number;
}

export interface PinnedMessageItem {
  message_id: number;
  channel_id: number;
  pinned_by: number;
  pinned_at: number;
}

export interface MessagePinListResponse {
  group_id: number;
  items: PinnedMessageItem[];
}

// ---------- message/* ----------

export interface MessageHistoryGetRequest {
  channel_id: number;
  limit?: number;
  before_server_message_id?: number;
}

export interface HistoricalMessage {
  /** Server-assigned snowflake. The wire emits this as a JSON number;
   *  callers that need precision (snowflake values can exceed
   *  Number.MAX_SAFE_INTEGER) should stringify at the boundary. */
  message_id: number;
  channel_id: number;
  sender_id: number;
  content: string;
  /**
   * Application content type as a string ("text" / "image" / "voice" / ...).
   * Server emits via `MessageType::as_str()`, NOT the FlatBuffers numeric tag.
   */
  message_type: string;
  timestamp: number;
  /**
   * Per-channel pts. Same value as `SendMessageResponse.message_seq` and
   * `PushMessageRequest.message_seq` for the corresponding row. Used by
   * the cache to project `read_by_peer` (compares against
   * `ChannelRecord.peer_read_pts`). May be undefined for legacy rows
   * that pre-date pts assignment.
   */
  message_seq?: number;
  reply_to_message_id?: number;
  metadata?: unknown;
  revoked?: boolean;
  revoked_at?: number;
  revoked_by?: number;
}

export interface MessageHistoryResponse {
  messages: HistoricalMessage[];
  total: number;
  has_more: boolean;
}

export interface MessageRevokeRequest {
  server_message_id: number;
  channel_id: number;
}
export type MessageRevokeResponse = boolean;

// ---------- message/status/read_pts ----------

export interface MarkReadRequest {
  channel_id: number;
  read_pts: number;
  /** Optional message_id of the highest message the user has visually
   *  consumed. Server uses it to align its delivery_tracker. */
  last_read_message_id?: number;
  /** Optional "I have only seen up to X" pts; server clamps the
   *  effective read position to MIN(read_pts, client_visible_pts).
   *  Mostly relevant for virtualised lists. */
  client_visible_pts?: number;
}

/**
 * Wire shape of `message/status/read_pts` response.
 * Server source: `MessageStatusReadPtsResponse` + `Ok(json!({...}))` in
 * `privchat-server/src/rpc/message/status/read_pts.rs`.
 *
 * `accepted_read_pts` is the canonical truth post-clamp; callers should
 * prefer it over the request value when updating local state.
 */
export interface MarkReadResult {
  status: string;
  channel_id: number;
  last_read_pts: number;
  accepted_read_pts?: number;
  last_read_message_id?: number;
  server_delivered_pts?: number;
  message?: string;
}

// ---------- inbound system notification: channel_read_cursor_updated ----------
//
// The server piggybacks read-cursor updates onto the existing PushMessageRequest
// channel using ContentMessageType::System (numeric 5). The push's `payload`
// bytes are JSON of ChannelReadCursorNotification — NOT a FlatBuffers
// MessagePayloadEnvelope. The SDK detects this via `message_type === 5`
// and decodes the JSON to dispatch self/peer cursor updates internally.

export type ReadCursorVisibility =
  | 'self_read_pts_updated'
  | 'peer_read_pts_updated';

export interface ChannelReadCursorNotificationMetadata {
  /** Always literal "channel_read_cursor_updated" — the discriminator
   *  for self vs peer is the `visibility` field below, NOT this one. */
  notification_type: string;
  /** u64 on the wire as a raw JSON number. Parsed losslessly: values
   *  above 2^53 arrive as decimal strings (consumers `String(...)` it). */
  channel_id: number | string;
  channel_type: number;
  /** Server emits this as a string (u64 to_string). */
  reader_id: string;
  /** u64 counter; same lossless number-or-string contract as channel_id. */
  read_pts: number | string;
  visibility: ReadCursorVisibility;
  updated_at: number;
}

export interface ChannelReadCursorNotification {
  message_type: string; // "notification"
  content: string;
  metadata: ChannelReadCursorNotificationMetadata;
}

export interface MessageReactionAddRequest {
  server_message_id: number;
  emoji: string;
}
export type MessageReactionAddResponse = boolean;

export interface MessageReactionRemoveRequest {
  server_message_id: number;
  emoji: string;
}
export type MessageReactionRemoveResponse = boolean;

export interface MessageReactionListRequest {
  server_message_id: number;
}

/**
 * Wire shape: `reactions` is a JSON object mapping emoji → array of user IDs.
 * Server source: `ReactionStats { reactions: HashMap<String, Vec<UserId>> }`.
 * The map is empty (`{}`) when the message has no reactions, NOT undefined.
 */
export interface MessageReactionListResponse {
  success: boolean;
  reactions: Record<string, number[]>;
  total_count: number;
}

// ---------- sync/get_difference ----------
//
// Per-channel gap-fill RPC. Server source:
//   privchat-protocol/src/rpc/sync.rs (GetDifferenceRequest/Response)
//   privchat-server/src/rpc/sync/mod.rs (handler at handle_get_difference_rpc)
//
// Wire shape: every u64 id (`pts`, `server_msg_id`, `local_message_id`,
// `channel_id`, `sender_id`) is carried on the JSON wire as a **string**
// to preserve precision against JS `JSON.parse` rounding above 2^53.
// `channel_type` (u8), `message_type` (string), `content` (json),
// `server_timestamp` (i64 ms — fits in 2^53 for any plausible date),
// `limit` (u32), and `has_more` (bool) stay as their native JSON types.

export interface GetDifferenceRequest {
  channel_id: string;
  channel_type: number;
  /** Cursor: the client's max-known per-channel pts (decimal string). Server
   *  returns commits with `pts > last_pts` in ascending order. */
  last_pts: string;
  /** Page size. Server defaults to 100; soft cap on the server side. */
  limit?: number;
}

export interface GetDifferenceResponse {
  /** Ordered ASC by `pts`. Contiguous within a single page; pagination
   *  is via repeated calls with `last_pts` advanced to `commits[-1].pts`. */
  commits: ServerCommit[];
  /** Server's live channel pts (high-water mark) as a decimal string. */
  current_pts: string;
  /** True when more commits are available past the current page. */
  has_more: boolean;
}

export interface ServerCommit {
  /** Per-channel ordering key (decimal string). */
  pts: string;
  /** Server-assigned message identity (snowflake) as a decimal string. */
  server_msg_id: string;
  /** Echo of the client's local_message_id when the commit is the
   *  server-side ACK of an own send; absent for foreign messages. */
  local_message_id?: string;
  channel_id: string;
  channel_type: number;
  /** Application content type ("text" / "image" / ...). */
  message_type: string;
  /** Type-specific JSON value. Most commonly a string for text or an
   *  object for media; the cache extracts a display string at the
   *  boundary via the engine's content normaliser. */
  content: unknown;
  /** Server wall-clock time in milliseconds. */
  server_timestamp: number;
  /** Sender user id (decimal string). */
  sender_id: string;
  /** Optional sender metadata; deliberately NOT persisted in 5B-1
   *  (per PHASE5B_SYNC_ENGINE_PLAN.md decision #2). */
  sender_info?: unknown;
}

// ---------- presence/* ----------

export interface TypingIndicatorRequest {
  channel_id: number;
  is_typing: boolean;
  action_type?: string;
  channel_type?: number;
}

export interface TypingIndicatorResponse {
  code: number;
  message: string;
}

export interface PresenceBatchStatusRequest {
  /** 1..=100 user IDs per batch. */
  user_ids: number[];
}

export interface PresenceStatusItem {
  user_id: number;
  is_online: boolean;
  last_seen_at: number;
  device_count: number;
  version: number;
}

export interface PresenceBatchStatusResponse {
  items: PresenceStatusItem[];
  denied_user_ids: number[];
}

// =====================================================
// QR_CODE_SPEC v1.3 — 用户/群二维码
// =====================================================

/** `user/qrcode/get` — 读取当前用户名片二维码。 */
export interface UserQrCodeGetResponse {
  /** opaque token, 16-char base62, 永久（来自 privchat_users.qr_key）。 */
  qr_key: string;
  /**
   * 已拼好的完整 URL：
   * `https://<qr_base_url>/privchat:protocol/user/get?qrkey=<qr_key>`
   */
  qr_code: string;
  /** 回显的当前用户 ID。 */
  user_id: number;
}

/** `user/qrcode/refresh` — 旋转当前用户名片二维码。 */
export interface UserQrCodeRefreshResponse {
  /** 旧 qr_key（已作废）。 */
  old_qr_key: string;
  /** 新 qr_key。 */
  new_qr_key: string;
  /** 已拼好的新 URL。 */
  qr_code: string;
  /** 用户 ID。 */
  user_id: number;
}

/** `user/qrcode/resolve` — 把对端 qrkey 翻译成最小用户卡片。
 *  Server 故意**不返回 qr_key**，避免二次扩散。 */
export interface UserQrCodeResolveResponse {
  user_id: number;
  username: string;
  display_name?: string;
  avatar_url?: string;
  /** 0=普通用户 / 1=系统用户 / 2=机器人。 */
  user_type: number;
  /** 调用方与目标用户是否已是好友。 */
  is_friend: boolean;
  /** 调用方是不是目标用户本身（扫了自己的名片码）。 */
  is_self: boolean;
}

/** `group/qrcode/get` — 读群二维码。Member 及以上可见。 */
export interface GroupQrCodeGetResponse {
  qr_key: string;
  /** `https://<qr_base_url>/privchat:protocol/group/join?qrkey=<qr_key>` */
  qr_code: string;
  /** 回显的群组 ID。注意：JSON 数字可能溢出 JS 安全整数，建议按字符串处理。 */
  group_id: number;
}

/** `group/qrcode/refresh` — 旋转群二维码。Owner/Admin only。 */
export interface GroupQrCodeRefreshResponse {
  old_qr_key: string;
  new_qr_key: string;
  qr_code: string;
  group_id: number;
}

/** `group/join/qrcode` — 通过 qrkey 加群。 */
export interface GroupQrCodeJoinResponse {
  /** `"joined"` 或 `"pending"`（pending = 进入审批队列）。 */
  status: 'joined' | 'pending' | string;
  /** Server reverse-lookup 出来的群组 ID。 */
  group_id: number;
  /** 仅当 status='pending' 时返回。 */
  request_id?: string;
  /** 提示文案。 */
  message?: string;
  /** status='joined' 时返回当前用户 ID。 */
  user_id?: number;
  /** status='joined' 时返回加群时间 Unix 毫秒。 */
  joined_at?: number;
}
