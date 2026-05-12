import * as flatbuffers from 'flatbuffers';
import {
  MessageSetting as FbMessageSetting,
} from '../generated/privchat/protocol/message-setting.js';
import {
  PushBatchRequest as FbPushBatchRequest,
} from '../generated/privchat/protocol/push-batch-request.js';
import {
  PushBatchResponse as FbPushBatchResponse,
} from '../generated/privchat/protocol/push-batch-response.js';
import {
  PushMessageRequest as FbPushMessageRequest,
} from '../generated/privchat/protocol/push-message-request.js';
import {
  PushMessageResponse as FbPushMessageResponse,
} from '../generated/privchat/protocol/push-message-response.js';
import { bigintToIdString, idStringToBigint } from './ids.js';
import type { MessageSetting } from './send.js';

export interface PushMessageRequest {
  setting: MessageSetting;
  msg_key: string;
  server_message_id: string;
  message_seq: number;
  local_message_id: string;
  stream_no: string;
  stream_seq: number;
  stream_flag: number;
  /** Second-resolution timestamp (u32 in source). */
  timestamp: number;
  channel_id: string;
  channel_type: number;
  message_type: number;
  expire: number;
  topic: string;
  from_uid: string;
  payload: Uint8Array;
  /** True when this push notifies a recall of an existing server_message_id. */
  deleted: boolean;
}

export interface PushMessageResponse {
  succeed: boolean;
  message?: string;
}

export interface PushBatchRequest {
  messages: PushMessageRequest[];
}

export interface PushBatchResponse {
  succeed: boolean;
  message?: string;
}

// ----- Internal: encode / decode a single PushMessage table inside a batch.

function encodePushMessageInto(
  builder: flatbuffers.Builder,
  msg: PushMessageRequest,
): flatbuffers.Offset {
  const settingOffset = FbMessageSetting.createMessageSetting(
    builder,
    msg.setting.need_receipt,
    msg.setting.signal,
  );
  const msgKeyOffset = builder.createString(msg.msg_key);
  const streamNoOffset = builder.createString(msg.stream_no);
  const topicOffset = builder.createString(msg.topic);
  const payloadOffset = FbPushMessageRequest.createPayloadVector(builder, msg.payload);

  FbPushMessageRequest.startPushMessageRequest(builder);
  FbPushMessageRequest.addSetting(builder, settingOffset);
  FbPushMessageRequest.addMsgKey(builder, msgKeyOffset);
  FbPushMessageRequest.addServerMessageId(builder, idStringToBigint(msg.server_message_id));
  FbPushMessageRequest.addMessageSeq(builder, msg.message_seq);
  FbPushMessageRequest.addLocalMessageId(builder, idStringToBigint(msg.local_message_id));
  FbPushMessageRequest.addStreamNo(builder, streamNoOffset);
  FbPushMessageRequest.addStreamSeq(builder, msg.stream_seq);
  FbPushMessageRequest.addStreamFlag(builder, msg.stream_flag);
  FbPushMessageRequest.addTimestamp(builder, msg.timestamp);
  FbPushMessageRequest.addChannelId(builder, idStringToBigint(msg.channel_id));
  FbPushMessageRequest.addChannelType(builder, msg.channel_type);
  FbPushMessageRequest.addMessageType(builder, msg.message_type);
  FbPushMessageRequest.addExpire(builder, msg.expire);
  FbPushMessageRequest.addTopic(builder, topicOffset);
  FbPushMessageRequest.addFromUid(builder, idStringToBigint(msg.from_uid));
  FbPushMessageRequest.addPayload(builder, payloadOffset);
  FbPushMessageRequest.addDeleted(builder, msg.deleted);
  return FbPushMessageRequest.endPushMessageRequest(builder);
}

