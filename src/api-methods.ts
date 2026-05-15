// Typed RPC convenience methods on PrivchatClient. Each is a thin
// `rpcCallTyped` wrapper around a Routes constant + api-types pair.
//
// Routes referenced here MUST exist on the server (verified). Routes
// declared in `Routes` but not implemented server-side (e.g.
// account/profile/get|update, contact/friend/reject) are intentionally
// absent from this file.
//
// Implementation pattern: declaration merge into the existing class +
// prototype assignment. This keeps client.ts focused on lifecycle /
// state / events while still exposing methods on the client instance
// (so callers write `client.friendApply(...)` not `friendApply(client, ...)`).

import { PrivchatClient } from './client.js';
import { Routes } from './routes.js';
import type {
  AccountSearchQueryRequest,
  AccountSearchResponse,
  BlacklistAddResponse,
  BotFollowResponse,
  BotUnfollowResponse,
  BlacklistCheckResponse,
  BlacklistListResponse,
  BlacklistRemoveResponse,
  ChannelHideResponse,
  ChannelMuteResponse,
  ChannelPinResponse,
  FileGetUrlResponse,
  FileRequestUploadTokenResponse,
  FileUploadCallbackResponse,
  FileUploadResult,
  FriendAcceptResponse,
  FriendApplyResponse,
  FriendCheckResponse,
  FriendPendingResponse,
  FriendRemoveResponse,
  FriendSetAliasResponse,
  GetOrCreateDirectChannelResponse,
  GroupCreateResponse,
  GroupInfoResponse,
  GroupMemberAddResponse,
  GroupMemberLeaveResponse,
  GroupMemberListResponse,
  GroupMemberMuteResponse,
  GroupMemberRemoveResponse,
  GroupMemberUnmuteResponse,
  GroupMuteAllResponse,
  GroupRoleSetResponse,
  GroupRoleSetValue,
  GroupSettingsGetResponse,
  GroupSettingsPatch,
  GroupSettingsUpdateResponse,
  GroupTransferOwnerResponse,
  MessageHistoryResponse,
  MessageReactionAddResponse,
  MessageReactionListResponse,
  MessageReactionRemoveResponse,
  MessageRevokeResponse,
  PresenceBatchStatusResponse,
  TypingIndicatorResponse,
  // QR_CODE_SPEC v1.3
  GroupQrCodeGetResponse,
  GroupQrCodeJoinResponse,
  GroupQrCodeRefreshResponse,
  UserQrCodeGetResponse,
  UserQrCodeRefreshResponse,
  UserQrCodeResolveResponse,
} from './api-types.js';

// ----- Public method declarations (declaration merge into PrivchatClient) -----

declare module './client.js' {
  interface PrivchatClient {
    // account/search
    accountSearch(query: string, page?: number, pageSize?: number): Promise<AccountSearchResponse>;

    // account/bot (spec SERVICE_ACCOUNT_FOLLOW_SPEC)
    /** 关注一个 Bot；server 写 follow 表 + 通知 application 写 business_channel binding。
     *  返回 channel_id，可直接用于 Subscribe / Transfer / SendMessage。 */
    botFollow(botUserId: number): Promise<BotFollowResponse>;
    /** 取消关注 Bot；server 切 status=0 但不删 channel / 历史。 */
    botUnfollow(botUserId: number): Promise<BotUnfollowResponse>;

    // contact/friend
    friendApply(targetUserId: number, message?: string, source?: string, sourceId?: string): Promise<FriendApplyResponse>;
    friendAccept(fromUserId: number, message?: string): Promise<FriendAcceptResponse>;
    friendPending(): Promise<FriendPendingResponse>;
    friendCheck(friendId: number): Promise<FriendCheckResponse>;
    friendRemove(friendId: number): Promise<FriendRemoveResponse>;
    friendSetAlias(targetUserId: number, alias: string): Promise<FriendSetAliasResponse>;

    // contact/blacklist (caller must supply current user_id since server
    // does NOT auto-fill it for blacklist routes — verified via wire test)
    blacklistAdd(callerUserId: number, blockedUserId: number): Promise<BlacklistAddResponse>;
    blacklistRemove(callerUserId: number, blockedUserId: number): Promise<BlacklistRemoveResponse>;
    blacklistList(callerUserId: number): Promise<BlacklistListResponse>;
    blacklistCheck(callerUserId: number, targetUserId: number): Promise<BlacklistCheckResponse>;

