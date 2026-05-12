import { describe, expect, it } from 'vitest';
import {
  decodeAuthorizationRequest,
  decodeAuthorizationResponse,
  encodeAuthorizationRequest,
  encodeAuthorizationResponse,
  type AuthorizationRequest,
  type AuthorizationResponse,
} from '../src/index.js';

const baseRequest = (overrides: Partial<AuthorizationRequest> = {}): AuthorizationRequest => ({
  auth_type: 'jwt',
  auth_token: 'eyJhbGciOi...',
  client_info: {
    client_type: 'web',
    version: '0.1.0',
    os: 'macOS',
    os_version: '15.0',
    device_model: 'MacBookPro18,1',
    app_package: 'com.privchat.web',
  },
  device_info: {
    device_id: 'dev-123',
    device_type: 'web',
    app_id: 'app-1',
    push_token: 'fcm-token',
    push_channel: 'fcm',
    device_name: 'Chrome 130',
    device_model: undefined,
    os_version: '15.0',
    app_version: '0.1.0',
    manufacturer: 'Apple',
    device_fingerprint: 'fp-abc',
  },
  protocol_version: '1.0',
  properties: { region: 'us-west', tenant: 'demo' },
  ...overrides,
});

describe('AuthorizationRequest', () => {
  it('round-trips a fully populated JWT request', () => {
    const msg = baseRequest();
    const got = decodeAuthorizationRequest(encodeAuthorizationRequest(msg));
    expect(got).toEqual(msg);
  });

  it('round-trips with all optional fields absent', () => {
    const msg: AuthorizationRequest = {
      auth_type: 'anonymous',
      auth_token: '',
      client_info: { client_type: 'cli', version: '0.0.1', os: 'linux', os_version: '6.1' },
      device_info: { device_id: 'd1', device_type: 'linux', app_id: 'a1', device_name: 'tty' },
      protocol_version: '1.0',
      properties: {},
    };
    const got = decodeAuthorizationRequest(encodeAuthorizationRequest(msg));
    expect(got).toEqual(msg);
  });

  it.each([
    ['unspecified'],
    ['jwt'],
    ['user_password'],
    ['oauth'],
    ['anonymous'],
  ] as const)('round-trips auth_type=%s', (auth_type) => {
    const msg = baseRequest({ auth_type });
    const got = decodeAuthorizationRequest(encodeAuthorizationRequest(msg));
    expect(got.auth_type).toBe(auth_type);
  });

  it.each([
    ['unknown'],
    ['ios'],
    ['android'],
    ['web'],
    ['macos'],
    ['windows'],
    ['linux'],
    ['iot'],
  ] as const)('round-trips device_type=%s', (device_type) => {
    const msg = baseRequest();
    msg.device_info.device_type = device_type;
    const got = decodeAuthorizationRequest(encodeAuthorizationRequest(msg));
    expect(got.device_info.device_type).toBe(device_type);
  });
});

describe('AuthorizationResponse', () => {
  it('round-trips a full success response', () => {
    const msg: AuthorizationResponse = {
      success: true,
      session_id: 'sess-1',
      user_id: '900710001',
      connection_id: 'conn-1',
      server_info: {
        version: '1.0.0',
        name: 'privchat',
        features: ['fb', 'multi-device'],
        max_message_size: 4194304,
        connection_timeout: 60,
      },
      heartbeat_interval: 30,
    };
    const got = decodeAuthorizationResponse(encodeAuthorizationResponse(msg));
    expect(got).toEqual(msg);
  });

  it('round-trips a minimal failure response', () => {
    const msg: AuthorizationResponse = {
      success: false,
      error_code: 401,
      error_message: 'invalid token',
    };
    const got = decodeAuthorizationResponse(encodeAuthorizationResponse(msg));
    expect(got).toEqual(msg);
  });

  it('round-trips a bare success (all optionals absent)', () => {
    const msg: AuthorizationResponse = { success: true };
    const got = decodeAuthorizationResponse(encodeAuthorizationResponse(msg));
    expect(got).toEqual(msg);
  });
});
