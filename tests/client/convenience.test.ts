// Layer-2 Rust-style convenience wrappers.

import { describe, expect, it } from 'vitest';
import {
  AuthorizationError,
  MessageType,
  PrivchatClient,
  RpcError,
  SubscribeAction,
  SubscribeError,
  decodeAuthorizationRequest,
  decodeRpcRequest,
  decodeSendMessageRequest,
  decodeSubscribeRequest,
  encodeAuthorizationResponse,
  encodeRpcResponse,
  encodeSendMessageResponse,
  encodeSubscribeResponse,
} from '../../src/index.js';
import { FakeTransport } from './fake-transport.js';

describe('authenticate', () => {
  it('builds AuthorizationRequest with default client/device info and properties', async () => {
    const t = new FakeTransport();
    let observed: ReturnType<typeof decodeAuthorizationRequest> | null = null;
    t.responder = (pkt) => {
      observed = decodeAuthorizationRequest(pkt.payload);
      return encodeAuthorizationResponse({
        success: true,
        user_id: '900710001',
        session_id: 'sess-1',
        heartbeat_interval: 30,
      });
    };

    const client = new PrivchatClient({ transport: t });
    const resp = await client.authenticate('900710001', 'tok', 'dev-1');

    expect(observed).not.toBeNull();
    expect(observed!.auth_type).toBe('jwt');
    expect(observed!.auth_token).toBe('tok');
    expect(observed!.device_info.device_id).toBe('dev-1');
    expect(observed!.protocol_version).toBe('1.0');
    expect(observed!.properties.user_id).toBe('900710001');
    expect(observed!.properties.client_timestamp).toMatch(/^\d+$/);
    expect(resp.success).toBe(true);
    expect(resp.session_id).toBe('sess-1');
  });

  it('throws AuthorizationError when server returns success=false', async () => {
    const t = new FakeTransport();
    t.responder = () =>
      encodeAuthorizationResponse({
        success: false,
        error_code: 401,
        error_message: 'invalid token',
      });

    const client = new PrivchatClient({ transport: t });
    await expect(client.authenticate('1', 'bad', 'd1')).rejects.toMatchObject({
      name: 'AuthorizationError',
      message: '[401] invalid token',
    });
  });

  it('respects defaultClientInfo / defaultDeviceInfo overrides', async () => {
    const t = new FakeTransport();
    let observed: ReturnType<typeof decodeAuthorizationRequest> | null = null;
    t.responder = (pkt) => {
      observed = decodeAuthorizationRequest(pkt.payload);
      return encodeAuthorizationResponse({ success: true });
    };

    const client = new PrivchatClient({
      transport: t,
      defaultClientInfo: {
        client_type: 'cli',
        version: '9.9.9',
        os: 'linux',
        os_version: '6.0',
      },
      defaultDeviceInfo: {
        device_type: 'linux',
        app_id: 'override-app',
        device_name: 'tty',
      },
    });
    await client.authenticate('1', 'tok', 'd1');

    expect(observed!.client_info.version).toBe('9.9.9');
    expect(observed!.client_info.os).toBe('linux');
    expect(observed!.device_info.app_id).toBe('override-app');
    expect(observed!.device_info.device_id).toBe('d1');
    expect(observed!.device_info.device_type).toBe('linux');
  });
});

describe('subscribeChannel / unsubscribeChannel', () => {
  it('subscribeChannel sends action=Subscribe with token in param', async () => {
    const t = new FakeTransport();
    let observed: ReturnType<typeof decodeSubscribeRequest> | null = null;
    t.responder = (pkt) => {
      observed = decodeSubscribeRequest(pkt.payload);
      return encodeSubscribeResponse({
        local_message_id: '0',
        channel_id: observed.channel_id,
        channel_type: observed.channel_type,
        action: observed.action,
        reason_code: 0,
      });
    };

    const client = new PrivchatClient({ transport: t });
    await client.subscribeChannel('12345', 1, 'token-abc');

    expect(observed!.action).toBe(SubscribeAction.Subscribe);
    expect(observed!.channel_id).toBe('12345');
    expect(observed!.channel_type).toBe(1);
    expect(observed!.param).toBe('token-abc');
  });

  it('subscribeChannel works without token (param empty)', async () => {
    const t = new FakeTransport();
    let observed: ReturnType<typeof decodeSubscribeRequest> | null = null;
    t.responder = (pkt) => {
      observed = decodeSubscribeRequest(pkt.payload);
      return encodeSubscribeResponse({
        local_message_id: '0',
        channel_id: observed.channel_id,
        channel_type: observed.channel_type,
        action: observed.action,
        reason_code: 0,
      });
    };
    await new PrivchatClient({ transport: t }).subscribeChannel('1', 1);
    expect(observed!.param).toBe('');
  });

  it('unsubscribeChannel sends action=Unsubscribe', async () => {
    const t = new FakeTransport();
    let observed: ReturnType<typeof decodeSubscribeRequest> | null = null;
    t.responder = (pkt) => {
      observed = decodeSubscribeRequest(pkt.payload);
      return encodeSubscribeResponse({
        local_message_id: '0',
        channel_id: observed.channel_id,
        channel_type: observed.channel_type,
        action: observed.action,
        reason_code: 0,
      });
    };
    await new PrivchatClient({ transport: t }).unsubscribeChannel('12345', 1);
    expect(observed!.action).toBe(SubscribeAction.Unsubscribe);
  });

  it('throws SubscribeError on non-zero reason_code', async () => {
    const t = new FakeTransport();
    t.responder = () =>
      encodeSubscribeResponse({
        local_message_id: '0',
        channel_id: '1',
        channel_type: 1,
        action: SubscribeAction.Subscribe,
        reason_code: 7,
      });

    const client = new PrivchatClient({ transport: t });
    await expect(client.subscribeChannel('1', 1)).rejects.toBeInstanceOf(SubscribeError);
  });
});

