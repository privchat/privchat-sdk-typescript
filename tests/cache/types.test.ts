import { describe, expect, it } from 'vitest';
import { pushToMessageRecord } from '../../src/cache/types.js';
import type { PushMessageRequest } from '../../src/index.js';

const samplePush = (overrides: Partial<PushMessageRequest> = {}): PushMessageRequest => ({
  setting: { need_receipt: false, signal: 0 },
  msg_key: 'k-1',
  server_message_id: '700110001',
  message_seq: 100,
  local_message_id: '0',
  stream_no: '',
  stream_seq: 0,
  stream_flag: 0,
  timestamp: 1_714_680_000,
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

describe('pushToMessageRecord', () => {
  it('maps standard push to a received MessageRecord', () => {
    const rec = pushToMessageRecord(samplePush());
    expect(rec.server_message_id).toBe('700110001');
    expect(rec.pts).toBe('100');
    expect(rec.message_type).toBe('0');
    expect(rec.from_uid).toBe('999');
    expect(rec.timestamp).toBe(1_714_680_000_000);
    expect(rec.status).toBe('received');
    expect(rec.revoked).toBe(false);
    expect(rec.local_message_id).toBeUndefined();
  });

  it('promotes deleted=true to revoked=true', () => {
    const rec = pushToMessageRecord(samplePush({ deleted: true }));
    expect(rec.revoked).toBe(true);
  });

  it('keeps a populated local_message_id (skipping the "0" sentinel)', () => {
    const rec = pushToMessageRecord(samplePush({ local_message_id: '900710001' }));
    expect(rec.local_message_id).toBe('900710001');
  });

  it('preserves the FlatBuffers payload bytes verbatim', () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    const rec = pushToMessageRecord(samplePush({ payload }));
    expect(rec.payload).toEqual(payload);
  });
});
