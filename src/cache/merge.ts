// Cache merge policies. Currently only one rule lives here: a defensive
// merge applied during push absorption so the server's self-push for
// our own outgoing message cannot downgrade the locally-acked row.
//
// Rationale: direct-channel push fan-out on the server delivers a copy
// of every committed message to BOTH members, including the sender.
// The push's `PushMessageRequest` carries the same `server_message_id`
// as the original send-ACK or outbox-flush ACK, but its `content` is
// empty (the wire doesn't include the parsed application content) and
// its status is `'received'`. Without this guard, the second packet
// to land — push or ACK — clobbers the first.
//
// The fix is local-trumps-self-push, applied at the absorption seam:
//   - same logical message AND `from_uid === currentUserId` → preserve
//     local content / payload. A self-push also promotes a pending local
//     echo to sent because it proves that the server committed it.
//   - All other cases — remote push, no prior row, prior row in any
//     other status — accept the incoming record verbatim. This
//     deliberately keeps the policy narrow; broader merge rules
//     (history / sync / mark-read) live in their own absorption paths.

import type { MessageRecord } from './types.js';

export interface MergePushContext {
  /** Decoded `user_id` of the currently-authenticated session, or
   *  undefined when the SDK hasn't authenticated yet. The merge falls
   *  back to "treat as remote" when undefined — preserves the most
   *  defensive behaviour. */
  currentUserId?: string;
}

/**
 * Decide what record to persist when an inbound push has the same
 * `record_key` as an existing cache row.
 *
 * - `existing === undefined`: trivially return `incoming`.
 * - own-message + existing pending/sent: preserve local display fields,
 *   merge server identity / pts / revoke state, and promote to `sent`.
 * - any other case: return `incoming` (current behaviour).
 */
export function mergeOnPushAbsorb(
  existing: MessageRecord | undefined,
  incoming: MessageRecord,
  ctx: MergePushContext,
): MessageRecord {
  const isOwnMessage =
    ctx.currentUserId !== undefined && incoming.from_uid === ctx.currentUserId;

  if (!existing) {
    // Multi-device real-time fan-out: a copy of our own outgoing message
    // arrives on this device with no local echo to merge against. It is
    // still OUR message → land it as 'sent', not the push wire's default
    // 'received' (which renders the bogus "received?" delivery label).
    return isOwnMessage ? { ...incoming, status: 'sent' } : incoming;
  }

  if (
    isOwnMessage &&
    (existing.status === 'pending' || existing.status === 'sent')
  ) {
    // Local display data wins, while the push is authoritative proof that
    // the server committed the message. This closes the push-before-ACK
    // race without exposing an empty server-keyed row.
    return {
      ...existing,
      server_message_id:
        existing.server_message_id ?? incoming.server_message_id,
      local_message_id:
        existing.local_message_id ?? incoming.local_message_id,
      pts: incoming.pts ?? existing.pts,
      status: 'sent',
      revoked:
        existing.revoked === true || incoming.revoked === true
          ? true
          : existing.revoked,
    };
  }

  return incoming;
}