    // channel
    channelDirectGetOrCreate(targetUserId: number, source?: string, sourceId?: string): Promise<GetOrCreateDirectChannelResponse>;
    channelPin(channelId: number, pinned: boolean): Promise<ChannelPinResponse>;
    channelHide(channelId: number): Promise<ChannelHideResponse>;
    channelMute(channelId: number, muted: boolean): Promise<ChannelMuteResponse>;

    // group
    groupCreate(name: string, description?: string): Promise<GroupCreateResponse>;
    groupInfo(groupId: number): Promise<GroupInfoResponse>;
    groupMemberAdd(groupId: number, userId: number, role?: string): Promise<GroupMemberAddResponse>;
    groupMemberList(groupId: number): Promise<GroupMemberListResponse>;
    groupMemberLeave(groupId: number): Promise<GroupMemberLeaveResponse>;
    groupMemberRemove(groupId: number, userId: number): Promise<GroupMemberRemoveResponse>;
    /** `muteDuration` is in seconds; 0 = permanent. */
    groupMemberMute(groupId: number, userId: number, muteDuration: number): Promise<GroupMemberMuteResponse>;
    groupMemberUnmute(groupId: number, userId: number): Promise<GroupMemberUnmuteResponse>;

    /** Promote a member to admin or demote them back to member. Owner
     *  cannot be assigned this way — use [groupTransferOwner]. Server
     *  reads `operatorId` from the wire body for the permission check
     *  (must be the current owner), so callers must pass it explicitly. */
    groupRoleSet(
      groupId: number,
      operatorId: number,
      userId: number,
      role: GroupRoleSetValue,
    ): Promise<GroupRoleSetResponse>;

    /** Transfer ownership to another existing group member. Server
     *  reads `currentOwnerId` from the wire body for the permission
     *  check (must equal session uid AND be the current owner). The
     *  outgoing owner becomes a regular member — per server impl
     *  `rpc/group/role/transfer_owner.rs:99-101` it sets the role to
     *  `MemberRole::Member`, NOT admin. */
    groupTransferOwner(
      groupId: number,
      currentOwnerId: number,
      newOwnerId: number,
    ): Promise<GroupTransferOwnerResponse>;

    /** Fetch the group's mutable settings (description / announcement /
     *  approval flags / mute-all / member limit). Server fills the
     *  viewer uid from session; only members can read. */
    groupSettingsGet(groupId: number): Promise<GroupSettingsGetResponse>;

    /** Apply a partial patch to the group's settings. Owner-only per
     *  spec; server validates `operatorId` against the group's owner.
     *  Pass `''` to clear a string field; omit fields to leave them
     *  unchanged.
     *
     *  Note: per spec, group `name` and `avatar_url` have NO user-side
     *  RPC and cannot be set through this method — they belong to the
     *  admin-tool surface only. */
    groupSettingsUpdate(
      groupId: number,
      operatorId: number,
      settings: GroupSettingsPatch,
    ): Promise<GroupSettingsUpdateResponse>;

    /** Toggle whole-group mute. Convenience wrapper around the
     *  `group/settings/mute_all` route; semantically equivalent to
     *  `groupSettingsUpdate(groupId, op, { all_muted: muted })` but
     *  goes through the dedicated route (server emits a distinct
     *  notification) — match spec. */
    groupMuteAll(
      groupId: number,
      operatorId: number,
      muted: boolean,
    ): Promise<GroupMuteAllResponse>;

    // message
    messageHistory(channelId: number, limit?: number, beforeServerMessageId?: number): Promise<MessageHistoryResponse>;
    messageRevoke(serverMessageId: number, channelId: number): Promise<MessageRevokeResponse>;
    messageReactionAdd(serverMessageId: number, emoji: string): Promise<MessageReactionAddResponse>;
    messageReactionRemove(serverMessageId: number, emoji: string): Promise<MessageReactionRemoveResponse>;
    messageReactionList(serverMessageId: number): Promise<MessageReactionListResponse>;

