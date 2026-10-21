import { afterEach, describe, expect, it, vi } from 'vitest';
import { Packet, PacketType, type ConnectOptions, type TransportObserver } from '@msgtrans/client';
import {
  encodeAuthorizationResponse, encodeRpcRequest, encodeRpcResponse, MessageType, PrivchatClient,
  type RpcNotificationReceivedEvent,
} from '../../src/index.js';
import { FakeTransport } from './fake-transport.js';

// Retain the physical connection's observer even after unsubscribe, so tests
// exercise TransportClient's real retired-session fence, not the fake's open flag.
class LateTransport extends FakeTransport {
  readonly observers: TransportObserver[] = [];
  override async connect(options: ConnectOptions) {
    const session = await super.connect(options);
    const subscribe = session.subscribe.bind(session);
    vi.spyOn(session, 'subscribe').mockImplementation((observer) => {
      this.observers.push(observer);
      return subscribe(observer);
    });
    return session;
  }
}

const clients: PrivchatClient[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.dispose()));
  vi.restoreAllMocks();
});

function setup() {
  const transport = new LateTransport();
  transport.responder = () => encodeAuthorizationResponse({ success: true });
  const client = new PrivchatClient({ transport, reconnect: { enabled: false }, heartbeat: { enabled: false } });
  clients.push(client);
  const events: RpcNotificationReceivedEvent[] = [];
  client.observeEvents(({ event }) => {
    if (event.type === 'rpc_notification_received') events.push(event);
  });
  return { transport, client, events };
}

function packet(route = 'call/state', body = new TextEncoder().encode('{"call_id":"18446744073709551615"}')) {
  return new Packet({ packetType: PacketType.OneWay, messageId: 0,
    bizType: MessageType.RpcRequest, payload: encodeRpcRequest({ route, body }) });
}

describe('authenticated one-way RPC notifications', () => {
  it('bounds UTF-8 routes and bodies, and rejects whitespace/control routes', async () => {
    const { transport, client, events } = setup();
    await client.connect();
    await client.authenticate('1', 'token', 'device');
    transport.fireMessage(packet('é'.repeat(128), new Uint8Array(256 * 1024)));
    expect(events).toHaveLength(1);
    for (const route of ['x'.repeat(257), 'é'.repeat(129), 'call/ state', 'call/\tstate',
      'call/\nstate', 'call/\u0000state', 'call/\u007fstate', 'call/\u0085state', 'call/\u2003state']) {
      transport.fireMessage(packet(route));
    }
    transport.fireMessage(packet('call/state', new Uint8Array(256 * 1024 + 1)));
    expect(events).toHaveLength(1);
  });

  it('checks envelope size before accessing the FlatBuffers root', async () => {
    const { transport, client, events } = setup();
    await client.connect();
    await client.authenticate('1', 'token', 'device');
    // A valid root plus padding would decode if the predecode bound were missing.
    const padded = new Uint8Array(256 * 1024 + 1025);
    padded.set(packet().payload);
    transport.fireMessage(new Packet({ packetType: PacketType.OneWay, messageId: 0,
      bizType: MessageType.RpcRequest, payload: padded }));
    expect(events).toHaveLength(0);
    transport.fireMessage(packet());
    expect(events).toHaveLength(1);
  });

  it('keeps matching RPC responses out of notification dispatch', async () => {
    const { transport, client, events } = setup();
    await client.connect();
    await client.authenticate('1', 'token', 'device');
    transport.responder = () => encodeRpcResponse({ code: 0, message: 'ok', data: new Uint8Array([42]) });
    const response = await client.rpc({ route: 'call/state', body: new Uint8Array() });
    expect(response).toEqual({ code: 0, message: 'ok', data: new Uint8Array([42]) });
    expect(events).toHaveLength(0);
  });

  it('dispatches the existing biz17 codec through real transport inbound without a reply', async () => {
    const { transport, client, events } = setup();
    await client.connect();
    await client.authenticate('1', 'secret-token', 'device');
    const sent = transport.sent.length;
    const incoming = packet();
    transport.fireMessage(incoming);
    transport.fireMessage(packet('custom/notification', new Uint8Array([0, 255, 128])));
    expect(events.map((event) => event.route)).toEqual(['call/state', 'custom/notification']);
    expect(new TextDecoder().decode(events[0]!.body)).toBe('{"call_id":"18446744073709551615"}');
    expect(events[1]!.body).toEqual(new Uint8Array([0, 255, 128]));
    incoming.payload.fill(0);
    expect(events[0]!.body[0]).toBe(123);
    expect(transport.sent).toHaveLength(sent);
  });

  it('drops notifications before login and during reauthentication, without replaying them', async () => {
    const { transport, client, events } = setup();
    await client.connect();
    transport.fireMessage(packet());
    transport.onSendHook = () => transport.fireMessage(packet());
    await client.authenticate('1', 'token', 'device');
    expect(events).toHaveLength(0);
    transport.fireMessage(packet());
    await client.authenticate('1', 'fresh-token', 'device');
    expect(events).toHaveLength(1);
    transport.fireMessage(packet());
    expect(events).toHaveLength(2);
  });

  it('does not dispatch after login rejection or account mismatch', async () => {
    const { transport, client, events } = setup();
    await client.connect();
    transport.responder = () => encodeAuthorizationResponse({ success: false, error_code: 10000 });
    await expect(client.authenticate('1', 'bad', 'device')).rejects.toThrow();
    transport.fireMessage(packet());
    transport.responder = () => encodeAuthorizationResponse({ success: true, user_id: '2' });
    await expect(client.authenticate('1', 'wrong-account', 'device')).rejects.toThrow();
    transport.fireMessage(packet());
    expect(events).toHaveLength(0);
  });

  it('fences late old-connection packets even after a new account logs in', async () => {
    const { transport, client, events } = setup();
    await client.connect();
    await client.authenticate('1', 'token', 'device');
    const oldObserver = transport.observers[0]!;
    await client.disconnect();
    oldObserver.onMessage?.(packet());
    await client.connect();
    transport.fireMessage(packet());
    await client.authenticate('2', 'other-token', 'device');
    oldObserver.onMessage?.(packet());
    expect(events).toHaveLength(0);
    transport.fireMessage(packet());
    expect(events).toHaveLength(1);
    await client.dispose();
    transport.observers[1]!.onMessage?.(packet());
    expect(events).toHaveLength(1);
  });

  it('ignores request-typed RPC and malformed envelopes without payload logging', async () => {
    const { transport, client, events } = setup();
    await client.connect();
    await client.authenticate('1', 'token', 'device');
    const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')];
    const sent = transport.sent.length;
    transport.fireMessage(new Packet({ packetType: PacketType.Request, messageId: 123,
      bizType: MessageType.RpcRequest, payload: packet().payload }));
    transport.fireMessage(new Packet({ packetType: PacketType.OneWay, messageId: 0,
      bizType: MessageType.RpcRequest, payload: new Uint8Array([255, 255, 255, 127]) }));
    transport.fireMessage(packet(''));
    expect(events).toHaveLength(0);
    transport.fireMessage(packet());
    expect(events).toHaveLength(1);
    expect(transport.sent).toHaveLength(sent);
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });
});
