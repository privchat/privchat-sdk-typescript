// Mirrors `privchat_protocol::MessageType` (Rust) — numeric tag carried in
// the msgtrans `bizType` byte. Values are PERMANENT once assigned; only add
// new variants at the end. `Unknown = 0` is the FlatBuffers default and
// indicates an ill-formed packet.

export const MessageType = {
  Unknown: 0,
  AuthorizationRequest: 1,
  AuthorizationResponse: 2,
  DisconnectRequest: 3,
  DisconnectResponse: 4,
  SendMessageRequest: 5,
  SendMessageResponse: 6,
  PushMessageRequest: 7,
  PushMessageResponse: 8,
  PushBatchRequest: 9,
  PushBatchResponse: 10,
  PingRequest: 11,
  PongResponse: 12,
  SubscribeRequest: 13,
  SubscribeResponse: 14,
  PublishRequest: 15,
  PublishResponse: 16,
  RpcRequest: 17,
  RpcResponse: 18,
  // Channel Transfer (bi-directional RPC). See `02-server/CHANNEL_TRANSFER_SPEC.md` v2.0.
  TransferRequest: 19,
  TransferResponse: 20,
} as const;
export type MessageType = (typeof MessageType)[keyof typeof MessageType];

// Subscribe action codes (carried in SubscribeRequest.action). The wire
// `MessageType` is the same for sub/unsub; `action` distinguishes them.
export const SubscribeAction = {
  Subscribe: 1,
  Unsubscribe: 2,
} as const;
export type SubscribeAction =
  (typeof SubscribeAction)[keyof typeof SubscribeAction];