    // presence
    sendTyping(channelId: number, isTyping: boolean, actionType?: string, channelType?: number): Promise<TypingIndicatorResponse>;
    /** Batch presence query — server enforces 1..=100 per call. */
    batchGetPresence(userIds: number[]): Promise<PresenceBatchStatusResponse>;

    // file
    /** Step 1 of upload: ask the server for a one-shot upload token +
     *  the URL to POST the multipart body to. Server enforces per-type
     *  size limits and returns `expires_at` so callers can re-request
     *  if the upload UI takes too long. */
    fileRequestUploadToken(args: {
      file_size: number;
      mime_type: string;
      file_type: 'image' | 'video' | 'voice' | 'file' | 'other';
      business_type?: string;
      filename?: string;
    }): Promise<FileRequestUploadTokenResponse>;

    /** Optional Step 3 of upload: notify the server with the post-upload
     *  status (`'success'` / `'failed'`). The HTTP upload endpoint
     *  already commits the file row server-side, so the happy path
     *  doesn't strictly require this — keep for failure reporting. */
    fileUploadCallback(args: {
      file_id: string;
      status: 'success' | 'failed';
    }): Promise<FileUploadCallbackResponse>;

    /** Resolve a file_id to a fresh signed URL. Use when the embedded
     *  url in a message bubble has expired. */
    fileGetUrl(fileId: number): Promise<FileGetUrlResponse>;

    // QR_CODE_SPEC v1.3 — user qrcode（个人名片码）

    /** Read self's permanent qr_key + fully-built URL.
     *
     *  `qr_code` shape:
     *  `https://<host>/privchat:protocol/user/get?qrkey=<qr_key>` */
    userQrcodeGet(): Promise<UserQrCodeGetResponse>;

    /** Rotate self's qr_key (in-place UPDATE). Old key is immediately
     *  unreachable by `resolve`. Use this when the user wants to fight
     *  spam — there's no time-based expiry. */
    userQrcodeRefresh(): Promise<UserQrCodeRefreshResponse>;

    /** Resolve a qr_key (scanned from another user's QR code) to the
     *  minimum user card. Server intentionally does NOT return the
     *  qr_key in the response to discourage secondary spreading. */
    userQrcodeResolve(qrKey: string): Promise<UserQrCodeResolveResponse>;

    // QR_CODE_SPEC v1.3 — group qrcode（群二维码）

    /** Read a group's permanent qr_key + URL. Any member of the group
     *  can call (server enforces). Use to render the group QR sheet. */
    groupQrcodeGet(groupId: number): Promise<GroupQrCodeGetResponse>;

    /** Rotate the group's qr_key. Owner/Admin only (server enforces).
     *  Same anti-spam pattern as `userQrcodeRefresh`. */
    groupQrcodeRefresh(groupId: number): Promise<GroupQrCodeRefreshResponse>;

    /** Join a group by scanning its QR. Server reverse-looks-up the
     *  group_id via `qr_key` and runs the same membership + capacity +
     *  `join_need_approval` checks as `member/invite`. Response `status`
     *  is `'joined'` or `'pending'`. */
    groupJoinByQrcode(qrKey: string, message?: string): Promise<GroupQrCodeJoinResponse>;
  }
}

// ----- Implementations (prototype assignment) -----

const proto = PrivchatClient.prototype;

proto.accountSearch = function (query, page = 1, pageSize = 20) {
  // R4: rpcCallTyped now uses lossless-json under the hood, so
  // `search_session_id` (snowflake > 2^53) comes back as a string
  // automatically — no per-route precision hack needed anymore.
  return this.rpcCallTyped<AccountSearchQueryRequest, AccountSearchResponse>(
    Routes.account_search.QUERY,
    { query, page, page_size: pageSize, from_user_id: 0 },
  );
};

// Bot ----------

proto.botFollow = function (botUserId) {
  return this.rpcCallTyped(Routes.account_bot.FOLLOW, { bot_user_id: botUserId });
};

proto.botUnfollow = function (botUserId) {
  return this.rpcCallTyped(Routes.account_bot.UNFOLLOW, { bot_user_id: botUserId });
};

// Friend ----------

proto.friendApply = function (targetUserId, message, source, sourceId) {
  return this.rpcCallTyped(Routes.friend.APPLY, {
    target_user_id: targetUserId,
    message,
    source,
    source_id: sourceId,
    from_user_id: 0,
  });
};

