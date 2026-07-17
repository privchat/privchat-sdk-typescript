// Public surface for @privchat/sdk.
//
// Phase 1: protocol-layer codecs (FlatBuffers wrappers).
// Phase 2: PrivchatClient — typed protocol facade on top of @msgtrans/client,
//          plus a thin layer of Rust-style convenience wrappers.

// ----- Client (Phase 2) -----
export {
  AuthorizationError,
  CacheDisabledError,
  MarkReadValidationError,
  PrivchatClient,
  RefreshTokenError,
  RpcError,
  SubscribeError,
} from './client.js';
export type {
  BootstrapChannelsOptions,
  CacheOptions,
  HeartbeatOptions,
  MarkReadOptions,
  OpenConversationOptions,
  OutboxOptions,
  PrivchatClientOptions,
  ReconnectOptions,
  RefreshAccessTokenRequest,
  RefreshAccessTokenResult,
  RequestOptions,
  ScrollHistoryOptions,
  SendTextInput,
  SendTextOperationResult,
  SessionSnapshot,
  Unsubscribe,
} from './client.js';
export type {
  OutboxFlushOptions,
  OutboxFlushResult,
  OutboxEngineConfig,
} from './outbox-engine.js';
export { FROZEN_NEXT_ATTEMPT_AT } from './outbox-engine.js';

// ----- Cache (Phase 4) -----
export type {
  ChannelRecord,
  ConversationPatch,
  ConversationSnapshot,
  FriendshipRecord,
  GroupRecord,
  ListOutboxOptions,
  MessageRecord,
  MessageStatus,
  OutboxEntry,
  OutboxStatus,
  SyncStateRecord,
  UserRecord,
} from './cache/index.js';
export { pushToMessageRecord } from './cache/index.js';
// R7.2b: re-exported so hosts can open the same Dexie schema
// outside the client (e.g. for an account-level DB migration).
// The schema definition is internal to CacheDB; consumers should
// only `new CacheDB(name).open()` / `.close()` / iterate `.tables`,
// not write through it directly (write paths go through the
// regular client APIs).
export { CacheDB } from './cache/index.js';

// ----- Sync engine (Phase 5B-1) -----
export type { SyncResult, SyncStatus } from './sync-engine.js';
export {
  SYNC_CHANNEL_RESYNC_REQUIRED,
  SYNC_FULL_REBUILD_REQUIRED,
  SYNC_GET_DIFFERENCE_ROUTE,
} from './sync-engine.js';

// ----- Auth error classification -----
export {
  classifyAuthErrorCode,
  parseAuthErrorPrefix,
} from './auth-error.js';
export type { AuthErrorKind } from './auth-error.js';

// ----- Lossless JSON (u64-safe) -----
export { parseRpcJson } from './codec/safe-json.js';

// ----- Message content normalization -----
export {
  decodeLegacyMessageEnvelope,
  messageContentText,
  normalizeMessageDisplayContent,
  projectMessageContent,
  scanMessageTextEntities,
} from './message-content.js';
export type {
  LegacyMessageEnvelope,
  MessageContent,
  MessageTextEntity,
  MessageTextEntityType,
  MoneyMessageSnapshot,
  ProjectMessageContentInput,
  SystemMessageRef,
} from './message-content.js';

// ----- Canonical content-type mapping -----
export {
  contentTypeFromWireTag,
  contentTypeToWireTag,
  decodeContentTypeName,
} from './content-type.js';
export type { ContentTypeName } from './content-type.js';

// ----- Auth refresh (SDK-owned coordinator) -----
export { AuthRefreshCoordinator, SessionExpiredError } from './auth-refresh.js';
export type {
  AuthRefreshConfig,
  AuthRefreshContext,
  AuthRefreshResult,
} from './auth-refresh.js';

// ----- L1 event surface -----
export type {
  AuthExpiredEvent,
  AuthExpiredReason,
  AuthRefreshStartedEvent,
  AuthRefreshSucceededEvent,
  AuthRefreshFailedEvent,
  SessionExpiredEvent,
  ConnectionState,
  ConnectionStateChangedEvent,
  MessageBatchReceivedEvent,
  MessageReceivedEvent,
  OutboxDrainedEvent,
  OutboxStateChangedEvent,
  PeerReadCursorUpdatedEvent,
  PongReceivedEvent,
  ReadCursorUpdatedEvent,
  ReservedL1Type,
  SdkEvent,
  SequencedSdkEvent,
  SyncFullRebuildRequiredEvent,
  TypingReceivedEvent,
  ChannelPublishReceivedEvent,
} from './events.js';

// ----- MessageType / SubscribeAction -----
export { MessageType, SubscribeAction } from './message-type.js';

// ----- RPC routes (mirrors privchat_protocol::rpc::routes) -----
export { Routes } from './routes.js';

