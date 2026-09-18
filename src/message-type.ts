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

/**
 * 频道类型的 wire 编号——与 privchat-protocol `protocol::ChannelType` 一致,
 * 所有端唯一真源:1=Direct, 2=Group, 3=Room。**没有 0**(0 是"未填",服务端拒绝)。
 * server 数据库内部另有 0/1/2 的存储编号,绝不出现在线上。
 */
export const ChannelType = {
  Direct: 1,
  Group: 2,
  Room: 3,
} as const;
export type ChannelType = (typeof ChannelType)[keyof typeof ChannelType];

export function isChannelType(value: number): value is ChannelType {
  return value === ChannelType.Direct || value === ChannelType.Group || value === ChannelType.Room;
}
