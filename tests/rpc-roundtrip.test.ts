import { describe, expect, it } from 'vitest';
import {
  decodeRpcRequest,
  decodeRpcResponse,
  encodeRpcRequest,
  encodeRpcResponse,
} from '../src/index.js';

describe('RpcRequest', () => {
  it('round-trips a JSON body verbatim', () => {
    const body = new TextEncoder().encode('{"channel_id":"123","limit":20}');
    const msg = { route: '/v1/messages.list', body };
    const got = decodeRpcRequest(encodeRpcRequest(msg));
    expect(got.route).toBe(msg.route);
    expect(got.body).toEqual(body);
  });

  it('round-trips an empty body', () => {
    const msg = { route: '/v1/ping', body: new Uint8Array(0) };
    const got = decodeRpcRequest(encodeRpcRequest(msg));
    expect(got.route).toBe(msg.route);
    expect(got.body).toEqual(new Uint8Array(0));
  });

  it('treats body as opaque bytes (no UTF-8 assumption)', () => {
    const body = new Uint8Array([0x00, 0xff, 0x7f, 0x80, 0x01]);
    const msg = { route: '/v1/binary', body };
    const got = decodeRpcRequest(encodeRpcRequest(msg));
    expect(got.body).toEqual(body);
  });
});

describe('RpcResponse', () => {
  it('round-trips success with JSON data', () => {
    const data = new TextEncoder().encode('{"ok":true}');
    const msg = { code: 0, message: 'ok', data };
    const got = decodeRpcResponse(encodeRpcResponse(msg));
    expect(got.code).toBe(0);
    expect(got.message).toBe('ok');
    expect(got.data).toEqual(data);
  });

  it('decodes empty data vector as undefined (None on the wire)', () => {
    const msg = { code: 0, message: '' };
    const got = decodeRpcResponse(encodeRpcResponse(msg));
    expect(got.code).toBe(0);
    expect(got.message).toBe('');
    expect(got.data).toBeUndefined();
  });

  it('round-trips an error response', () => {
    const msg = { code: 401, message: 'unauthorized' };
    const got = decodeRpcResponse(encodeRpcResponse(msg));
    expect(got.code).toBe(401);
    expect(got.message).toBe('unauthorized');
    expect(got.data).toBeUndefined();
  });
});
