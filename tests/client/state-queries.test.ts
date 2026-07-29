import { describe, expect, it } from 'vitest';
import {
  decodeRpcRequest,
  encodeAuthorizationResponse,
  encodeRpcResponse,
  PrivchatClient,
} from '../../src/index.js';
import { FakeTransport } from './fake-transport.js';
import { uniqueDbName } from './unique-db.js';

describe('connectionState() / sessionSnapshot() / currentAccessToken()', () => {
  it('initial state is disconnected with no auth', () => {
    const t = new FakeTransport();
    const client = new PrivchatClient({ transport: t });
    expect(client.connectionState()).toBe('disconnected');
    expect(client.currentAccessToken()).toBeNull();
    expect(client.sessionSnapshot()).toEqual({
      user_id: undefined,
      device_id: undefined,
      connection_state: 'disconnected',
      has_access_token: false,
      last_event_sequence_id: 0,
    });
  });

  it('captures uid / deviceId / token after authenticate', async () => {
    const t = new FakeTransport();
    t.responder = () => encodeAuthorizationResponse({ success: true });
    const client = new PrivchatClient({ transport: t });
    const readiness: string[] = [];
    client.onSyncReadinessChanged((event) => readiness.push(event.readiness));
    await client.connect();
    await client.authenticate('900710001', 'TOKEN', 'dev-1');

    expect(client.connectionState()).toBe('authenticated');
    expect(client.syncReadiness()).toBe('ready');
    expect(readiness).toEqual(['authenticated', 'ready']);
    expect(client.currentAccessToken()).toBe('TOKEN');
    const snap = client.sessionSnapshot();
    expect(snap.user_id).toBe('900710001');
    expect(snap.device_id).toBe('dev-1');
    expect(snap.has_access_token).toBe(true);
    expect(snap.connection_state).toBe('authenticated');
  });

  it('clears auth state on disconnect', async () => {
    const t = new FakeTransport();
    t.responder = () => encodeAuthorizationResponse({ success: true });
    const client = new PrivchatClient({ transport: t });
    await client.connect();
    await client.authenticate('1', 't', 'd');
    await client.disconnect();
    expect(client.connectionState()).toBe('disconnected');
    expect(client.syncReadiness()).toBe('disconnected');
    expect(client.currentAccessToken()).toBeNull();
    expect(client.sessionSnapshot().has_access_token).toBe(false);
  });

  it('returns after auth, then reaches ready through constant entity sync without channel diffs', async () => {
    const t = new FakeTransport();
    const routes: string[] = [];
    let firstRequest = true;
    t.responder = (packet) => {
      if (firstRequest) {
        firstRequest = false;
        return encodeAuthorizationResponse({ success: true });
      }
      const rpc = decodeRpcRequest(packet.payload);
      routes.push(rpc.route);
      return encodeRpcResponse({
        code: 0,
        message: 'ok',
        data: new TextEncoder().encode(JSON.stringify({
          items: [],
          next_version: 0,
          has_more: false,
        })),
      });
    };
    const client = new PrivchatClient({
      transport: t,
      cache: { enabled: true, dbName: uniqueDbName('readiness') },
    });
    const ready = new Promise<void>((resolve) => {
      client.onSyncReadinessChanged((event) => {
        if (event.readiness === 'ready') resolve();
      });
    });

    await client.connect();
    await client.authenticate('42', 'token', 'device');
    expect(client.connectionState()).toBe('authenticated');
    expect(client.syncReadiness()).toBe('syncing_critical');

    await ready;
    expect(client.syncReadiness()).toBe('ready');
    expect(routes).toHaveLength(5);
    expect(new Set(routes)).toEqual(new Set(['entity/sync_entities']));
    await client.dispose();
  });
});
