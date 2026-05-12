import { describe, expect, it } from 'vitest';
import {
  AuthorizationError,
  classifyAuthErrorCode,
  encodeAuthorizationResponse,
  parseAuthErrorPrefix,
  PrivchatClient,
  RpcError,
  encodeRpcResponse,
} from '../../src/index.js';
import { FakeTransport } from './fake-transport.js';

describe('classifyAuthErrorCode (TOKEN_REFRESH_SPEC frozen)', () => {
  it('treats 10000 / 10002 as recoverable (refresh path)', () => {
    expect(classifyAuthErrorCode(10000)).toBe('recoverable');
    expect(classifyAuthErrorCode(10002)).toBe('recoverable');
  });

  it.each([10001, 10003, 10004, 10005, 10006, 10007, 10008, 10009, 10010])(
    'treats %i as terminal (forced re-login)',
    (code) => {
      expect(classifyAuthErrorCode(code)).toBe('terminal');
    },
  );

  it('treats unknown / out-of-band codes as transient (conservative default)', () => {
    expect(classifyAuthErrorCode(0)).toBe('transient');
    expect(classifyAuthErrorCode(500)).toBe('transient');
    expect(classifyAuthErrorCode(99_999)).toBe('transient');
  });
});

describe('parseAuthErrorPrefix', () => {
  it('extracts numeric prefix from `[<code>] message` format', () => {
    expect(parseAuthErrorPrefix('[10002] token expired')).toBe(10002);
    expect(parseAuthErrorPrefix('[0] noop')).toBe(0);
  });
  it('returns undefined when no prefix or input absent', () => {
    expect(parseAuthErrorPrefix(undefined)).toBeUndefined();
    expect(parseAuthErrorPrefix('')).toBeUndefined();
    expect(parseAuthErrorPrefix('plain message')).toBeUndefined();
  });
});

describe('AuthorizationError carries errorKind', () => {
  it('uses explicit error_code when present', () => {
    const e = new AuthorizationError({
      success: false,
      error_code: 10002,
      error_message: 'token expired',
    });
    expect(e.errorCode).toBe(10002);
    expect(e.errorKind).toBe('recoverable');
  });

  it('falls back to message prefix when error_code is 0', () => {
    const e = new AuthorizationError({
      success: false,
      error_code: 0,
      error_message: '[10009] refresh expired',
    });
    expect(e.errorCode).toBe(10009);
    expect(e.errorKind).toBe('terminal');
  });

  it('classifies missing code as transient', () => {
    const e = new AuthorizationError({ success: false });
    expect(e.errorCode).toBe(0);
    expect(e.errorKind).toBe('transient');
  });
});

describe('RpcError.errorKind', () => {
  it('classifies auth-band codes (10000..10099)', async () => {
    const t = new FakeTransport();
    t.responder = () => encodeRpcResponse({ code: 10002, message: 'token expired' });
    const client = new PrivchatClient({ transport: t });
    const err = await client.rpcCall('/x', '{}').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RpcError);
    expect((err as RpcError).errorKind).toBe('recoverable');
  });

  it('leaves non-auth-band codes as undefined', async () => {
    const t = new FakeTransport();
    t.responder = () => encodeRpcResponse({ code: 500, message: 'server error' });
    const client = new PrivchatClient({ transport: t });
    const err = await client.rpcCall('/x', '{}').catch((e: unknown) => e);
    expect((err as RpcError).errorKind).toBeUndefined();
  });
});

describe('authenticate emits auth_expired on failure', () => {
  it('recoverable path keeps state at "connected" and emits recoverable', async () => {
    const t = new FakeTransport();
    t.responder = () =>
      encodeAuthorizationResponse({
        success: false,
        error_code: 10002,
        error_message: 'token expired',
      });
    const client = new PrivchatClient({ transport: t });
    const seen: Array<{ reason: string; code: number }> = [];
    client.onAuthExpired((e) => seen.push({ reason: e.reason, code: e.error_code }));

    await expect(client.authenticate('1', 't', 'd')).rejects.toMatchObject({
      errorKind: 'recoverable',
    });
    expect(seen).toEqual([{ reason: 'recoverable', code: 10002 }]);
    expect(client.connectionState()).toBe('connected');
  });

  it('terminal path drops to disconnected and emits terminal', async () => {
    const t = new FakeTransport();
    t.responder = () =>
      encodeAuthorizationResponse({
        success: false,
        error_code: 10009,
        error_message: 'refresh expired',
      });
    const client = new PrivchatClient({ transport: t });
    const seen: Array<{ reason: string; code: number }> = [];
    client.onAuthExpired((e) => seen.push({ reason: e.reason, code: e.error_code }));

    await expect(client.authenticate('1', 't', 'd')).rejects.toMatchObject({
      errorKind: 'terminal',
    });
    expect(seen).toEqual([{ reason: 'terminal', code: 10009 }]);
    expect(client.connectionState()).toBe('disconnected');
  });
});