proto.friendAccept = function (fromUserId, message) {
  return this.rpcCallTyped(Routes.friend.ACCEPT, {
    from_user_id: fromUserId,
    message,
  });
};

proto.friendPending = function () {
  return this.rpcCallTyped(Routes.friend.PENDING, { user_id: 0 });
};

proto.friendCheck = function (friendId) {
  return this.rpcCallTyped(Routes.friend.CHECK, { friend_id: friendId, user_id: 0 });
};

proto.friendRemove = function (friendId) {
  return this.rpcCallTyped(Routes.friend.REMOVE, { friend_id: friendId, user_id: 0 });
};

proto.friendSetAlias = function (targetUserId, alias) {
  return this.rpcCallTyped(Routes.friend.SET_ALIAS, { user_id: targetUserId, alias });
};

// Blacklist ----------

proto.blacklistAdd = function (callerUserId, blockedUserId) {
  return this.rpcCallTyped(Routes.blacklist.ADD, {
    user_id: callerUserId,
    blocked_user_id: blockedUserId,
  });
};

proto.blacklistRemove = function (callerUserId, blockedUserId) {
  return this.rpcCallTyped(Routes.blacklist.REMOVE, {
    user_id: callerUserId,
    blocked_user_id: blockedUserId,
  });
};

proto.blacklistList = function (callerUserId) {
  return this.rpcCallTyped(Routes.blacklist.LIST, { user_id: callerUserId });
};

proto.blacklistCheck = function (callerUserId, targetUserId) {
  return this.rpcCallTyped(Routes.blacklist.CHECK, {
    user_id: callerUserId,
    target_user_id: targetUserId,
  });
};

// Channel ----------

proto.channelDirectGetOrCreate = function (targetUserId, source, sourceId) {
  return this.rpcCallTyped(Routes.channel.DIRECT_GET_OR_CREATE, {
    target_user_id: targetUserId,
    source,
    source_id: sourceId,
    user_id: 0,
  });
};

proto.channelPin = function (channelId, pinned) {
  return this.rpcCallTyped(Routes.channel.PIN, { channel_id: channelId, pinned });
};

proto.channelHide = function (channelId) {
  return this.rpcCallTyped(Routes.channel.HIDE, { channel_id: channelId });
};

proto.channelMute = function (channelId, muted) {
  return this.rpcCallTyped(Routes.channel.MUTE, { channel_id: channelId, muted });
};

// Group ----------

proto.groupCreate = function (name, description) {
  return this.rpcCallTyped(Routes.group.CREATE, { name, description });
};

proto.groupInfo = function (groupId) {
  return this.rpcCallTyped(Routes.group.INFO, { group_id: groupId });
};

proto.groupMemberAdd = function (groupId, userId, role) {
  return this.rpcCallTyped(Routes.group_member.ADD, {
    group_id: groupId,
    user_id: userId,
    role,
  });
};

proto.groupMemberList = function (groupId) {
  return this.rpcCallTyped(Routes.group_member.LIST, { group_id: groupId });
};

proto.groupMemberLeave = function (groupId) {
  return this.rpcCallTyped(Routes.group_member.LEAVE, { group_id: groupId });
};

proto.groupMemberRemove = function (groupId, userId) {
  return this.rpcCallTyped(Routes.group_member.REMOVE, {
    group_id: groupId,
    user_id: userId,
  });
};

proto.groupMemberMute = function (groupId, userId, muteDuration) {
  return this.rpcCallTyped(Routes.group_member.MUTE, {
    group_id: groupId,
    user_id: userId,
    mute_duration: muteDuration,
  });
};

proto.groupMemberUnmute = function (groupId, userId) {
  return this.rpcCallTyped(Routes.group_member.UNMUTE, {
    group_id: groupId,
    user_id: userId,
  });
};

proto.groupRoleSet = function (groupId, operatorId, userId, role) {
  return this.rpcCallTyped(Routes.group_role.SET, {
    group_id: groupId,
    operator_id: operatorId,
    user_id: userId,
    role,
  });
};

proto.groupTransferOwner = function (groupId, currentOwnerId, newOwnerId) {
  return this.rpcCallTyped(Routes.group_role.TRANSFER_OWNER, {
    group_id: groupId,
    current_owner_id: currentOwnerId,
    new_owner_id: newOwnerId,
  });
};

