import { describe, expect, it } from 'vitest';
import {
  decodePushBatchRequest,
  decodePushBatchResponse,
  decodePushMessageRequest,
  decodePushMessageResponse,
  encodePushBatchRequest,
  encodePushBatchResponse,
  encodePushMessageRequest,
  encodePushMessageResponse,
  type PushMessageRequest,
} from '../src/index.js';

const baseMessage = (overrides: Partial<PushMessageRequest> = {}): PushMessageRequest => ({
  setting: { need_receipt: true, signal: 0 },
  msg_key: 'k-1',
  server_message_id: '700110001',
  message_seq: 100,
  local_message_id: '900710001',
  stream_no: '',
  stream_seq: 0,
  stream_flag: 0,
  timestamp: 1714680000,
  channel_id: '12345',
  channel_type: 1,
  message_type: 0,
  expire: 0,
  topic: '',
  from_uid: '999',
  payload: new TextEncoder().encode('{"content":"hi"}'),
  deleted: false,
  ...overrides,
});

describe('PushMessageRequest', () => {
  it('round-trips a basic single push', () => {
    const msg = baseMessage();
    const got = decodePushMessageRequest(encodePushMessageRequest(msg));
    expect(got).toEqual(msg);
  });

  it('round-trips a recall (deleted=true) push', () => {
    const msg = baseMessage({ deleted: true, payload: new Uint8Array(0) });
    const got = decodePushMessageRequest(encodePushMessageRequest(msg));
    expect(got).toEqual(msg);
  });

  it('round-trips a stream chunk', () => {
    const msg = baseMessage({
      stream_no: 'stream-abc',
      stream_seq: 7,
      stream_flag: 2,
      message_type: 9,
    });
    const got = decodePushMessageRequest(encodePushMessageRequest(msg));
    expect(got).toEqual(msg);
  });
});

describe('PushMessageResponse', () => {
  it('round-trips success', () => {
    const got = decodePushMessageResponse(
      encodePushMessageResponse({ succeed: true }),
    );
    expect(got.succeed).toBe(true);
    expect(got.message).toBeUndefined();
  });

  it('round-trips a failure with message', () => {
    const got = decodePushMessageResponse(
      encodePushMessageResponse({ succeed: false, message: 'channel closed' }),
    );
    expect(got.succeed).toBe(false);
    expect(got.message).toBe('channel closed');
  });
});

describe('PushBatchRequest', () => {
  it('round-trips a 3-message batch', () => {
    const messages = [
      baseMessage({ msg_key: 'k-1', server_message_id: '1', message_seq: 1 }),
      baseMessage({ msg_key: 'k-2', server_message_id: '2', message_seq: 2 }),
      baseMessage({ msg_key: 'k-3', server_message_id: '3', message_seq: 3, deleted: true }),
    ];
    const got = decodePushBatchRequest(encodePushBatchRequest({ messages }));
    expect(got.messages).toHaveLength(3);
    expect(got.messages).toEqual(messages);
  });

  it('round-trips an empty batch', () => {
    const got = decodePushBatchRequest(encodePushBatchRequest({ messages: [] }));
    expect(got.messages).toEqual([]);
  });
});

describe('PushBatchResponse', () => {
  it('round-trips success', () => {
    const got = decodePushBatchResponse(
      encodePushBatchResponse({ succeed: true }),
    );
    expect(got.succeed).toBe(true);
    expect(got.message).toBeUndefined();
  });

  it('round-trips a failure with message', () => {
    const got = decodePushBatchResponse(
      encodePushBatchResponse({ succeed: false, message: 'partial failure' }),
    );
    expect(got.succeed).toBe(false);
    expect(got.message).toBe('partial failure');
  });
});
