import { describe, expect, it } from 'vitest';
import { derivePreview } from '../src/preview.js';

// `derivePreview(content, messageType?)` resolves the conversation-list
// preview's *content type* + literal text. It does NOT produce the
// placeholder label — that is locale-dependent and rendered by the UI.
//
// Two call shapes:
//   - push / send-ACK pass an explicit `messageType` (cache `message_type`,
//     either a wire decimal "2" or a word "image").
//   - channel-sync passes only `content` (the server's `last_msg_content`,
//     which for non-text messages is the raw `{"message_type":...}` JSON
//     envelope). `derivePreview` sniffs the type out of that envelope.

describe('derivePreview with explicit messageType', () => {
  it('text (word + decimal) keeps the literal content', () => {
    expect(derivePreview('hello', 'text')).toEqual({ content_type: 'text', text: 'hello' });
    expect(derivePreview('hello', '0')).toEqual({ content_type: 'text', text: 'hello' });
  });

  it.each([
    ['voice', '1'],
    ['image', '2'],
    ['video', '3'],
    ['file', '4'],
    ['system', '5'],
    ['sticker', '6'],
    ['contact_card', '7'],
    ['location', '8'],
    ['link', '9'],
    ['forward', '10'],
  ] as const)('%s resolves the type from word + decimal', (word, decimal) => {
    expect(derivePreview('caption', word).content_type).toBe(word);
    expect(derivePreview('caption', decimal).content_type).toBe(word);
  });

  it('unknown type resolves to "unknown"', () => {
    expect(derivePreview('whatever', '999').content_type).toBe('unknown');
    expect(derivePreview('whatever', 'mystery').content_type).toBe('unknown');
  });
});

describe('derivePreview from channel-sync content (no explicit type)', () => {
  it('plain text content passes through verbatim', () => {
    expect(derivePreview('see you tomorrow')).toEqual({
      content_type: 'text',
      text: 'see you tomorrow',
    });
  });

  it('JSON envelope resolves the inner message_type', () => {
    const envelope = JSON.stringify({
      message_type: 'system',
      content: '您的账号在 macos 设备登录',
    });
    expect(derivePreview(envelope).content_type).toBe('system');
  });

  it('JSON envelope with an image type resolves to image', () => {
    expect(derivePreview(JSON.stringify({ message_type: 'image', content: '' })).content_type).toBe(
      'image',
    );
  });

  it('JSON envelope explicitly typed text exposes the inner content', () => {
    expect(derivePreview(JSON.stringify({ message_type: 'text', content: 'hi there' }))).toEqual({
      content_type: 'text',
      text: 'hi there',
    });
  });

  it('plain JSON that is not a message envelope is treated as text', () => {
    // A user literally typing a JSON object — no `message_type` key, so
    // it is NOT an envelope and must render verbatim, not as a placeholder.
    const userText = JSON.stringify({ a: 1, b: 2 });
    expect(derivePreview(userText)).toEqual({ content_type: 'text', text: userText });
  });

  it('empty content is text with empty string', () => {
    expect(derivePreview('')).toEqual({ content_type: 'text', text: '' });
  });
});
