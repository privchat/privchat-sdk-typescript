import { describe, expect, it } from 'vitest';
import {
  encodeAuthorizationResponse,
  PrivchatClient,
} from '../../src/index.js';
import { FakeTransport } from './fake-transport.js';

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
    await client.connect();
    await client.authenticate('900710001', 'TOKEN', 'dev-1');

    expect(client.connectionState()).toBe('authenticated');
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
    expect(client.currentAccessToken()).toBeNull();
    expect(client.sessionSnapshot().has_access_token).toBe(false);
  });
});
