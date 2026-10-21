import { afterEach, describe, expect, it } from 'vitest';
import { Packet, PacketType } from '@msgtrans/client';
import {
  encodeAuthorizationResponse, encodeTransferRequest, MessageType, PrivchatClient,
  type TransferReceivedEvent,
} from '../../src/index.js';
import { FakeTransport } from './fake-transport.js';

const clients: PrivchatClient[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.dispose()));
});

function setup() {
  const transport = new FakeTransport();
  transport.responder = () => encodeAuthorizationResponse({ success: true });
  const client = new PrivchatClient({ transport, reconnect: { enabled: false }, heartbeat: { enabled: false } });
  clients.push(client);
  const events: TransferReceivedEvent[] = [];
  client.observeEvents(({ event }) => {
    if (event.type === 'transfer_received') events.push(event);
  });
  return { transport, client, events };
}

function push(route = 'agent/node/execute', body = new Uint8Array([1, 2, 3]), channel = '18446744073709551615') {
  return new Packet({
    packetType: PacketType.OneWay, messageId: 0, bizType: MessageType.TransferRequest,
    payload: encodeTransferRequest({ request_id: '550e8400-e29b-41d4-a716-446655440000', channel_id: channel, route, body }),
  });
}

describe('server-pushed Channel Transfer', () => {
  it('emits transfer_received with u64-safe channel id after authentication', async () => {
    const { transport, client, events } = setup();
    await client.connect();
    transport.fireMessage(push());
    expect(events).toHaveLength(0);
    await client.authenticate('1', 'token', 'node-a');
    transport.fireMessage(push());
    expect(events).toEqual([{
      type: 'transfer_received',
      request_id: '550e8400-e29b-41d4-a716-446655440000',
      channel_id: '18446744073709551615',
      route: 'agent/node/execute',
      body: new Uint8Array([1, 2, 3]),
    }]);
  });

  it('drops oversized bodies and malformed routes', async () => {
    const { transport, client, events } = setup();
    await client.connect();
    await client.authenticate('1', 'token', 'node-a');
    transport.fireMessage(push('agent/node/execute', new Uint8Array(64 * 1024 + 1)));
    for (const route of ['', 'x'.repeat(257), 'agent/ node', 'agent/\nnode']) transport.fireMessage(push(route));
    transport.fireMessage(new Packet({ packetType: PacketType.OneWay, messageId: 0,
      bizType: MessageType.TransferRequest, payload: new Uint8Array([1, 2]) }));
    expect(events).toHaveLength(0);
    transport.fireMessage(push('agent/node/execute', new Uint8Array(64 * 1024)));
    expect(events).toHaveLength(1);
  });
});
