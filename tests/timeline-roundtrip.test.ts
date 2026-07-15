import { describe, expect, it } from 'vitest';
import {
  CANONICAL_TIMELINE_EVENT_SCHEMA_V1,
  decodeCanonicalTimelineEvent,
  encodeCanonicalTimelineEvent,
  resolveCanonicalTimelineEvent,
  type CanonicalTimelineEvent,
} from '../src/index.js';

const base64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');

describe('CanonicalTimelineEvent FlatBuffers', () => {
  it.each<CanonicalTimelineEvent>([
    {
      type: 'new_message',
      message_type: 2,
      payload: {
        content: '',
        metadata: {
          type: 'image',
          file_id: '9007199254740993',
          width: 10,
          height: 20,
          file_name: 'photo.jpg',
        },
        mentioned_user_ids: ['9007199254740995'],
      },
    },
    {
      type: 'revoke',
      target_server_message_id: '9007199254740997',
      revoked_by: '9007199254740999',
      revoked_at: 1_700_000_000_000,
    },
    {
      type: 'reaction_change',
      target_server_message_id: '9007199254741001',
      actor_id: '9007199254741003',
      emoji: 'thumbs-up',
      operation: 'remove',
    },
  ])('round-trips $type without u64 precision loss', (event) => {
    expect(decodeCanonicalTimelineEvent(encodeCanonicalTimelineEvent(event))).toEqual(event);
  });
});

describe('canonical-first rolling compatibility', () => {
  const legacy = {
    server_msg_id: '9007199254740993',
    message_type: 'text',
    content: { text: 'hello' },
    server_timestamp: 1_700_000_000_000,
    sender_id: '9007199254740995',
  };

  it('new client reads old server through legacy fallback', () => {
    const result = resolveCanonicalTimelineEvent(legacy);
    expect(result.source).toBe('legacy_no_canonical');
    expect(result.event).toEqual({
      type: 'new_message',
      message_type: 0,
      payload: { content: 'hello', mentioned_user_ids: [] },
    });
  });

  it('new client prefers canonical and reports mismatch', () => {
    const event: CanonicalTimelineEvent = {
      type: 'new_message',
      message_type: 0,
      payload: { content: 'canonical', mentioned_user_ids: [] },
    };
    const result = resolveCanonicalTimelineEvent({
      ...legacy,
      event_schema_version: CANONICAL_TIMELINE_EVENT_SCHEMA_V1,
      canonical_event: base64(encodeCanonicalTimelineEvent(event)),
    });
    expect(result.source).toBe('canonical');
    expect(result.event).toEqual(event);
    expect(result.canonical_legacy_mismatch).toBe(true);
  });

  it('falls back as a whole event for future or malformed canonical data', () => {
    expect(
      resolveCanonicalTimelineEvent({
        ...legacy,
        event_schema_version: CANONICAL_TIMELINE_EVENT_SCHEMA_V1 + 1,
        canonical_event: 'ignored',
      }).source,
    ).toBe('legacy_unknown_version');

    const malformed = resolveCanonicalTimelineEvent({
      ...legacy,
      event_schema_version: CANONICAL_TIMELINE_EVENT_SCHEMA_V1,
      canonical_event: base64(new Uint8Array([1, 2, 3])),
    });
    expect(malformed.source).toBe('legacy_decode_error');
    expect(malformed.canonical_decode_error).toBe(true);
    expect(malformed.event?.type).toBe('new_message');
  });
});
