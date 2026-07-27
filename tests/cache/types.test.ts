import { describe, expect, it, vi } from 'vitest';
import { nextLocalMessageRecordId, pushToMessageRecord } from '../../src/cache/types.js';
import {
  encodeMessagePayloadEnvelope,
  type PushMessageRequest,
} from '../../src/index.js';

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
    // Canonical word form — the same representation history/sync writes.
    expect(rec.message_type).toBe('text');
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

  it('decodes a raw UTF-8 text push instead of misreading it as FlatBuffers', () => {
    const rec = pushToMessageRecord(samplePush({
      payload: new TextEncoder().encode('刚发出的消息'),
    }));
    expect(rec.content).toBe('刚发出的消息');
  });

  it('still decodes a typed FlatBuffers envelope', () => {
    const payload = encodeMessagePayloadEnvelope({
      content: '带回复的消息',
      reply_to_message_id: '700110000',
      mentioned_user_ids: [],
    });
    const rec = pushToMessageRecord(samplePush({ payload }));
    expect(rec.content).toBe('带回复的消息');
  });
});

/**
 * CONVERSATION_DEPENDENCY_READINESS §3.3.
 *
 * The generator's hard requirement is that no two rows ever share an id,
 * account-wide. It has no coordination scope to lean on: this SDK runs in
 * several JS contexts at once for the same account (tabs, workers) and gets
 * a fresh one on every reload, so any clock+counter scheme is per-context
 * and collides whenever two of them start in the same millisecond.
 */
describe('nextLocalMessageRecordId', () => {
  it('does not repeat within one context', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 20_000; i += 1) ids.add(nextLocalMessageRecordId());
    expect(ids.size).toBe(20_000);
  });

  it('does not collide across contexts started in the same millisecond', async () => {
    // Two tabs, or a tab and a worker, or the same tab before and after a
    // reload. Re-importing the module gives each a fresh module state; the
    // clock is pinned so a time-seeded generator would hand both the same
    // opening ids.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-27T00:00:00.000Z'));
    try {
      vi.resetModules();
      const tabA = await import('../../src/cache/types.js');
      vi.resetModules();
      const tabB = await import('../../src/cache/types.js');

      const idsA = Array.from({ length: 500 }, () => tabA.nextLocalMessageRecordId());
      const idsB = Array.from({ length: 500 }, () => tabB.nextLocalMessageRecordId());
      expect(new Set([...idsA, ...idsB]).size).toBe(1000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('is decimal, matching the encoding the Rust SDK stores', () => {
    for (let i = 0; i < 100; i += 1) {
      expect(nextLocalMessageRecordId()).toMatch(/^\d+$/);
    }
  });
});
