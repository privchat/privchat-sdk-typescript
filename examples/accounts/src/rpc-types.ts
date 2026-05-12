// Local Request/Response shapes for routes the SDK doesn't sugar yet:
//   - account/user/register
//   - sync/get_channel_pts
//   - sync/submit
//
// Everything else (friend / blacklist / channel / group / message / account
// / presence) flows through the typed methods on `PrivchatClient` and lives
// in `src/api-types.ts` of the SDK.

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

export interface AuthResponse {
  user_id: number;
  token: string;
  refresh_token?: string;
  expires_at: number;
  device_id: string;
}

// ---------- sync/get_channel_pts ----------

export interface GetChannelPtsRequest {
  channel_id: number;
  channel_type: number;
}

export interface GetChannelPtsResponse {
  channel_id: number;
  channel_type: number;
  current_pts: number;
}

// ---------- sync/submit ----------

export type ServerDecision =
  | 'accepted'
  | { transformed: { reason: string } }
  | { rejected: { reason: string } };

export interface ClientSubmitRequest {
  local_message_id: number;
  channel_id: number;
  channel_type: number;
  last_pts: number;
  command_type: string;
  payload: unknown;
  client_timestamp: number;
  device_id?: string;
}

export interface ClientSubmitResponse {
  decision: ServerDecision;
  pts?: number;
  server_msg_id?: number;
  server_timestamp: number;
  local_message_id: number;
  has_gap: boolean;
  current_pts: number;
}

// ---------- entity/sync_entities ----------
//
// PHASE 4 DEPENDENCY: these shapes must stay in sync with the Rust
// SyncEntitiesRequest / SyncEntitiesResponse / SyncEntityItem +
// ChannelSyncPayload / ChannelReadCursorSyncPayload structs in
// privchat-protocol/src/rpc/sync.rs. Phase 6+ will move them into
// the SDK proper (src/api-types.ts) and add typed `entitySync(...)`
// methods on PrivchatClient.

export interface SyncEntitiesRequest {
  entity_type:
    | 'friend'
    | 'user'
    | 'group'
    | 'group_member'
    | 'channel'
    | 'channel_read_cursor';
  /** 0 / undefined = full bootstrap. */
  since_version?: number;
  /** Required for `group_member` (group_id); ignored otherwise. */
  scope?: string;
  /** Default 100, server caps to 1..=200. */
  limit?: number;
}

export interface SyncEntityItem<P = unknown> {
  /** u64-as-string for channel; "channel_id:reader_id" for cursor. */
  entity_id: string;
  version: number;
  /** True for tombstones. serde default = false on wire. */
  deleted: boolean;
  payload?: P;
}

export interface SyncEntitiesResponse<P = unknown> {
  items: SyncEntityItem<P>[];
  next_version: number;
  has_more: boolean;
  /** Present when client's since_version is below server retention floor → full rebuild required. */
  min_version?: number;
}

/** Payload for entity_type = "channel". */
export interface ChannelSyncPayload {
  channel_id?: number;
  channel_type?: number;
  /** Alias for `channel_type` (serde rename). */
  type?: number;
  channel_name?: string;
  name?: string;
  avatar?: string;
  unread_count?: number;
  last_msg_content?: string;
  last_msg_timestamp?: number;
  /** 0 | 1 (pinned). */
  top?: number;
  /** 0 | 1 (muted). */
  mute?: number;
}

/** Payload for entity_type = "channel_read_cursor". */
export interface ChannelReadCursorSyncPayload {
  channel_id?: number;
  channel_type?: number;
  /** Alias for `channel_type`. */
  type?: number;
  reader_id?: number;
  /** Server's per-channel high-water mark for this reader; this is `read_seq`. */
  last_read_pts?: number;
  updated_at?: number;
}
