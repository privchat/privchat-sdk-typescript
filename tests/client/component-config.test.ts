import { expect, it } from 'vitest';
import { decodeRpcRequest, encodeRpcResponse, PrivchatClient } from '../../src/index.js';
import { FakeTransport } from './fake-transport.js';

it('reads config/get over the existing authenticated RPC transport', async () => {
  const t = new FakeTransport();
  const view = { schemaVersion: 1, revision: 'opaque-view', maxAgeSeconds: 300,
    components: { rtc: { schemaVersion: 1, enabled: true, livekitUrl: 'wss://rtc.example.invalid',
      peerEnabled: true, allowTurn: false } } };
  t.responder = (pkt) => {
    const r = decodeRpcRequest(pkt.payload);
    expect(r.route).toBe('config/get');
    expect(JSON.parse(new TextDecoder().decode(r.body))).toEqual({});
    return encodeRpcResponse({ code: 0, message: 'OK', data: new TextEncoder().encode(JSON.stringify(view)) });
  };
  const c = new PrivchatClient({ transport: t });
  await c.connect();
  expect(await c.getComponentConfig()).toEqual(view);
  await c.disconnect();
});
