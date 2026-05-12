// Layer-1 protocol facade: typed request/response over msgtrans.

import { describe, expect, it } from 'vitest';
import { PacketType } from '@msgtrans/client';
import {
  AuthorizationError,
  MessageType,
  PrivchatClient,
  RpcError,
  SubscribeAction,
  SubscribeError,
  decodeAuthorizationRequest,
  decodePingRequest,
  decodeRpcRequest,
  decodeSendMessageRequest,
  decodeSubscribeRequest,
  encodeAuthorizationResponse,
  encodePongResponse,
  encodeRpcResponse,
  encodeSendMessageResponse,
  encodeSubscribeResponse,
  type AuthorizationRequest,
  type SendMessageRequest,
  type SubscribeRequest,
} from '../../src/index.js';
import { FakeTransport } from './fake-transport.js';

const baseAuth: AuthorizationRequest = {
  auth_type: 'jwt',
  auth_token: 'tok',
  client_info: { client_type: 'web', version: '0.1.0', os: 'macos', os_version: '15' },
  device_info: { device_id: 'd1', device_type: 'web', app_id: 'a1', device_name: 'n' },
  protocol_version: '1.0',
  properties: {},
};

const baseSend: SendMessageRequest = {
  setting: { need_receipt: false, signal: 0 },
  client_seq: 1,
  local_message_id: '900710001',
  stream_no: '',
  channel_id: '12345',
  message_type: 0,
  expire: 0,
  from_uid: '999',
  topic: '',
  payload: new TextEncoder().encode('hi'),
};

const baseSub: SubscribeRequest = {
  setting: 0,
  local_message_id: '0',
  channel_id: '12345',
  channel_type: 1,
  action: SubscribeAction.Subscribe,
  param: '',
};

