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
//   - same `record_key` AND `from_uid === currentUserId` AND existing
//     row already has `status: 'sent'` → preserve content / status /
//     payload from existing; merge incoming `pts` / `revoked` if they
//     enrich the row.
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
 * - own-message + existing.status === 'sent': preserve `existing`,
 *   merging only `pts` and `revoked` when the incoming carries them.
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

  if (isOwnMessage && existing.status === 'sent') {
    // Own-message self-push: existing won. The push wire's empty
    // content + 'received' status would silently regress the row, so
    // we ONLY pull in whichever optional fields the existing row
    // doesn't have yet.
    return {
      ...existing,
      pts: existing.pts ?? incoming.pts,
      revoked:
        existing.revoked === true || incoming.revoked === true
          ? true
          : existing.revoked,
    };
  }

  return incoming;
}
