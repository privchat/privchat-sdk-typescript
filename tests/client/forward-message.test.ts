import { afterEach, describe, expect, it } from 'vitest';
import { Packet, PacketType } from '@msgtrans/client';
import {
  MessageType,
  PrivchatClient,
  decodeSendMessageRequest,
  encodeAuthorizationResponse,
  encodePushMessageRequest,
  encodeSendMessageResponse,
  type PushMessageRequest,
} from '../../src/index.js';
import { FakeTransport } from './fake-transport.js';

let client: PrivchatClient | null = null;
let dbCounter = 0;
afterEach(async () => {
  if (client) {
    try { await client.disconnect(); } catch { /* */ }
    client = null;
  }
});

const samplePush = (overrides: Partial<PushMessageRequest> = {}): PushMessageRequest => ({
  setting: { need_receipt: false, signal: 0 },
  msg_key: 'k',
  server_message_id: '700110001',
  message_seq: 100,
  local_message_id: '0',
  stream_no: '',
  stream_seq: 0,
  stream_flag: 0,
  timestamp: 1_700_000,
  channel_id: '12345',
  channel_type: 1,
  message_type: 0,
  expire: 0,
  topic: '',
  from_uid: '999',
  payload: new TextEncoder().encode('转发我这条'),
  deleted: false,
  ...overrides,
});

/** Auth + send-ack fake that captures outgoing SendMessageRequests. */
function sendCaptureFake(captured: Array<ReturnType<typeof decodeSendMessageRequest>>): FakeTransport {
  const t = new FakeTransport();
  t.responder = (pkt) => {
    if (pkt.bizType === 1) return encodeAuthorizationResponse({ success: true });
    if (pkt.bizType === 5) {
      const req = decodeSendMessageRequest(pkt.payload);
      captured.push(req);
      return encodeSendMessageResponse({
        reason_code: 0,
        message_id: String(800_000 + captured.length),
        message_seq: 10 + captured.length,
        expire: 0,
        server_timestamp: 1_700_001,
      });
    }
    return undefined;
  };
  return t;
}

const fireOneWay = (t: FakeTransport, bizType: number, payload: Uint8Array) => {
  t.fireMessage(new Packet({ packetType: PacketType.OneWay, messageId: 0, bizType, payload }));
};

describe('forwardMessage (Rust forward_message parity)', () => {
  it('re-sends a cached text message to the target channel as a fresh copy', async () => {
    const captured: Array<ReturnType<typeof decodeSendMessageRequest>> = [];
    const t = sendCaptureFake(captured);
    client = new PrivchatClient({
      transport: t,
      cache: { enabled: true, dbName: `fwd-${++dbCounter}` },
    });
    await client.connect();
    await client.authenticate('111', 'tok', 'dev');
    fireOneWay(t, MessageType.PushMessageRequest, encodePushMessageRequest(samplePush()));

    const result = await client.forwardMessage({
      source_channel_id: '12345',
      source_channel_type: 1,
      source_server_message_id: '700110001',
      target_channel_id: '67890',
      target_channel_type: 2,
      from_uid: '111',
    });

    // Cache-enabled text sends ride the outbox + sync engine ('queued' then
    // flushed via sync/submit); either terminal is a successful handoff.
    expect(['sent', 'queued']).toContain(result.status);
    // The forwarded copy lands in the TARGET conversation's local cache as a
    // fresh outgoing row with the source content.
    const targetRows = client.getCachedMessages('67890', 2);
    const copy = targetRows.find((m) => m.content === '转发我这条');
    expect(copy).toBeDefined();
    expect(copy!.message_type).toBe('text');
    expect(copy!.from_uid).toBe('111');
  });

  it('rejects forwarding a revoked message', async () => {
    const captured: Array<ReturnType<typeof decodeSendMessageRequest>> = [];
    const t = sendCaptureFake(captured);
    client = new PrivchatClient({
      transport: t,
      cache: { enabled: true, dbName: `fwd-${++dbCounter}` },
    });
    await client.connect();
    await client.authenticate('111', 'tok', 'dev');
    fireOneWay(t, MessageType.PushMessageRequest, encodePushMessageRequest(samplePush({ deleted: true })));

    await expect(
      client.forwardMessage({
        source_channel_id: '12345',
        source_channel_type: 1,
        source_server_message_id: '700110001',
        target_channel_id: '67890',
        target_channel_type: 2,
        from_uid: '111',
      }),
    ).rejects.toThrow(/revoked/);
    expect(captured).toHaveLength(0);
  });

  it('reuses the raw envelope payload verbatim for media rows', async () => {
    const captured: Array<ReturnType<typeof decodeSendMessageRequest>> = [];
    const t = sendCaptureFake(captured);
    client = new PrivchatClient({
      transport: t,
      cache: { enabled: true, dbName: `fwd-${++dbCounter}` },
    });
    await client.connect();
    await client.authenticate('111', 'tok', 'dev');
    // an image push whose payload is a (stand-in) envelope byte blob
    const mediaPayload = Uint8Array.from([9, 9, 9, 1, 2, 3, 4]);
    fireOneWay(
      t,
      MessageType.PushMessageRequest,
      encodePushMessageRequest(samplePush({ message_type: 2, payload: mediaPayload, server_message_id: '700110002' })),
    );

    await client.forwardMessage({
      source_channel_id: '12345',
      source_channel_type: 1,
      source_server_message_id: '700110002',
      target_channel_id: '67890',
      target_channel_type: 2,
      from_uid: '111',
    });

    expect(captured).toHaveLength(1);
    expect(captured[0]!.message_type).toBe(2);
    expect(Array.from(captured[0]!.payload)).toEqual(Array.from(mediaPayload));
  });

  it('rejects an uncached source', async () => {
    const t = sendCaptureFake([]);
    client = new PrivchatClient({
      transport: t,
      cache: { enabled: true, dbName: `fwd-${++dbCounter}` },
    });
    await client.connect();
    await client.authenticate('111', 'tok', 'dev');
    await expect(
      client.forwardMessage({
        source_channel_id: '12345',
        source_channel_type: 1,
        source_server_message_id: '404',
        target_channel_id: '67890',
        target_channel_type: 2,
        from_uid: '111',
      }),
    ).rejects.toThrow(/not cached/);
  });
});