proto.groupSettingsGet = function (groupId) {
  return this.rpcCallTyped(Routes.group_settings.GET, { group_id: groupId });
};

proto.groupSettingsUpdate = function (groupId, operatorId, settings) {
  return this.rpcCallTyped(Routes.group_settings.UPDATE, {
    group_id: groupId,
    operator_id: operatorId,
    settings,
  });
};

proto.groupMuteAll = function (groupId, operatorId, muted) {
  return this.rpcCallTyped(Routes.group_settings.MUTE_ALL, {
    group_id: groupId,
    operator_id: operatorId,
    muted,
  });
};

// Message ----------

proto.messageHistory = function (channelId, limit, beforeServerMessageId) {
  return this.rpcCallTyped(Routes.message_history.GET, {
    channel_id: channelId,
    limit,
    before_server_message_id: beforeServerMessageId,
  });
};

proto.messageRevoke = function (serverMessageId, channelId) {
  return this.rpcCallTyped(Routes.message.REVOKE, {
    server_message_id: serverMessageId,
    channel_id: channelId,
  });
};

proto.messageReactionAdd = function (serverMessageId, emoji) {
  return this.rpcCallTyped(Routes.message_reaction.ADD, {
    server_message_id: serverMessageId,
    emoji,
  });
};

proto.messageReactionRemove = function (serverMessageId, emoji) {
  return this.rpcCallTyped(Routes.message_reaction.REMOVE, {
    server_message_id: serverMessageId,
    emoji,
  });
};

proto.messageReactionList = function (serverMessageId) {
  return this.rpcCallTyped(Routes.message_reaction.LIST, {
    server_message_id: serverMessageId,
  });
};

// Presence ----------

proto.sendTyping = function (channelId, isTyping, actionType, channelType) {
  return this.rpcCallTyped(Routes.presence.TYPING, {
    channel_id: channelId,
    is_typing: isTyping,
    action_type: actionType,
    channel_type: channelType,
  });
};

proto.batchGetPresence = function (userIds) {
  return this.rpcCallTyped(Routes.presence.STATUS_GET, { user_ids: userIds });
};

// File ----------

proto.fileRequestUploadToken = function (args) {
  // user_id is filled server-side from auth ctx; client passes 0.
  return this.rpcCallTyped(Routes.file.REQUEST_UPLOAD_TOKEN, {
    user_id: 0,
    file_size: args.file_size,
    mime_type: args.mime_type,
    file_type: args.file_type,
    business_type: args.business_type ?? 'message',
    filename: args.filename,
  });
};

proto.fileUploadCallback = function (args) {
  return this.rpcCallTyped(Routes.file.UPLOAD_CALLBACK, {
    user_id: 0,
    file_id: args.file_id,
    status: args.status,
  });
};

proto.fileGetUrl = function (fileId) {
  return this.rpcCallTyped(Routes.file.GET_URL, { file_id: fileId });
};

// ---------- QR_CODE_SPEC v1.3 — user qrcode ----------

proto.userQrcodeGet = function (): Promise<UserQrCodeGetResponse> {
  // user_id 服务端从 ctx 读，请求体无入参；空对象保留以保持 wire 形式一致。
  return this.rpcCallTyped(Routes.user_qrcode.GET, {});
};

proto.userQrcodeRefresh = function (): Promise<UserQrCodeRefreshResponse> {
  return this.rpcCallTyped(Routes.user_qrcode.REFRESH, {});
};

proto.userQrcodeResolve = function (qrKey: string): Promise<UserQrCodeResolveResponse> {
  return this.rpcCallTyped(Routes.user_qrcode.RESOLVE, { qr_key: qrKey });
};

// ---------- QR_CODE_SPEC v1.3 — group qrcode ----------

proto.groupQrcodeGet = function (groupId: number): Promise<GroupQrCodeGetResponse> {
  return this.rpcCallTyped(Routes.group_qrcode.GET, { group_id: groupId });
};

proto.groupQrcodeRefresh = function (groupId: number): Promise<GroupQrCodeRefreshResponse> {
  return this.rpcCallTyped(Routes.group_qrcode.REFRESH, { group_id: groupId });
};

