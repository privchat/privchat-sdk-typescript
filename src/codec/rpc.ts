// RPC envelope. body / data are opaque bytes — encoding is decided by
// `route` (the Rust server currently expects JSON UTF-8). The codec does
// NOT touch the inner bytes.

import * as flatbuffers from 'flatbuffers';
import {
  RpcRequest as FbRpcRequest,
} from '../generated/privchat/protocol/rpc-request.js';
import {
  RpcResponse as FbRpcResponse,
} from '../generated/privchat/protocol/rpc-response.js';

export interface RpcRequest {
  route: string;
  body: Uint8Array;
}

export interface RpcResponse {
  /** Application-defined status (0 = success by convention). */
  code: number;
  message: string;
  /** None == empty payload (encoded as zero-length [ubyte] on the wire). */
  data?: Uint8Array;
}

export function encodeRpcRequest(msg: RpcRequest): Uint8Array {
  const builder = new flatbuffers.Builder(256);
  const routeOffset = builder.createString(msg.route);
  const bodyOffset = FbRpcRequest.createBodyVector(builder, msg.body);
  const offset = FbRpcRequest.createRpcRequest(builder, routeOffset, bodyOffset);
  builder.finish(offset);
  return builder.asUint8Array();
}

export function decodeRpcRequest(bytes: Uint8Array): RpcRequest {
  const view = FbRpcRequest.getRootAsRpcRequest(new flatbuffers.ByteBuffer(bytes));
  return {
    route: view.route() ?? '',
    body: view.bodyArray() ?? new Uint8Array(0),
  };
}

export function encodeRpcResponse(msg: RpcResponse): Uint8Array {
  const builder = new flatbuffers.Builder(256);
  const messageOffset = builder.createString(msg.message);
  // None encodes as empty [ubyte]; decoder distinguishes by length.
  const dataOffset = FbRpcResponse.createDataVector(
    builder,
    msg.data ?? new Uint8Array(0),
  );
  const offset = FbRpcResponse.createRpcResponse(
    builder,
    msg.code,
    messageOffset,
    dataOffset,
  );
  builder.finish(offset);
  return builder.asUint8Array();
}

export function decodeRpcResponse(bytes: Uint8Array): RpcResponse {
  const view = FbRpcResponse.getRootAsRpcResponse(new flatbuffers.ByteBuffer(bytes));
  const data = view.dataArray() ?? new Uint8Array(0);
  return {
    code: view.code(),
    message: view.message() ?? '',
    data: data.length === 0 ? undefined : data,
  };
}
