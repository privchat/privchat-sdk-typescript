import * as flatbuffers from 'flatbuffers';
import {
  MessageSetting as FbMessageSetting,
} from '../generated/privchat/protocol/message-setting.js';
import {
  SendMessageRequest as FbSendMessageRequest,
} from '../generated/privchat/protocol/send-message-request.js';
import {
  SendMessageResponse as FbSendMessageResponse,
} from '../generated/privchat/protocol/send-message-response.js';
import { bigintToIdString, idStringToBigint } from './ids.js';

export interface MessageSetting {
  need_receipt: boolean;
  signal: number;
}

export interface SendMessageRequest {
  setting: MessageSetting;
  client_seq: number;
  local_message_id: string;
  stream_no: string;
  channel_id: string;
  /** Application content type (NOT the wire MessageType). */
  message_type: number;
  expire: number;
  from_uid: string;
  topic: string;
  payload: Uint8Array;
}

export interface SendMessageResponse {
  client_seq: number;
  server_message_id: string;
  message_seq: number;
  reason_code: number;
}

export function encodeSendMessageRequest(msg: SendMessageRequest): Uint8Array {
  const builder = new flatbuffers.Builder(1024);
  const settingOffset = FbMessageSetting.createMessageSetting(
    builder,
    msg.setting.need_receipt,
    msg.setting.signal,
  );
  const streamNoOffset = builder.createString(msg.stream_no);
  const topicOffset = builder.createString(msg.topic);
  const payloadOffset = FbSendMessageRequest.createPayloadVector(builder, msg.payload);
  const offset = FbSendMessageRequest.createSendMessageRequest(
    builder,
    settingOffset,
    msg.client_seq,
    idStringToBigint(msg.local_message_id),
    streamNoOffset,
    idStringToBigint(msg.channel_id),
    msg.message_type,
    msg.expire,
    idStringToBigint(msg.from_uid),
    topicOffset,
    payloadOffset,
  );
  builder.finish(offset);
  return builder.asUint8Array();
}

export function decodeSendMessageRequest(bytes: Uint8Array): SendMessageRequest {
  const view = FbSendMessageRequest.getRootAsSendMessageRequest(
    new flatbuffers.ByteBuffer(bytes),
  );
  const settingView = view.setting();
  const setting: MessageSetting = settingView
    ? { need_receipt: settingView.needReceipt(), signal: settingView.signal() }
    : { need_receipt: false, signal: 0 };

  return {
    setting,
    client_seq: view.clientSeq(),
    local_message_id: bigintToIdString(view.localMessageId()),
    stream_no: view.streamNo() ?? '',
    channel_id: bigintToIdString(view.channelId()),
    message_type: view.messageType(),
    expire: view.expire(),
    from_uid: bigintToIdString(view.fromUid()),
    topic: view.topic() ?? '',
    payload: view.payloadArray() ?? new Uint8Array(0),
  };
}

export function encodeSendMessageResponse(msg: SendMessageResponse): Uint8Array {
  const builder = new flatbuffers.Builder(64);
  const offset = FbSendMessageResponse.createSendMessageResponse(
    builder,
    msg.client_seq,
    idStringToBigint(msg.server_message_id),
    msg.message_seq,
    msg.reason_code,
  );
  builder.finish(offset);
  return builder.asUint8Array();
}

export function decodeSendMessageResponse(bytes: Uint8Array): SendMessageResponse {
  const view = FbSendMessageResponse.getRootAsSendMessageResponse(
    new flatbuffers.ByteBuffer(bytes),
  );
  return {
    client_seq: view.clientSeq(),
    server_message_id: bigintToIdString(view.serverMessageId()),
    message_seq: view.messageSeq(),
    reason_code: view.reasonCode(),
  };
}
