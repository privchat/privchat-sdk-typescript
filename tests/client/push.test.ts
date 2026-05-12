// Inbound push handling: PushMessageRequest / PushBatchRequest / PongResponse
// fan-out + auto-ACK on Request-typed pushes.

import { describe, expect, it } from 'vitest';
import { Packet, PacketType } from '@msgtrans/client';
import {
  MessageType,
  PrivchatClient,
  decodePushBatchResponse,
  decodePushMessageResponse,
  encodePongResponse,
  encodePushBatchRequest,
  encodePushMessageRequest,
  type PushBatchRequest,
  type PushMessageRequest,
} from '../../src/index.js';
import { FakeTransport } from './fake-transport.js';

const samplePushMessage = (overrides: Partial<PushMessageRequest> = {}): PushMessageRequest => ({
  setting: { need_receipt: true, signal: 0 },
  msg_key: 'k-1',
  server_message_id: '700110001',
  message_seq: 100,
  local_message_id: '900710001',
  stream_no: '',
  stream_seq: 0,
  stream_flag: 0,
  timestamp: 1_714_680_000,
  channel_id: '12345',
  channel_type: 1,
  message_type: 0,
  expire: 0,
  topic: '',
  from_uid: '999',
  payload: new TextEncoder().encode('{"content":"hi"}'),
  deleted: false,
  ...overrides,
});

const fireRequest = (t: FakeTransport, bizType: number, payload: Uint8Array) => {
  t.fireMessage(
    new Packet({
      packetType: PacketType.Request,
      messageId: 12345,
      bizType,
      payload,
    }),
  );
};

const fireOneWay = (t: FakeTransport, bizType: number, payload: Uint8Array) => {
  t.fireMessage(
    new Packet({
      packetType: PacketType.OneWay,
      messageId: 0,
      bizType,
      payload,
    }),
  );
};

describe('onPushMessage', () => {
  it('decodes inbound push and fans out to all handlers', () => {
    const t = new FakeTransport();
    const client = new PrivchatClient({ transport: t });
    const seenA: PushMessageRequest[] = [];
    const seenB: PushMessageRequest[] = [];
    client.onPushMessage((m) => seenA.push(m));
    client.onPushMessage((m) => seenB.push(m));

    fireRequest(
      t,
      MessageType.PushMessageRequest,
      encodePushMessageRequest(samplePushMessage()),
    );

    expect(seenA).toHaveLength(1);
    expect(seenB).toHaveLength(1);
    expect(seenA[0]!.server_message_id).toBe('700110001');
    expect(new TextDecoder().decode(seenA[0]!.payload)).toBe('{"content":"hi"}');
  });

  it('auto-ACKs Request-typed push with PushMessageResponse{succeed:true}', () => {
    const t = new FakeTransport();
    new PrivchatClient({ transport: t });
    fireRequest(
      t,
      MessageType.PushMessageRequest,
      encodePushMessageRequest(samplePushMessage()),
    );

    expect(t.sent).toHaveLength(1);
    const ack = t.sent[0]!;
    expect(ack.packetType).toBe(PacketType.Response);
    expect(ack.messageId).toBe(12345);
    expect(ack.bizType).toBe(MessageType.PushMessageResponse);
    expect(decodePushMessageResponse(ack.payload).succeed).toBe(true);
  });

  it('does NOT auto-ACK OneWay-typed push (server did not request one)', () => {
    const t = new FakeTransport();
    const client = new PrivchatClient({ transport: t });
    const seen: PushMessageRequest[] = [];
    client.onPushMessage((m) => seen.push(m));

    fireOneWay(
      t,
      MessageType.PushMessageRequest,
      encodePushMessageRequest(samplePushMessage()),
    );

    expect(seen).toHaveLength(1);
    expect(t.sent).toHaveLength(0);
  });

  it('returns an unsubscribe fn that detaches the handler', () => {
    const t = new FakeTransport();
    const client = new PrivchatClient({ transport: t });
    const seen: PushMessageRequest[] = [];
    const off = client.onPushMessage((m) => seen.push(m));

    fireOneWay(t, MessageType.PushMessageRequest, encodePushMessageRequest(samplePushMessage()));
    off();
    fireOneWay(t, MessageType.PushMessageRequest, encodePushMessageRequest(samplePushMessage()));

    expect(seen).toHaveLength(1);
  });

  it('handler errors do not break the inbound loop', () => {
    const t = new FakeTransport();
    const client = new PrivchatClient({ transport: t });
    const survivor: PushMessageRequest[] = [];
    client.onPushMessage(() => {
      throw new Error('boom');
    });
    client.onPushMessage((m) => survivor.push(m));

    fireOneWay(t, MessageType.PushMessageRequest, encodePushMessageRequest(samplePushMessage()));
    expect(survivor).toHaveLength(1);
  });
});

describe('onPushBatch', () => {
  it('decodes batch and auto-ACKs', () => {
    const t = new FakeTransport();
    const client = new PrivchatClient({ transport: t });
    const seen: PushBatchRequest[] = [];
    client.onPushBatch((b) => seen.push(b));

    const batch: PushBatchRequest = {
      messages: [
        samplePushMessage({ msg_key: 'k-1', server_message_id: '1' }),
        samplePushMessage({ msg_key: 'k-2', server_message_id: '2' }),
      ],
    };
    fireRequest(t, MessageType.PushBatchRequest, encodePushBatchRequest(batch));

    expect(seen).toHaveLength(1);
    expect(seen[0]!.messages).toHaveLength(2);
    expect(seen[0]!.messages[0]!.msg_key).toBe('k-1');

    expect(t.sent).toHaveLength(1);
    const ack = t.sent[0]!;
    expect(ack.bizType).toBe(MessageType.PushBatchResponse);
    expect(decodePushBatchResponse(ack.payload).succeed).toBe(true);
  });
});

describe('onPong', () => {
  it('fires for OneWay PongResponse pushes', () => {
    const t = new FakeTransport();
    const client = new PrivchatClient({ transport: t });
    const seen: number[] = [];
    client.onPong((p) => seen.push(p.timestamp));

    fireOneWay(t, MessageType.PongResponse, encodePongResponse({ timestamp: 1234 }));
    expect(seen).toEqual([1234]);
    // Pong is not a Request — no ACK should be sent.
    expect(t.sent).toHaveLength(0);
  });
});

describe('unknown bizType', () => {
  it('is silently ignored (no throw, no side effect)', () => {
    const t = new FakeTransport();
    new PrivchatClient({ transport: t });
    fireOneWay(t, /* unrecognised */ 99, new Uint8Array(0));
    expect(t.sent).toHaveLength(0);
  });
});
