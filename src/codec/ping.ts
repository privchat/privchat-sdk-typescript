// Heartbeat wire codec. Application-layer ping (NOT the WebSocket
// control-frame ping). Single i64 timestamp field; we surface it as
// `number` because ms-epoch is well within JS safe-integer range.

import * as flatbuffers from 'flatbuffers';
import {
  PingRequest as FbPingRequest,
} from '../generated/privchat/protocol/ping-request.js';
import {
  PongResponse as FbPongResponse,
} from '../generated/privchat/protocol/pong-response.js';
import { bigintToNumber, numberToBigint } from './ids.js';

export interface PingRequest {
  /** Unix epoch milliseconds. */
  timestamp: number;
}

export interface PongResponse {
  /** Unix epoch milliseconds. */
  timestamp: number;
}

export function encodePingRequest(msg: PingRequest): Uint8Array {
  const builder = new flatbuffers.Builder(64);
  FbPingRequest.startPingRequest(builder);
  FbPingRequest.addTimestamp(builder, numberToBigint(msg.timestamp));
  const offset = FbPingRequest.endPingRequest(builder);
  builder.finish(offset);
  return builder.asUint8Array();
}

export function decodePingRequest(bytes: Uint8Array): PingRequest {
  const buf = new flatbuffers.ByteBuffer(bytes);
  const view = FbPingRequest.getRootAsPingRequest(buf);
  return {
    timestamp: bigintToNumber(view.timestamp()),
  };
}

export function encodePongResponse(msg: PongResponse): Uint8Array {
  const builder = new flatbuffers.Builder(64);
  FbPongResponse.startPongResponse(builder);
  FbPongResponse.addTimestamp(builder, numberToBigint(msg.timestamp));
  const offset = FbPongResponse.endPongResponse(builder);
  builder.finish(offset);
  return builder.asUint8Array();
}

export function decodePongResponse(bytes: Uint8Array): PongResponse {
  const buf = new flatbuffers.ByteBuffer(bytes);
  const view = FbPongResponse.getRootAsPongResponse(buf);
  return {
    timestamp: bigintToNumber(view.timestamp()),
  };
}
