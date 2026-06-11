import { describe, expect, it } from 'vitest';
import {
  contentTypeFromWireTag,
  contentTypeToWireTag,
  decodeContentTypeName,
} from '../src/content-type.js';
import { pushToMessageRecord } from '../src/cache/types.js';
import type { PushMessageRequest } from '../src/index.js';

const TABLE = [
  ['text', 0],
  ['voice', 1],
  ['image', 2],
  ['video', 3],
  ['file', 4],
  ['system', 5],
  ['sticker', 6],
  ['contact_card', 7],
  ['location', 8],
  ['link', 9],
  ['forward', 10],
] as const;

describe('content-type mapping (single source of truth)', () => {
  it.each(TABLE)('%s ↔ tag %i round-trips', (name, tag) => {
    expect(contentTypeFromWireTag(tag)).toBe(name);
    expect(contentTypeToWireTag(name)).toBe(tag);
  });

  it('unknown tag → unknown; unknown name → tag 0 (conservative text)', () => {
    expect(contentTypeFromWireTag(999)).toBe('unknown');
    expect(contentTypeToWireTag('unknown')).toBe(0);
    expect(contentTypeToWireTag('mystery')).toBe(0);
  });

  it('decodeContentTypeName accepts word AND legacy decimal forms', () => {
    expect(decodeContentTypeName('image')).toBe('image');
    expect(decodeContentTypeName('2')).toBe('image');
    expect(decodeContentTypeName('10')).toBe('forward');
    expect(decodeContentTypeName('999')).toBe('unknown');
    expect(decodeContentTypeName('garbage')).toBe('unknown');
  });
});

describe('cache write paths store the canonical word form', () => {
  const push = (message_type: number): PushMessageRequest => ({
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
    message_type,
    expire: 0,
    topic: '',
    from_uid: '999',
    payload: new Uint8Array(),
    deleted: false,
  });

  it('pushToMessageRecord: media push stores word form, not decimal', () => {
    expect(pushToMessageRecord(push(2)).message_type).toBe('image');
    expect(pushToMessageRecord(push(0)).message_type).toBe('text');
    expect(pushToMessageRecord(push(5)).message_type).toBe('system');
  });
});
