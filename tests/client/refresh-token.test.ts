import { describe, expect, it } from 'vitest';
import {
  decodeRpcRequest,
  encodeRpcResponse,
  PrivchatClient,
  RefreshTokenError,
} from '../../src/index.js';
import { FakeTransport } from './fake-transport.js';

const okPayload = (access_token: string, expires_at: number, refresh_token?: string) =>
  encodeRpcResponse({
    code: 0,
    message: 'ok',
    data: new TextEncoder().encode(
      JSON.stringify(
        refresh_token
          ? { access_token, expires_at, refresh_token }
          : { access_token, expires_at },
      ),
    ),
  });

describe('refreshAccessToken (B1 non-rotation)', () => {
  it('sends `account/auth/refresh` and returns the new access token', async () => {
    const t = new FakeTransport();
    let observedRoute = '';
    let observedBody: { refresh_token: string; device_id: string } | null = null;
    t.responder = (pkt) => {
      const req = decodeRpcRequest(pkt.payload);
      observedRoute = req.route;
      observedBody = JSON.parse(new TextDecoder().decode(req.body));
      return okPayload('NEW_ACCESS', 1_777_000_000_000);
    };

    const client = new PrivchatClient({ transport: t });
    const result = await client.refreshAccessToken('OLD_REFRESH', 'dev-1');

    expect(observedRoute).toBe('account/auth/refresh');
    expect(observedBody).toEqual({ refresh_token: 'OLD_REFRESH', device_id: 'dev-1' });
    expect(result.access_token).toBe('NEW_ACCESS');
    expect(result.expires_at).toBe(1_777_000_000_000);
    expect(result.refresh_token).toBeUndefined(); // B1 non-rotation
  });

  it('passes through rotated refresh_token when server returns one (B2+)', async () => {
    const t = new FakeTransport();
    t.responder = () => okPayload('A2', 999, 'R2');
    const client = new PrivchatClient({ transport: t });
    const result = await client.refreshAccessToken('R1', 'dev-1');
    expect(result.refresh_token).toBe('R2');
  });

  it('throws RefreshTokenError(terminal) when server returns 10009', async () => {
    const t = new FakeTransport();
    t.responder = () => encodeRpcResponse({ code: 10009, message: '[10009] refresh expired' });
    const client = new PrivchatClient({ transport: t });
    const err = await client.refreshAccessToken('R', 'dev-1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RefreshTokenError);
    expect((err as RefreshTokenError).errorCode).toBe(10009);
    expect((err as RefreshTokenError).errorKind).toBe('terminal');
  });

  it('throws RefreshTokenError(terminal) when server returns 10010 revoked', async () => {
    const t = new FakeTransport();
    t.responder = () => encodeRpcResponse({ code: 10010, message: '[10010] revoked' });
    const client = new PrivchatClient({ transport: t });
    await expect(client.refreshAccessToken('R', 'dev-1')).rejects.toMatchObject({
      name: 'RefreshTokenError',
      errorCode: 10010,
      errorKind: 'terminal',
    });
  });

  it('does NOT mutate the connection state machine on either path', async () => {
    const t = new FakeTransport();
    t.responder = () => okPayload('A2', 1);
    const client = new PrivchatClient({ transport: t });
    await client.connect();
    const before = client.connectionState();
    await client.refreshAccessToken('R', 'dev-1');
    expect(client.connectionState()).toBe(before);
  });
});
