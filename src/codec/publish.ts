// Decode-only wrapper for FlatBuffers `PublishRequest` packets.
//
// Server's RPC handlers (e.g. `presence/typing`) wrap notification
// payloads in a `PublishRequest` and broadcast them via msgtrans's
// subscribe/publish channel — so any inbound packet with bizType
// `MessageType.PublishRequest` lands here. We don't expose the raw
// FlatBuffers class to consumers; this codec lifts the fields we
// actually use into a plain TS object with idiomatic types.
//
// Encoding the outbound PublishRequest is server-only — the SDK never
// publishes; it just consumes broadcasts. So no `encodePublishRequest`
// is provided.

import * as flatbuffers from 'flatbuffers';
import { PublishRequest as FbPublishRequest } from '../generated/privchat/protocol/publish-request.js';
import { bigintToIdString } from './ids.js';

export interface PublishRequest {
  channel_id: string;
  /** Topic discriminator chosen by the publisher. Known values:
   *  - "typing" — TypingStatusNotification JSON in `payload`
   *  Future: "presence", "reaction_changed", etc. */
  topic: string;
  /** Server unix-seconds timestamp at publish time. */
  timestamp: number;
  /** Topic-specific payload bytes. Schema is determined by `topic`. */
  payload: Uint8Array;
  /** Publishing user's id (decimal string). May be empty when the
   *  server publishes without an originating user (system events). */
  publisher: string;
  /** Optional server_message_id when the publish corresponds to a
   *  durable message; for transient signals (typing) this is undefined. */
  server_message_id?: string;
}

export function decodePublishRequest(bytes: Uint8Array): PublishRequest {
  const bb = new flatbuffers.ByteBuffer(bytes);
  const fb = FbPublishRequest.getRootAsPublishRequest(bb);
  // payloadArray() returns a view into the original buffer; copy so
  // downstream consumers can hold the bytes after the source is gone.
  const view = fb.payloadArray();
  const payload = view !== null ? new Uint8Array(view) : new Uint8Array();
  const sid = fb.serverMessageId();
  return {
    channel_id: bigintToIdString(fb.channelId()),
    topic: fb.topic() ?? '',
    timestamp: Number(fb.timestamp()),
    payload,
    publisher: fb.publisher() ?? '',
    server_message_id: sid === BigInt(0) ? undefined : bigintToIdString(sid),
  };
}
