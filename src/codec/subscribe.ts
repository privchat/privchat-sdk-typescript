import * as flatbuffers from 'flatbuffers';
import {
  SubscribeRequest as FbSubscribeRequest,
} from '../generated/privchat/protocol/subscribe-request.js';
import {
  SubscribeResponse as FbSubscribeResponse,
} from '../generated/privchat/protocol/subscribe-response.js';
import { bigintToIdString, idStringToBigint } from './ids.js';

export interface SubscribeRequest {
  /** Bit flags (raw u8 — NOT MessageSetting). */
  setting: number;
  local_message_id: string;
  channel_id: string;
  channel_type: number;
  /** Action code: subscribe / unsubscribe / query (application-defined). */
  action: number;
  param: string;
}

export interface SubscribeResponse {
  local_message_id: string;
  channel_id: string;
  channel_type: number;
  action: number;
  reason_code: number;
}

export function encodeSubscribeRequest(msg: SubscribeRequest): Uint8Array {
  const builder = new flatbuffers.Builder(128);
  const paramOffset = builder.createString(msg.param);
  const offset = FbSubscribeRequest.createSubscribeRequest(
    builder,
    msg.setting,
    idStringToBigint(msg.local_message_id),
    idStringToBigint(msg.channel_id),
    msg.channel_type,
    msg.action,
    paramOffset,
  );
  builder.finish(offset);
  return builder.asUint8Array();
}

export function decodeSubscribeRequest(bytes: Uint8Array): SubscribeRequest {
  const view = FbSubscribeRequest.getRootAsSubscribeRequest(
    new flatbuffers.ByteBuffer(bytes),
  );
  return {
    setting: view.setting(),
    local_message_id: bigintToIdString(view.localMessageId()),
    channel_id: bigintToIdString(view.channelId()),
    channel_type: view.channelType(),
    action: view.action(),
    param: view.param() ?? '',
  };
}

export function encodeSubscribeResponse(msg: SubscribeResponse): Uint8Array {
  const builder = new flatbuffers.Builder(64);
  FbSubscribeResponse.startSubscribeResponse(builder);
  FbSubscribeResponse.addLocalMessageId(builder, idStringToBigint(msg.local_message_id));
  FbSubscribeResponse.addChannelId(builder, idStringToBigint(msg.channel_id));
  FbSubscribeResponse.addChannelType(builder, msg.channel_type);
  FbSubscribeResponse.addAction(builder, msg.action);
  FbSubscribeResponse.addReasonCode(builder, msg.reason_code);
  const offset = FbSubscribeResponse.endSubscribeResponse(builder);
  builder.finish(offset);
  return builder.asUint8Array();
}

export function decodeSubscribeResponse(bytes: Uint8Array): SubscribeResponse {
  const view = FbSubscribeResponse.getRootAsSubscribeResponse(
    new flatbuffers.ByteBuffer(bytes),
  );
  return {
    local_message_id: bigintToIdString(view.localMessageId()),
    channel_id: bigintToIdString(view.channelId()),
    channel_type: view.channelType(),
    action: view.action(),
    reason_code: view.reasonCode(),
  };
}
