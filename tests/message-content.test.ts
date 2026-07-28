import { describe, expect, it } from 'vitest';
import {
  decodeLegacyMessageEnvelope,
  normalizeMessageDisplayContent,
  projectMessageContent,
} from '../src/message-content.js';
import { resolveCanonicalTimelineEvent } from '../src/codec/timeline.js';

const legacyJson = JSON.stringify({
  content: '审核通过后会第一时间通知您',
  mentioned_user_ids: [],
  reply_to_message_id: '600997771041832960',
});

describe('message content normalization', () => {
  it('unwraps a protocol-marked legacy message envelope', () => {
    expect(normalizeMessageDisplayContent(legacyJson)).toBe(
      '审核通过后会第一时间通知您',
    );
    expect(decodeLegacyMessageEnvelope(legacyJson)?.raw.reply_to_message_id).toBe(
      '600997771041832960',
    );
  });

  it('unwraps previously double-serialized envelopes', () => {
    const nested = JSON.stringify({ content: legacyJson, mentioned_user_ids: [] });
    expect(normalizeMessageDisplayContent(nested)).toBe('审核通过后会第一时间通知您');
  });

  it('preserves ordinary text, malformed JSON, and user-authored JSON', () => {
    expect(normalizeMessageDisplayContent('hello')).toBe('hello');
    expect(normalizeMessageDisplayContent('{broken')).toBe('{broken');
    expect(normalizeMessageDisplayContent('{"content":"literal user JSON"}')).toBe(
      '{"content":"literal user JSON"}',
    );
  });

  it('normalizes reconnect difference commits and keeps reply metadata', () => {
    const resolved = resolveCanonicalTimelineEvent({
      server_msg_id: '1',
      message_type: 'text',
      content: legacyJson,
      server_timestamp: 1,
      sender_id: '2',
    });
    expect(resolved.event).toEqual({
      type: 'new_message',
      message_type: 0,
      payload: {
        content: '审核通过后会第一时间通知您',
        mentioned_user_ids: [],
        reply_to_message_id: '600997771041832960',
      },
    });
  });

  it('projects text entities once at the SDK boundary', () => {
    const body = projectMessageContent({
      content_type: 'text',
      content: '@客服 请访问 https://privchat.example 或拨打 13800138000',
      mentioned_user_ids: ['1001'],
    });
    expect(body.entities).toEqual([
      expect.objectContaining({ type: 'mention', text: '@客服', user_id: '1001' }),
      expect.objectContaining({ type: 'url', value: 'https://privchat.example' }),
      expect.objectContaining({ type: 'phone', value: '13800138000' }),
    ]);
  });

  it('projects system and money payloads into typed snapshots', () => {
    const system = projectMessageContent({
      content_type: 'system',
      content: JSON.stringify({
        template: '{operator} 邀请了 {member}',
        refs: [{ type: 'user', target_id: 10, text: '管理员' }],
      }),
    });
    expect(system).toMatchObject({
      kind: 'system',
      text: '{operator} 邀请了 {member}',
      template: '{operator} 邀请了 {member}',
      refs: [{ type: 'user', target_id: '10', text: '管理员' }],
    });

    const money = projectMessageContent({
      content_type: 'red_packet',
      content: JSON.stringify({
        redPacketId: 'rp-1', title: '恭喜发财', amountText: '¥88.00', status: 'opened', type: 2,
      }),
    });
    expect(money).toMatchObject({
      kind: 'red_packet',
      text: '恭喜发财',
      money: { ref_id: 'rp-1', title: '恭喜发财', amount_text: '¥88.00', status: 'opened', packet_type: 2 },
    });
  });

  it('never exposes JSON as a fallback caption for unsupported structured content', () => {
    expect(projectMessageContent({
      content_type: 'image',
      content: '{"url":"https://cdn.example/image.png","width":100}',
    })).toMatchObject({ kind: 'image', text: '' });
  });

  it('keeps user-authored JSON as text in the typed projection', () => {
    expect(projectMessageContent({
      content_type: 'text',
      content: '{"content":"literal user JSON"}',
    })).toMatchObject({ kind: 'text', text: '{"content":"literal user JSON"}' });
  });

  it('keeps normalized record content authoritative over a malformed envelope', () => {
    expect(projectMessageContent({
      content_type: 'text',
      content: '刚发送即可见',
      envelope: { content: '', mentioned_user_ids: [] },
    })).toMatchObject({ kind: 'text', text: '刚发送即可见' });
  });
});

describe('reply anchor sanitisation', () => {
  // Production payloads carry `"reply_to_message_id":"null"` — a sender that
  // stringified an absent optional. Callers test the projection with
  // `!== undefined`, so passing it through made web draw an "original
  // unavailable" quote strip above every plain message.
  const project = (replyTo: unknown) =>
    projectMessageContent({
      content: JSON.stringify({
        content: 'hi',
        metadata: {},
        reply_to_message_id: replyTo,
      }),
      content_type: 'text',
    }).reply_to_message_id;

  it.each([
    ['stringified null', 'null'],
    ['stringified undefined', 'undefined'],
    ['zero sentinel as string', '0'],
    ['zero sentinel as number', 0],
    ['empty string', ''],
    ['non-numeric junk', 'abc'],
  ])('drops %s', (_label, value) => {
    expect(project(value)).toBeUndefined();
  });

  it.each([
    ['snowflake string', '600997771041832960', '600997771041832960'],
    ['numeric id', 4242, '4242'],
  ])('keeps a real %s', (_label, value, expected) => {
    expect(project(value)).toBe(expected);
  });

  // The path that actually renders production conversations: react parses the
  // JSON payload straight into the envelope shape and passes it in as `envelope`,
  // so the sanitiser has to cover that source too — not just the raw legacy body.
  const projectViaEnvelope = (replyTo: unknown) =>
    projectMessageContent({
      content_type: 'text',
      content: 'hi',
      envelope: {
        content: 'hi',
        mentioned_user_ids: [],
        reply_to_message_id: replyTo,
      } as never,
    }).reply_to_message_id;

  it.each([
    ['stringified null', 'null'],
    ['zero sentinel', '0'],
    ['empty string', ''],
  ])('drops %s arriving via the envelope', (_label, value) => {
    expect(projectViaEnvelope(value)).toBeUndefined();
  });

  it('keeps a real anchor arriving via the envelope', () => {
    expect(projectViaEnvelope('600997771041832960')).toBe('600997771041832960');
  });

  // Explicit caller input is sanitised as well.
  it('drops a stringified null passed explicitly', () => {
    expect(
      projectMessageContent({
        content_type: 'text',
        content: 'hi',
        reply_to_message_id: 'null' as never,
      }).reply_to_message_id,
    ).toBeUndefined();
  });
});