proto.groupJoinByQrcode = function (
  qrKey: string,
  message?: string,
): Promise<GroupQrCodeJoinResponse> {
  return this.rpcCallTyped(Routes.group_qrcode.JOIN, {
    qr_key: qrKey,
    ...(message !== undefined && message !== '' ? { message } : {}),
  });
};

// ---------- Media message helpers ----------

/** Numeric ContentMessageType tag (mirrors `protocol::ContentMessageType`).
 *  Re-exported for convenience so callers don't have to import it from
 *  the SDK separately when building media payloads. */
export const ContentMessageType = {
  Text: 0,
  Voice: 1,
  Image: 2,
  Video: 3,
  File: 4,
  System: 5,
  Sticker: 6,
  ContactCard: 7,
  Location: 8,
  Link: 9,
  Forward: 10,
} as const;

/** Image message payload metadata (matches server's
 *  `LocalMessagePayloadEnvelope.metadata`). */
export interface SendImageMetadata {
  file_id: string;
  url?: string;
  width: number;
  height: number;
}

export interface SendFileMetadata {
  file_id: string;
  url?: string;
  filename?: string;
  mime_type?: string;
  size?: number;
}

export interface SendVoiceMetadata {
  file_id: string;
  url?: string;
  duration: number;
}

export interface SendVideoMetadata {
  file_id: string;
  url?: string;
  width: number;
  height: number;
  duration: number;
  thumbnail_url?: string;
}

/** Build a JSON-encoded `LocalMessagePayloadEnvelope` for a media
 *  message. Server's `extractPushContent` JSON-first path picks this
 *  up; legacy FlatBuffers envelope decoding stays as a fallback for
 *  cross-version compatibility. */
function encodeMediaPayload(
  contentType: 'image' | 'voice' | 'video' | 'file',
  caption: string,
  metadata: object,
): Uint8Array {
  const envelope = {
    content: caption,
    metadata: { type: contentType, ...metadata },
    mentioned_user_ids: [] as number[],
  };
  return new TextEncoder().encode(JSON.stringify(envelope));
}

/** Send an image message. Caller has already gone through the
 *  upload flow (`fileRequestUploadToken` → `uploadFileViaToken`) and
 *  has the `file_id` + dimensions. */
export function buildSendImageInput(args: {
  channel_id: string;
  channel_type: number;
  from_uid: string;
  metadata: SendImageMetadata;
  caption?: string;
  local_message_id?: string;
}): import('./client.js').SendTextInput {
  const caption = args.caption ?? '';
  return {
    channel_id: args.channel_id,
    channel_type: args.channel_type,
    from_uid: args.from_uid,
    content: caption !== '' ? caption : '[图片]',
    message_type: ContentMessageType.Image,
    payload: encodeMediaPayload('image', caption, args.metadata),
    local_message_id: args.local_message_id,
  };
}

export function buildSendFileInput(args: {
  channel_id: string;
  channel_type: number;
  from_uid: string;
  metadata: SendFileMetadata;
  caption?: string;
  local_message_id?: string;
}): import('./client.js').SendTextInput {
  const caption =
    args.caption ?? args.metadata.filename ?? '[文件]';
  return {
    channel_id: args.channel_id,
    channel_type: args.channel_type,
    from_uid: args.from_uid,
    content: caption,
    message_type: ContentMessageType.File,
    payload: encodeMediaPayload('file', caption, args.metadata),
    local_message_id: args.local_message_id,
  };
}

export function buildSendVoiceInput(args: {
  channel_id: string;
  channel_type: number;
  from_uid: string;
  metadata: SendVoiceMetadata;
  local_message_id?: string;
}): import('./client.js').SendTextInput {
  return {
    channel_id: args.channel_id,
    channel_type: args.channel_type,
    from_uid: args.from_uid,
    content: '[语音]',
    message_type: ContentMessageType.Voice,
    payload: encodeMediaPayload('voice', '', args.metadata),
    local_message_id: args.local_message_id,
  };
}

/** Send a video message. Caller has already uploaded the video file
 *  and has the `file_id` + width/height/duration. `thumbnail_url` is
 *  optional — clients that don't generate a poster frame (e.g. the
 *  Web client, where we'd need to decode + draw a `<video>` element
 *  before send) can omit it and the receiver renders the player chrome
 *  without a poster. */
