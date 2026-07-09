// P1-05: room broadcast dedup by (channel_id, server_message_id).
// On subscribe the server replays history that overlaps the live stream,
// so the same PublishRequest frame can arrive twice — the SDK drops repeats.

import { describe, expect, it } from 'vitest';
import { Packet, PacketType } from '@msgtrans/client';
import * as flatbuffers from 'flatbuffers';
import { MessageType, PrivchatClient } from '../../src/index.js';
import { PublishRequest as FbPublishRequest } from '../../src/generated/privchat/protocol/publish-request.js';
import { FakeTransport } from './fake-transport.js';

function encodeRoomPublish(opts: {
  channelId: bigint;
  topic: string;
  payload: string;
  serverMessageId: bigint;
}): Uint8Array {
  const b = new flatbuffers.Builder(64);
  const topicOff = b.createString(opts.topic);
  const pubOff = b.createString('');
  const payloadOff = FbPublishRequest.createPayloadVector(
    b,
    new TextEncoder().encode(opts.payload),
  );
  const off = FbPublishRequest.createPublishRequest(
    b,
    opts.channelId,
    topicOff,
    BigInt(0),
    payloadOff,
    pubOff,
    opts.serverMessageId,
  );
  b.finish(off);
  return b.asUint8Array();
}

const fireRoom = (t: FakeTransport, bytes: Uint8Array) =>
  t.fireMessage(
    new Packet({
      packetType: PacketType.OneWay,
      messageId: 0,
      bizType: MessageType.PublishRequest,
      payload: bytes,
    }),
  );

describe('room broadcast dedup (P1-05)', () => {
  it('drops repeats by server_message_id, keeps distinct ones', () => {
    const t = new FakeTransport();
    const client = new PrivchatClient({ transport: t });
    const seen: Array<{ id?: string; text: string }> = [];
    client.observeEvents((env) => {
      if (env.event.type === 'channel_publish_received') {
        seen.push({ id: env.event.server_message_id, text: env.event.payload_text });
      }
    });

    const mk = (id: bigint, text: string) =>
      encodeRoomPublish({ channelId: BigInt(500), topic: 'game_state', payload: text, serverMessageId: id });

    // replay: 100,101,102 then live: 102(dup),103
    fireRoom(t, mk(BigInt(100), 'a'));
    fireRoom(t, mk(BigInt(101), 'b'));
    fireRoom(t, mk(BigInt(102), 'c'));
    fireRoom(t, mk(BigInt(102), 'c')); // duplicate of replayed frame
    fireRoom(t, mk(BigInt(103), 'd'));

    expect(seen.map((s) => s.id)).toEqual(['100', '101', '102', '103']);
    expect(seen.map((s) => s.text)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('never dedupes frames without a server_message_id', () => {
    const t = new FakeTransport();
    const client = new PrivchatClient({ transport: t });
    let count = 0;
    client.observeEvents((env) => {
      if (env.event.type === 'channel_publish_received') count++;
    });
    // serverMessageId=0 → decoder maps to undefined → always forwarded
    const frame = encodeRoomPublish({ channelId: BigInt(501), topic: 'x', payload: 'p', serverMessageId: BigInt(0) });
    fireRoom(t, frame);
    fireRoom(t, frame);
    expect(count).toBe(2);
  });

  it('dedup is scoped per channel', () => {
    const t = new FakeTransport();
    const client = new PrivchatClient({ transport: t });
    const chans: string[] = [];
    client.observeEvents((env) => {
      if (env.event.type === 'channel_publish_received') chans.push(env.event.channel_id);
    });
    fireRoom(t, encodeRoomPublish({ channelId: BigInt(600), topic: 'x', payload: 'p', serverMessageId: BigInt(9) }));
    fireRoom(t, encodeRoomPublish({ channelId: BigInt(601), topic: 'x', payload: 'p', serverMessageId: BigInt(9) }));
    expect(chans).toEqual(['600', '601']);
  });
});