describe('rpcCall / rpcCallTyped', () => {
  it('rpcCall encodes UTF-8 body, decodes UTF-8 response', async () => {
    const t = new FakeTransport();
    t.responder = (pkt) => {
      const decoded = decodeRpcRequest(pkt.payload);
      expect(decoded.route).toBe('/v1/echo');
      expect(new TextDecoder().decode(decoded.body)).toBe('{"x":1}');
      return encodeRpcResponse({
        code: 0,
        message: 'ok',
        data: new TextEncoder().encode('{"y":2}'),
      });
    };

    const client = new PrivchatClient({ transport: t });
    const out = await client.rpcCall('/v1/echo', '{"x":1}');
    expect(out).toBe('{"y":2}');
  });

  it('rpcCall returns "" when server response data is absent', async () => {
    const t = new FakeTransport();
    t.responder = () => encodeRpcResponse({ code: 0, message: 'ok' });

    const client = new PrivchatClient({ transport: t });
    expect(await client.rpcCall('/v1/empty', '')).toBe('');
  });

  it('rpcCall throws RpcError on non-zero code', async () => {
    const t = new FakeTransport();
    t.responder = () => encodeRpcResponse({ code: 401, message: 'unauthorized' });

    const client = new PrivchatClient({ transport: t });
    await expect(client.rpcCall('/v1/x', '{}')).rejects.toMatchObject({
      name: 'RpcError',
      route: '/v1/x',
    });
  });

  it('rpcCallTyped JSON-serialises req and parses resp', async () => {
    const t = new FakeTransport();
    t.responder = (pkt) => {
      const decoded = decodeRpcRequest(pkt.payload);
      const body = JSON.parse(new TextDecoder().decode(decoded.body)) as { n: number };
      const out = { doubled: body.n * 2 };
      return encodeRpcResponse({
        code: 0,
        message: 'ok',
        data: new TextEncoder().encode(JSON.stringify(out)),
      });
    };

    const client = new PrivchatClient({ transport: t });
    const resp = await client.rpcCallTyped<{ n: number }, { doubled: number }>(
      '/v1/double',
      { n: 21 },
    );
    expect(resp.doubled).toBe(42);
  });
});

describe('sendTextMessage', () => {
  it('builds SendMessageRequest with text payload + auto local_message_id', async () => {
    const t = new FakeTransport();
    let observed: ReturnType<typeof decodeSendMessageRequest> | null = null;
    t.responder = (pkt) => {
      observed = decodeSendMessageRequest(pkt.payload);
      return encodeSendMessageResponse({
        client_seq: observed.client_seq,
        server_message_id: '700110001',
        message_seq: 100,
        reason_code: 0,
      });
    };

    const client = new PrivchatClient({ transport: t });
    const resp = await client.sendTextMessage({
      channel_id: '12345',
      channel_type: 1,
      from_uid: '999',
      content: 'hi',
    });

    expect(t.sent[0]!.bizType).toBe(MessageType.SendMessageRequest);
    expect(observed!.channel_id).toBe('12345');
    expect(observed!.from_uid).toBe('999');
    expect(observed!.message_type).toBe(0);
    expect(new TextDecoder().decode(observed!.payload)).toBe('hi');
    expect(observed!.local_message_id).toMatch(/^\d+$/);
    expect(observed!.local_message_id).not.toBe('0');
    expect(resp.status).toBe('sent');
    if (resp.status === 'sent') {
      expect(resp.response.server_message_id).toBe('700110001');
    }
  });

  it('respects explicit local_message_id / client_seq / message_type', async () => {
    const t = new FakeTransport();
    let observed: ReturnType<typeof decodeSendMessageRequest> | null = null;
    t.responder = (pkt) => {
      observed = decodeSendMessageRequest(pkt.payload);
      return encodeSendMessageResponse({
        client_seq: observed.client_seq,
        server_message_id: '0',
        message_seq: 0,
        reason_code: 0,
      });
    };

    await new PrivchatClient({ transport: t }).sendTextMessage({
      channel_id: '1',
      channel_type: 1,
      from_uid: '1',
      content: 'hello',
      local_message_id: '42',
      client_seq: 7,
      message_type: 9,
    });

    expect(observed!.local_message_id).toBe('42');
    expect(observed!.client_seq).toBe(7);
    expect(observed!.message_type).toBe(9);
  });
});

describe('AuthorizationError formatting', () => {
  it('falls back when error_code/error_message are missing', () => {
    const t = new FakeTransport();
    t.responder = () => encodeAuthorizationResponse({ success: false });
    const client = new PrivchatClient({ transport: t });
    return expect(client.authenticate('1', 't', 'd')).rejects.toMatchObject({
      message: '[0] authorization failed',
    });
  });
});