export function buildSendVideoInput(args: {
  channel_id: string;
  channel_type: number;
  from_uid: string;
  metadata: SendVideoMetadata;
  caption?: string;
  local_message_id?: string;
}): import('./client.js').SendTextInput {
  const caption = args.caption ?? '';
  return {
    channel_id: args.channel_id,
    channel_type: args.channel_type,
    from_uid: args.from_uid,
    content: caption !== '' ? caption : '[视频]',
    message_type: ContentMessageType.Video,
    payload: encodeMediaPayload('video', caption, args.metadata),
    local_message_id: args.local_message_id,
  };
}

/** Progress event from `uploadFileViaToken`. Emits during the
 *  upload-body phase (i.e. the multipart write), not on response
 *  download. `total === 0` when the underlying transport doesn't
 *  expose Content-Length — the caller should fall back to an
 *  indeterminate spinner in that case. */
export interface UploadProgressEvent {
  loaded: number;
  total: number;
  /** Percent in [0, 100], or `undefined` when total is unknown. */
  percent?: number;
}

/**
 * Helper for the multipart upload step (NOT an RPC). Pair with
 * `fileRequestUploadToken`: pass the response's `upload_url` + `token`.
 * The server side enforces the upload size limit baked into the token,
 * so callers don't need to validate again — but they should keep the
 * `File` blob around in case retry is needed.
 *
 * Resolves with the parsed JSON envelope's `data` field
 * (`UploadResponse` from server's HTTP `/api/app/files/upload`).
 *
 * Implemented with `XMLHttpRequest` instead of `fetch` because we
 * need `upload.onprogress` for UX feedback — `fetch` doesn't expose
 * upload progress in browsers (the streaming body Request init is
 * Chrome-only and gated behind a flag). Implemented as a free
 * function rather than a PrivchatClient method because it touches
 * no transport state.
 */
export function uploadFileViaToken(args: {
  file: Blob;
  filename: string;
  uploadUrl: string;
  token: string;
  /** Optional cross-system business reference (passed as `business_id`
   *  multipart field). */
  businessId?: string;
  /** Fires on upload-body progress; not called for response download. */
  onProgress?: (event: UploadProgressEvent) => void;
  /** Abort signal — when triggered, the XHR is canceled and the
   *  promise rejects with an AbortError-shaped error. */
  signal?: AbortSignal;
}): Promise<FileUploadResult> {
  return new Promise<FileUploadResult>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', args.uploadUrl);
    xhr.setRequestHeader('X-Upload-Token', args.token);

    if (args.signal !== undefined) {
      const onAbort = () => xhr.abort();
      args.signal.addEventListener('abort', onAbort, { once: true });
      xhr.addEventListener('loadend', () =>
        args.signal?.removeEventListener('abort', onAbort),
      );
    }

    if (args.onProgress !== undefined) {
      xhr.upload.onprogress = (e) => {
        const total = e.lengthComputable ? e.total : 0;
        args.onProgress!({
          loaded: e.loaded,
          total,
          percent:
            e.lengthComputable && e.total > 0
              ? Math.round((e.loaded / e.total) * 100)
              : undefined,
        });
      };
    }

    xhr.onerror = () =>
      reject(new Error('upload network error'));
    xhr.onabort = () => {
      const err = new Error('upload aborted');
      err.name = 'AbortError';
      reject(err);
    };
    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(
          new Error(
            `upload failed: HTTP ${xhr.status} ${xhr.statusText} ${xhr.responseText ?? ''}`,
          ),
        );
        return;
      }
      let json: { code?: number; message?: string; data?: FileUploadResult };
      try {
        json = JSON.parse(xhr.responseText ?? '{}') as typeof json;
      } catch (e) {
        reject(new Error(`upload response not JSON: ${(e as Error).message}`));
        return;
      }
      if (json.code !== undefined && json.code !== 0) {
        reject(
          new Error(`upload rejected: code=${json.code} ${json.message ?? ''}`),
        );
        return;
      }
      if (json.data === undefined) {
        reject(new Error('upload response missing data'));
        return;
      }
      resolve(json.data);
    };

    const form = new FormData();
    form.append('file', args.file, args.filename);
    if (args.businessId !== undefined) form.append('business_id', args.businessId);
    xhr.send(form);
  });
}
