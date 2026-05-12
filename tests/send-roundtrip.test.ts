import { describe, expect, it } from 'vitest';
import {
  decodeSendMessageRequest,
  decodeSendMessageResponse,
  encodeSendMessageRequest,
  encodeSendMessageResponse,
} from '../src/index.js';

describe('SendMessageRequest', () => {
  it('round-trips a typical text send', () => {
    const payload = new TextEncoder().encode('{"content":"hi"}');
    const msg = {
      setting: { need_receipt: true, signal: 0 },
      client_seq: 42,
      local_message_id: '900710001',
      stream_no: '',
      channel_id: '12345',
      message_type: 0,
      expire: 0,
      from_uid: '999',
      topic: '',
      payload,
    };
    const got = decodeSendMessageRequest(encodeSendMessageRequest(msg));
    expect(got).toEqual(msg);
  });

  it('round-trips with stream/topic populated', () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    const msg = {
      setting: { need_receipt: false, signal: 1 },
      client_seq: 1,
      local_message_id: '1',
      stream_no: 'stream-abc',
      channel_id: '67890',
      message_type: 7,
      expire: 86400,
      from_uid: '1001',
      topic: 'announcements',
      payload,
    };
    const got = decodeSendMessageRequest(encodeSendMessageRequest(msg));
    expect(got).toEqual(msg);
  });
});

describe('SendMessageResponse', () => {
  it('round-trips a success response', () => {
    const msg = {
      client_seq: 42,
      server_message_id: '700110001',
      message_seq: 100,
      reason_code: 0,
    };
    const got = decodeSendMessageResponse(encodeSendMessageResponse(msg));
    expect(got).toEqual(msg);
  });

  it('round-trips an error response', () => {
    const msg = {
      client_seq: 99,
      server_message_id: '0',
      message_seq: 0,
      reason_code: 503,
    };
    const got = decodeSendMessageResponse(encodeSendMessageResponse(msg));
    expect(got).toEqual(msg);
  });
});
