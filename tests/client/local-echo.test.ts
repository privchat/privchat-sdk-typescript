import { afterEach, describe, expect, it } from 'vitest';
import { Packet, PacketType } from '@msgtrans/client';
import {
  MessageType,
  PrivchatClient,
  decodeRpcRequest,
  decodeMessagePayloadEnvelope,
  decodeSendMessageRequest,
  encodeAuthorizationResponse,
  encodeRpcResponse,
  encodePushMessageRequest,
  encodeSendMessageResponse,
  type ConversationPatch,
} from '../../src/index.js';
import { getOutboxByLocalMessageId } from '../../src/cache/index.js';
import { FakeTransport } from './fake-transport.js';

let client: PrivchatClient | null = null;
let dbCounter = 0;
afterEach(async () => {
  if (client) {
    try { await client.disconnect(); } catch { /* */ }
    client = null;
  }
});

const okJson = (data: unknown) =>
  encodeRpcResponse({
    code: 0,
    message: 'ok',
    data: new TextEncoder().encode(JSON.stringify(data)),
  });

/**
 * FakeTransport that handles authorize + send. bizType=1 = AuthorizationRequest,
 * bizType=5 = SendMessageRequest, bizType=17 = RpcRequest.
 */
function authPlusSendFake(
  build: (decoded: ReturnType<typeof decodeSendMessageRequest>) => Uint8Array | undefined,
): FakeTransport {
  const t = new FakeTransport();
  t.responder = (pkt) => {
    if (pkt.bizType === 1 /* AuthorizationRequest */) {
      return encodeAuthorizationResponse({ success: true });
    }
    if (pkt.bizType === 5 /* SendMessageRequest */) {
      return build(decodeSendMessageRequest(pkt.payload));
    }
    if (pkt.bizType === 17 /* RpcRequest */) {
      decodeRpcRequest(pkt.payload);
      return okJson({});
    }
    return undefined;
  };
  return t;
}

/** Construct cache-enabled client + connect + authenticate. */
async function newAuthedClient(transport: FakeTransport, dbName: string): Promise<PrivchatClient> {
  const c = new PrivchatClient({
    transport,
    cache: { enabled: true, dbName },
  });
  await c.connect();
  await c.authenticate('1', 'tok', 'dev');
  return c;
}

