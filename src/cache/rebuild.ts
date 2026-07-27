// Rebuilding a lost message row from the command that was going to send it.
//
// Lives here rather than in the outbox engine because the v12 migration needs
// exactly the same rules: an orphaned command has to end up either linked to a
// rebuilt row or routed to repair, and two implementations of "can this be
// rebuilt" would eventually disagree about one content type.

import { decodeMessagePayloadEnvelope } from '../codec/payload.js';
import type { OutboxEntry } from './types.js';

/** Can a lost cache row be reconstructed from the outbox payload alone?
 *
 * Only for types whose payload carries the body. Everything else — image,
 * video, voice, file, and the structured cards — additionally depends on a
 * local file or on metadata the outbox row does not carry, so rebuilding
 * yields a message that can never load. Those are routed to repair instead.
 */
export function isRebuildableFromPayload(contentType: string): boolean {
  return contentType === 'text' || contentType === 'system';
}

/** Recover the body from a rebuildable payload.
 *
 * Text is not one encoding: plain text is raw UTF-8, while text carrying a
 * reply or a mention is wrapped in the same FlatBuffers envelope media uses,
 * because the server only decodes the typed envelope.
 *
 * Which one it is comes off the row (`payload_encoding`), recorded when the
 * send path chose the branch. It is not inferred: FlatBuffers reads arbitrary
 * bytes without complaint, so "try to decode and see" cannot separate an
 * envelope from raw text, and a legitimately empty body looks exactly like a
 * failed parse. Guessing here is how a rebuilt reply became mojibake.
 *
 * The reply/mention references live in `payload`, stored unchanged, so they
 * survive the rebuild even though `MessageRecord` has no field for them.
 */
export function decodeRebuildableContent(entry: OutboxEntry): string {
  const raw = (): string => new TextDecoder().decode(entry.payload);
  switch (entry.payload_encoding) {
    case 'raw_utf8':
      return raw();
    case 'message_envelope':
      // Declared an envelope, so a decode failure is damage, not a hint to
      // fall back — falling back would put the framing bytes on screen.
      return decodeMessagePayloadEnvelope(entry.payload).content ?? '';
    default:
      // Rows written before the field existed. This is the old heuristic,
      // now scoped to legacy data instead of being the general rule.
      try {
        const envelope = decodeMessagePayloadEnvelope(entry.payload);
        if (typeof envelope.content === 'string' && envelope.content.length > 0) {
          return envelope.content;
        }
      } catch {
        // fall through
      }
      return raw();
  }
}
