import { describe, expect, it } from 'vitest';
import {
  decodeSubscribeRequest,
  decodeSubscribeResponse,
  encodeSubscribeRequest,
  encodeSubscribeResponse,
} from '../src/index.js';

describe('SubscribeRequest', () => {
  it('round-trips a populated request', () => {
    const msg = {
      setting: 0x07,
      local_message_id: '42',
      channel_id: '900710001',
      channel_type: 2,
      action: 1,
      param: 'history=true&limit=20',
    };
    const got = decodeSubscribeRequest(encodeSubscribeRequest(msg));
    expect(got).toEqual(msg);
  });

  it('round-trips an empty param + zero IDs', () => {
    const msg = {
      setting: 0,
      local_message_id: '0',
      channel_id: '0',
      channel_type: 0,
      action: 0,
      param: '',
    };
    const got = decodeSubscribeRequest(encodeSubscribeRequest(msg));
    expect(got).toEqual(msg);
  });
});

describe('SubscribeResponse', () => {
  it('round-trips a success response', () => {
    const msg = {
      local_message_id: '42',
      channel_id: '900710001',
      channel_type: 2,
      action: 1,
      reason_code: 0,
    };
    const got = decodeSubscribeResponse(encodeSubscribeResponse(msg));
    expect(got).toEqual(msg);
  });

  it('round-trips an error reason code (u8 max)', () => {
    const msg = {
      local_message_id: '99',
      channel_id: '12345',
      channel_type: 1,
      action: 2,
      reason_code: 255,
    };
    const got = decodeSubscribeResponse(encodeSubscribeResponse(msg));
    expect(got).toEqual(msg);
  });
});