// ----- Typed RPC sugar methods + their Request/Response shapes -----
// Side-effect import installs methods on PrivchatClient.prototype.
import './api-methods.js';
export type * from './api-types.js';
// Media-message + upload helpers (free functions, not on the client class).
export {
  ContentMessageType,
  buildSendFileInput,
  buildSendImageInput,
  buildSendVideoInput,
  buildSendVoiceInput,
  uploadFileViaToken,
  type SendFileMetadata,
  type SendImageMetadata,
  type SendVideoMetadata,
  type SendVoiceMetadata,
  type UploadProgressEvent,
} from './api-methods.js';

// ----- ID / number boundary helpers -----
export {
  bigintToIdString,
  bigintToNumber,
  bigintToOptionalIdString,
  idStringToBigint,
  numberToBigint,
  optionalIdStringToBigint,
} from './codec/ids.js';

// ----- Heartbeat -----
export {
  decodePingRequest,
  decodePongResponse,
  encodePingRequest,
  encodePongResponse,
} from './codec/ping.js';
export type { PingRequest, PongResponse } from './codec/ping.js';

// ----- Subscribe / unsubscribe -----
export {
  decodeSubscribeRequest,
  decodeSubscribeResponse,
  encodeSubscribeRequest,
  encodeSubscribeResponse,
} from './codec/subscribe.js';
export type { SubscribeRequest, SubscribeResponse } from './codec/subscribe.js';

// ----- RPC envelope (opaque body bytes) -----
export {
  decodeRpcRequest,
  decodeRpcResponse,
  encodeRpcRequest,
  encodeRpcResponse,
} from './codec/rpc.js';
export type { RpcRequest, RpcResponse } from './codec/rpc.js';

// ----- Channel Transfer (biz_type 19/20, bi-directional RPC) -----
export {
  decodeTransferRequest,
  decodeTransferResponse,
  encodeTransferRequest,
  encodeTransferResponse,
} from './codec/transfer.js';
export type {
  TransferRequest,
  TransferResponse,
} from './codec/transfer.js';

// ----- Send (client → server) -----
export {
  decodeSendMessageRequest,
  decodeSendMessageResponse,
  encodeSendMessageRequest,
  encodeSendMessageResponse,
} from './codec/send.js';
export type {
  MessageSetting,
  SendMessageRequest,
  SendMessageResponse,
} from './codec/send.js';

// ----- Push (server → client; single + batch) -----
export {
  decodePushBatchRequest,
  decodePushBatchResponse,
  decodePushMessageRequest,
  decodePushMessageResponse,
  encodePushBatchRequest,
  encodePushBatchResponse,
  encodePushMessageRequest,
  encodePushMessageResponse,
} from './codec/push.js';
export type {
  PushBatchRequest,
  PushBatchResponse,
  PushMessageRequest,
  PushMessageResponse,
} from './codec/push.js';

// ----- Authorization -----
export {
  decodeAuthorizationRequest,
  decodeAuthorizationResponse,
  encodeAuthorizationRequest,
  encodeAuthorizationResponse,
} from './codec/auth.js';
export type {
  AuthorizationRequest,
  AuthorizationResponse,
  AuthType,
  ClientInfo,
  DeviceInfo,
  DeviceType,
  ServerInfo,
} from './codec/auth.js';

// ----- Message payload envelope (typed metadata union) -----
export {
  decodeMessagePayloadEnvelope,
  encodeMessagePayloadEnvelope,
} from './codec/payload.js';

export {
  CANONICAL_TIMELINE_EVENT_SCHEMA_V1,
  canonicalEventMetricSnapshot,
  decodeCanonicalTimelineEvent,
  encodeCanonicalTimelineEvent,
  resolveCanonicalTimelineEvent,
} from './codec/timeline.js';
export type {
  CanonicalEventResolution,
  CanonicalEventSource,
  CanonicalTimelineEvent,
} from './codec/timeline.js';
export type {
  ContactCardMetadata,
  FileMetadata,
  ForwardMessageRef,
  ForwardMetadata,
  ImageMetadata,
  LinkMetadata,
  LocationMetadata,
  MessageMetadata,
  MessagePayloadEnvelope,
  MessageSource,
  StickerMetadata,
  VideoMetadata,
  VoiceMetadata,
} from './codec/payload.js';

// ---- P4.2 runtime alignment layer (CLIENT_GLOBAL_STATE §17; canonical = KMP app) ----
export { userDisplayName, isSystemUser, USER_TYPE_SYSTEM } from './runtime/user-display.js';
export type { UserDisplayInput } from './runtime/user-display.js';
export { resolveAvatarModel } from './runtime/avatar-model.js';
export type { AvatarModel, AvatarFreshness, ResolveAvatarInput } from './runtime/avatar-model.js';
export {
  ensureUserAvatarCached,
  lookupCachedAvatar,
  clearAvatarObjectUrls,
} from './runtime/avatar-cache.js';
export type { AvatarCacheHit } from './runtime/avatar-cache.js';
export { createClientRuntime, resolveRuntimeBanner, isServerBusySignal } from './runtime/client-runtime.js';
export type {
  ClientRuntime,
  ClientRuntimeError,
  ConnectivityRuntimeState,
  SyncRuntimeState,
  SendQueueRuntimeState,
  RuntimeBannerKind,
  RuntimeSlice,
  RuntimeClientLike,
} from './runtime/client-runtime.js';