describe('sendTextMessage — cache-enabled, online happy path', () => {
  it('normalizes a legacy envelope before local echo and wire encoding', async () => {
    let wireContent = '';
    let wireReply: string | undefined;
    const t = authPlusSendFake((decoded) => {
      const envelope = decodeMessagePayloadEnvelope(decoded.payload);
      wireContent = envelope.content;
      wireReply = envelope.reply_to_message_id;
      return encodeSendMessageResponse({
        client_seq: decoded.client_seq,
        server_message_id: '700110000',
        message_seq: 99,
        reason_code: 0,
      });
    });
    client = await newAuthedClient(t, `legacy-envelope-${++dbCounter}`);

    await client.sendTextMessage({
      channel_id: '12345',
      channel_type: 1,
      from_uid: '999',
      content: JSON.stringify({
        content: '正文',
        mentioned_user_ids: [],
        reply_to_message_id: '600997771041832960',
      }),
      local_message_id: '9007199254740991',
    });

    expect(wireContent).toBe('正文');
    expect(wireReply).toBe('600997771041832960');
    expect(client.getCachedMessages('12345', 1)[0]?.content).toBe('正文');
  });

  it('emits pending immediately, returns sent, replaces local-echo with ACK', async () => {
    const t = authPlusSendFake((decoded) =>
      encodeSendMessageResponse({
        client_seq: decoded.client_seq,
        server_message_id: '700110001',
        message_seq: 100,
        reason_code: 0,
      }),
    );
    client = await newAuthedClient(t, `echo-${++dbCounter}`);

    const patches: ConversationPatch[] = [];
    client.observeConversation('12345', 1, (_, p) => patches.push(p));

    const promise = client.sendTextMessage({
      channel_id: '12345',
      channel_type: 1,
      from_uid: '999',
      content: 'hello',
      local_message_id: '9007199254740992',
    });

    // First patch: synchronous pending insert.
    expect(patches).toHaveLength(1);
    expect(patches[0]!.upserted[0]!.status).toBe('pending');
    expect(patches[0]!.upserted[0]!.local_message_id).toBe('9007199254740992');
    expect(patches[0]!.upserted[0]!.server_message_id).toBeUndefined();

    const result = await promise;
    expect(result.status).toBe('sent');
    expect(result.local_message_id).toBe('9007199254740992');
    if (result.status === 'sent') {
      expect(result.response.server_message_id).toBe('700110001');
      expect(result.response.message_seq).toBe(100);
      expect(result.response.reason_code).toBe(0);
    }

    // ACK patch: pending row removed, sent row upserted.
    expect(patches).toHaveLength(2);
    expect(patches[1]!.removed).toEqual(['l:9007199254740992']);
    expect(patches[1]!.upserted[0]!.server_message_id).toBe('700110001');
    expect(patches[1]!.upserted[0]!.status).toBe('sent');

    // Cache shows only the acked record.
    const cached = client.getCachedMessages('12345', 1);
    expect(cached).toHaveLength(1);
    expect(cached[0]!.status).toBe('sent');
  });

  it('auto-generates local_message_id when caller omits it', async () => {
    const t = authPlusSendFake((decoded) =>
      encodeSendMessageResponse({
        client_seq: decoded.client_seq,
        server_message_id: '999',
        message_seq: 1,
        reason_code: 0,
      }),
    );
    client = await newAuthedClient(t, `auto-id-${++dbCounter}`);

    const patches: ConversationPatch[] = [];
    client.observeConversation('12345', 1, (_, p) => patches.push(p));

    const result = await client.sendTextMessage({
      channel_id: '12345',
      channel_type: 1,
      from_uid: '999',
      content: 'hi',
    });
    expect(result.status).toBe('sent');
    expect(result.local_message_id).toMatch(/^\d+$/);
    expect(result.local_message_id).not.toBe('0');
    expect(patches[0]!.upserted[0]!.local_message_id).toBe(result.local_message_id);
  });

  it('keeps local text visible when self-push arrives before send ACK', async () => {
    let sentLocalId = '';
    const t = authPlusSendFake((decoded) => {
      sentLocalId = decoded.local_message_id;
      return undefined; // hold the ACK so self-push wins the race
    });
    client = await newAuthedClient(t, `push-before-ack-${++dbCounter}`);

    const snapshots: string[][] = [];
    client.observeConversation('12345', 1, (snapshot) => {
      snapshots.push(snapshot.messages.map((m) => m.content));
    });

    const sendPromise = client.sendTextMessage({
      channel_id: '12345',
      channel_type: 1,
      from_uid: '1',
      content: '发送后立即可见',
      local_message_id: '9007199254740993',
    });
    expect(snapshots.at(-1)).toEqual(['发送后立即可见']);

    t.fireMessage(new Packet({
      packetType: PacketType.OneWay,
      messageId: 0,
      bizType: MessageType.PushMessageRequest,
      payload: encodePushMessageRequest({
        setting: { need_receipt: false, signal: 0 },
        msg_key: 'self-push',
        server_message_id: '700110003',
        message_seq: 102,
        local_message_id: sentLocalId,
        stream_no: '',
        stream_seq: 0,
        stream_flag: 0,
        timestamp: Math.floor(Date.now() / 1000),
        channel_id: '12345',
        channel_type: 1,
        message_type: 0,
        expire: 0,
        topic: '',
        from_uid: '1',
        payload: new Uint8Array(),
        deleted: false,
      }),
    }));

    const afterPush = client.getCachedMessages('12345', 1);
    expect(afterPush).toHaveLength(1);
    expect(afterPush[0]).toMatchObject({
      server_message_id: '700110003',
      local_message_id: '9007199254740993',
      content: '发送后立即可见',
      status: 'sent',
    });
    expect(snapshots.at(-1)).toEqual(['发送后立即可见']);

    const request = [...t.sent].reverse().find((pkt) => pkt.bizType === 5)!;
    t.fireMessage(new Packet({
      packetType: PacketType.Response,
      messageId: request.messageId,
      bizType: 5,
      payload: encodeSendMessageResponse({
        client_seq: 0,
        server_message_id: '700110003',
        message_seq: 102,
        reason_code: 0,
      }),
    }));
    await sendPromise;

    expect(client.getCachedMessages('12345', 1)).toHaveLength(1);
    expect(client.getCachedMessages('12345', 1)[0]!.content).toBe('发送后立即可见');
    expect(snapshots.every((items) => items.every((text) => text !== ''))).toBe(true);
  });
});

describe('sendTextMessage — cache-disabled (Phase 2 strict semantics preserved)', () => {
  it('returns sent and bypasses outbox / local-echo', async () => {
    const t = authPlusSendFake((decoded) =>
      encodeSendMessageResponse({
        client_seq: decoded.client_seq,
        server_message_id: '700',
        message_seq: 100,
        reason_code: 0,
      }),
    );
    // No cache opt-in. Layer-1 sendMessage runs without auth gating
    // (TransportClient handles raw send), so we don't need to authenticate.
    client = new PrivchatClient({ transport: t });
    const result = await client.sendTextMessage({
      channel_id: '12345',
      channel_type: 1,
      from_uid: '999',
      content: 'hi',
    });
    expect(result.status).toBe('sent');
    if (result.status === 'sent') {
      expect(result.response.server_message_id).toBe('700');
      expect(result.response.message_seq).toBe(100);
    }
    expect(client.isCacheEnabled()).toBe(false);
  });
});