function decodePushMessageView(view: FbPushMessageRequest): PushMessageRequest {
  const settingView = view.setting();
  const setting: MessageSetting = settingView
    ? { need_receipt: settingView.needReceipt(), signal: settingView.signal() }
    : { need_receipt: false, signal: 0 };
  return {
    setting,
    msg_key: view.msgKey() ?? '',
    server_message_id: bigintToIdString(view.serverMessageId()),
    message_seq: view.messageSeq(),
    local_message_id: bigintToIdString(view.localMessageId()),
    stream_no: view.streamNo() ?? '',
    stream_seq: view.streamSeq(),
    stream_flag: view.streamFlag(),
    timestamp: view.timestamp(),
    channel_id: bigintToIdString(view.channelId()),
    channel_type: view.channelType(),
    message_type: view.messageType(),
    expire: view.expire(),
    topic: view.topic() ?? '',
    from_uid: bigintToIdString(view.fromUid()),
    payload: view.payloadArray() ?? new Uint8Array(0),
    deleted: view.deleted(),
  };
}

// ----- Public encode/decode -----

export function encodePushMessageRequest(msg: PushMessageRequest): Uint8Array {
  const builder = new flatbuffers.Builder(1024);
  const offset = encodePushMessageInto(builder, msg);
  builder.finish(offset);
  return builder.asUint8Array();
}

export function decodePushMessageRequest(bytes: Uint8Array): PushMessageRequest {
  const view = FbPushMessageRequest.getRootAsPushMessageRequest(
    new flatbuffers.ByteBuffer(bytes),
  );
  return decodePushMessageView(view);
}

export function encodePushMessageResponse(msg: PushMessageResponse): Uint8Array {
  const builder = new flatbuffers.Builder(64);
  const messageOffset = msg.message ? builder.createString(msg.message) : 0;
  FbPushMessageResponse.startPushMessageResponse(builder);
  FbPushMessageResponse.addSucceed(builder, msg.succeed);
  if (msg.message) FbPushMessageResponse.addMessage(builder, messageOffset);
  const offset = FbPushMessageResponse.endPushMessageResponse(builder);
  builder.finish(offset);
  return builder.asUint8Array();
}

export function decodePushMessageResponse(bytes: Uint8Array): PushMessageResponse {
  const view = FbPushMessageResponse.getRootAsPushMessageResponse(
    new flatbuffers.ByteBuffer(bytes),
  );
  const message = view.message();
  return {
    succeed: view.succeed(),
    message: message ?? undefined,
  };
}

export function encodePushBatchRequest(msg: PushBatchRequest): Uint8Array {
  const builder = new flatbuffers.Builder(2048);
  const childOffsets = msg.messages.map((m) => encodePushMessageInto(builder, m));
  const messagesVec = FbPushBatchRequest.createMessagesVector(builder, childOffsets);
  const offset = FbPushBatchRequest.createPushBatchRequest(builder, messagesVec);
  builder.finish(offset);
  return builder.asUint8Array();
}

export function decodePushBatchRequest(bytes: Uint8Array): PushBatchRequest {
  const view = FbPushBatchRequest.getRootAsPushBatchRequest(
    new flatbuffers.ByteBuffer(bytes),
  );
  const messages: PushMessageRequest[] = [];
  for (let i = 0; i < view.messagesLength(); i++) {
    const child = view.messages(i);
    if (child) messages.push(decodePushMessageView(child));
  }
  return { messages };
}

export function encodePushBatchResponse(msg: PushBatchResponse): Uint8Array {
  const builder = new flatbuffers.Builder(64);
  const messageOffset = msg.message ? builder.createString(msg.message) : 0;
  FbPushBatchResponse.startPushBatchResponse(builder);
  FbPushBatchResponse.addSucceed(builder, msg.succeed);
  if (msg.message) FbPushBatchResponse.addMessage(builder, messageOffset);
  const offset = FbPushBatchResponse.endPushBatchResponse(builder);
  builder.finish(offset);
  return builder.asUint8Array();
}

export function decodePushBatchResponse(bytes: Uint8Array): PushBatchResponse {
  const view = FbPushBatchResponse.getRootAsPushBatchResponse(
    new flatbuffers.ByteBuffer(bytes),
  );
  const message = view.message();
  return {
    succeed: view.succeed(),
    message: message ?? undefined,
  };
}
