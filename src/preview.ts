// Conversation-list preview derivation.
//
// The channel-list shows a one-line preview of each channel's most-recent
// message. Product rule: ONLY `text` messages show their literal content;
// every other content type renders a placeholder.
//
// This module resolves the *content type* (and the literal text for text
// messages) but deliberately does NOT produce the placeholder string —
// that label is locale-dependent ("[图片]" vs "[Image]") and must be
// rendered by the UI against the active language. Persisting a localized
// string here would freeze the preview to whatever language was active at
// write time. So the SDK stores `last_message_type` + `last_message_preview`
// (text) on the channel record, and the UI maps the type to a translated
// label at render time.

/** Canonical content-type discriminants, mirroring
 *  `protocol::ContentMessageType` / `MessageType::as_str()`. */
export type PreviewContentType =
  | 'text'
  | 'voice'
  | 'image'
  | 'video'
  | 'file'
  | 'system'
  | 'sticker'
  | 'contact_card'
  | 'location'
  | 'link'
  | 'forward'
  | 'unknown';

export interface MessagePreview {
  /** Resolved type. The UI shows `text` verbatim and renders a localized
   *  placeholder for every other type. */
  content_type: PreviewContentType;
  /** Literal display text. Meaningful for `text`; for other types it is
   *  the extracted caption / inner content (the UI shows a typed
   *  placeholder instead, but this stays sane as a fallback and never
   *  leaks the raw JSON envelope). */
  text: string;
}

const WORD_TYPES: ReadonlySet<string> = new Set<PreviewContentType>([
  'text',
  'voice',
  'image',
  'video',
  'file',
  'system',
  'sticker',
  'contact_card',
  'location',
  'link',
  'forward',
  'unknown',
]);

/** Map a `message_type` into a `PreviewContentType`. Accepts both the wire
 *  decimal form ("0".."10", push/outbox) and the server word form
 *  ("text"/"image"/…, history/sync). Anything else → 'unknown'. */
function toContentType(raw: string): PreviewContentType {
  if (WORD_TYPES.has(raw)) return raw as PreviewContentType;
  switch (raw) {
    case '0':
      return 'text';
    case '1':
      return 'voice';
    case '2':
      return 'image';
    case '3':
      return 'video';
    case '4':
      return 'file';
    case '5':
      return 'system';
    case '6':
      return 'sticker';
    case '7':
      return 'contact_card';
    case '8':
      return 'location';
    case '9':
      return 'link';
    case '10':
      return 'forward';
    default:
      return 'unknown';
  }
}

/** When `messageType` is absent (channel-sync only carries the raw
 *  `last_msg_content`), sniff the type out of a `{ "message_type": ...,
 *  "content": ... }` JSON envelope. Returns `undefined` when `content`
 *  is not such an envelope (plain text — including a user who literally
 *  typed a JSON object, which has no `message_type` key). */
function sniffEnvelope(
  content: string,
): { type: PreviewContentType; inner: string } | undefined {
  if (content.length === 0 || content[0] !== '{') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object') return undefined;
  const obj = parsed as Record<string, unknown>;
  const mt = obj.message_type;
  if (typeof mt !== 'string' && typeof mt !== 'number') return undefined;
  return {
    type: toContentType(String(mt)),
    inner: typeof obj.content === 'string' ? obj.content : '',
  };
}

/**
 * Resolve a message's preview type + text.
 *
 * @param content     The message's display content. For push/ACK this is
 *                    the already-extracted text/caption; for channel-sync
 *                    it is the server's raw `last_msg_content`.
 * @param messageType Cache `message_type` when known (push/ACK). Omit for
 *                    channel-sync, where the type is sniffed from `content`.
 */
export function derivePreview(content: string, messageType?: string): MessagePreview {
  if (messageType !== undefined) {
    return { content_type: toContentType(messageType), text: content };
  }
  const env = sniffEnvelope(content);
  if (env === undefined) return { content_type: 'text', text: content };
  return { content_type: env.type, text: env.inner };
}