describe('PrivchatClient layer-1 protocol facade', () => {
  it('authorize encodes AuthorizationRequest, decodes AuthorizationResponse', async () => {
    const t = new FakeTransport();
    t.responder = (pkt) => {
      // Server sees the request bytes and decodes them.
      const decoded = decodeAuthorizationRequest(pkt.payload);
      expect(decoded.auth_token).toBe('tok');
      expect(decoded.device_info.device_id).toBe('d1');
      return encodeAuthorizationResponse({
        success: true,
        session_id: 'sess-1',
        user_id: '900710001',
        heartbeat_interval: 30,
      });
    };
    t.responseBizTypeFor = () => MessageType.AuthorizationResponse;

    const client = new PrivchatClient({ transport: t });
    const resp = await client.authorize(baseAuth);

    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]!.bizType).toBe(MessageType.AuthorizationRequest);
    expect(t.sent[0]!.packetType).toBe(PacketType.Request);
    expect(resp.success).toBe(true);
    expect(resp.session_id).toBe('sess-1');
    expect(resp.user_id).toBe('900710001');
  });

  it('sendMessage round-trips request and response', async () => {
    const t = new FakeTransport();
    t.responder = (pkt) => {
      const decoded = decodeSendMessageRequest(pkt.payload);
      expect(decoded.client_seq).toBe(1);
      expect(decoded.channel_id).toBe('12345');
      return encodeSendMessageResponse({
        client_seq: decoded.client_seq,
        server_message_id: '700110001',
        message_seq: 100,
        reason_code: 0,
      });
    };

    const client = new PrivchatClient({ transport: t });
    const resp = await client.sendMessage(baseSend);

    expect(t.sent[0]!.bizType).toBe(MessageType.SendMessageRequest);
    expect(resp.server_message_id).toBe('700110001');
    expect(resp.message_seq).toBe(100);
  });

  it('subscribe sends SubscribeRequest and parses SubscribeResponse', async () => {
    const t = new FakeTransport();
    t.responder = (pkt) => {
      const decoded = decodeSubscribeRequest(pkt.payload);
      expect(decoded.action).toBe(SubscribeAction.Subscribe);
      return encodeSubscribeResponse({
        local_message_id: decoded.local_message_id,
        channel_id: decoded.channel_id,
        channel_type: decoded.channel_type,
        action: decoded.action,
        reason_code: 0,
      });
    };

    const client = new PrivchatClient({ transport: t });
    const resp = await client.subscribe(baseSub);

    expect(t.sent[0]!.bizType).toBe(MessageType.SubscribeRequest);
    expect(resp.reason_code).toBe(0);
  });

  it('unsubscribe forces action=Unsubscribe regardless of req.action', async () => {
    const t = new FakeTransport();
    let observedAction = -1;
    t.responder = (pkt) => {
      const decoded = decodeSubscribeRequest(pkt.payload);
      observedAction = decoded.action;
      return encodeSubscribeResponse({
        local_message_id: decoded.local_message_id,
        channel_id: decoded.channel_id,
        channel_type: decoded.channel_type,
        action: decoded.action,
        reason_code: 0,
      });
    };

    const client = new PrivchatClient({ transport: t });
    await client.unsubscribe({ ...baseSub, action: SubscribeAction.Subscribe });

    expect(observedAction).toBe(SubscribeAction.Unsubscribe);
  });

  it('rpc keeps body bytes opaque', async () => {
    const t = new FakeTransport();
    const opaque = new Uint8Array([0x00, 0xff, 0x7f]);
    t.responder = (pkt) => {
      const decoded = decodeRpcRequest(pkt.payload);
      expect(decoded.route).toBe('/v1/test');
      expect(decoded.body).toEqual(opaque);
      return encodeRpcResponse({ code: 0, message: 'ok', data: opaque });
    };

    const client = new PrivchatClient({ transport: t });
    const resp = await client.rpc({ route: '/v1/test', body: opaque });

    expect(t.sent[0]!.bizType).toBe(MessageType.RpcRequest);
    expect(resp.code).toBe(0);
    expect(resp.data).toEqual(opaque);
  });

  it('ping uses Date.now() default and decodes PongResponse', async () => {
    const t = new FakeTransport();
    let observedTimestamp = -1;
    t.responder = (pkt) => {
      observedTimestamp = decodePingRequest(pkt.payload).timestamp;
      return encodePongResponse({ timestamp: 999 });
    };

    const before = Date.now();
    const client = new PrivchatClient({ transport: t });
    const resp = await client.ping();
    const after = Date.now();

    expect(t.sent[0]!.bizType).toBe(MessageType.PingRequest);
    expect(observedTimestamp).toBeGreaterThanOrEqual(before);
    expect(observedTimestamp).toBeLessThanOrEqual(after);
    expect(resp.timestamp).toBe(999);
  });

  it('ping accepts an explicit PingRequest', async () => {
    const t = new FakeTransport();
    t.responder = (pkt) => {
      expect(decodePingRequest(pkt.payload).timestamp).toBe(42);
      return encodePongResponse({ timestamp: 43 });
    };
    const client = new PrivchatClient({ transport: t });
    const resp = await client.ping({ timestamp: 42 });
    expect(resp.timestamp).toBe(43);
  });
});

describe('PrivchatClient lifecycle pass-through', () => {
  it('connect / disconnect / isConnected delegate to the transport', async () => {
    const t = new FakeTransport();
    const client = new PrivchatClient({ transport: t });
    expect(client.isConnected()).toBe(false);
    await client.connect();
    expect(client.isConnected()).toBe(true);
    await client.disconnect();
    expect(client.isConnected()).toBe(false);
  });
});

// These error classes are exported but exercised more thoroughly in
// convenience.test.ts. A smoke check here keeps imports honest.
describe('error class smoke', () => {
  it('AuthorizationError carries the response', () => {
    const e = new AuthorizationError({ success: false, error_code: 401, error_message: 'x' });
    expect(e.message).toBe('[401] x');
    expect(e.response.success).toBe(false);
  });
  it('SubscribeError carries action + response', () => {
    const e = new SubscribeError('subscribe', {
      local_message_id: '0',
      channel_id: '0',
      channel_type: 0,
      action: 1,
      reason_code: 9,
    });
    expect(e.action).toBe('subscribe');
    expect(e.response.reason_code).toBe(9);
  });
  it('RpcError carries route + response', () => {
    const e = new RpcError('/x', { code: 5, message: 'fail' });
    expect(e.route).toBe('/x');
    expect(e.response.code).toBe(5);
  });
});
