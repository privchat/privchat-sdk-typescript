// Cache merge policies for push absorption.
//
// Two kinds of `PushMessageRequest` land on the same seam and they are NOT
// the same thing:
//
//   1. **A message.** Carries a payload; this is the first delivery of that
//      message to this device (fan-out to the peer, or multi-device sync of
//      our own send).
//   2. **A status update.** Same `server_message_id`, **no payload**, and
//      `from_uid` is whoever is reporting the status — for a read/delivery
//      receipt that is the PEER, not the message's author. The server sends
//      the text once; everything after is status, and legitimately carries
//      no content.
//
// Treating (2) as (1) is what this module has to prevent. A status push
// mapped through `pushToMessageRecord` looks like a brand-new message with a
// fresh row id, empty content, `status: 'received'` and the peer's uid — and
// if that record replaces the row it refers to, the user's own message loses
// its text and its identity. The App (Kotlin/Rust) never had this bug because
// it applies pushes onto the existing row by `server_message_id`; the web/H5
// path rendered from `content` and went blank.
//
// The rule, therefore, is about identity rather than authorship:
//
//   **A push that matches an existing row describes that row. It may add
//   facts, never erase them, and never re-mint the row's identity.**
//
// Ownership still matters for one thing — promoting a local echo to `sent`
// once the server proves it committed the message — but correctness no
// longer depends on getting the ownership test right.

import type { MessageRecord } from './types.js';

export interface MergePushContext {
  /** Decoded `user_id` of the currently-authenticated session, or
   *  undefined when the SDK hasn't authenticated yet. The merge falls
   *  back to "treat as remote" when undefined — preserves the most
   *  defensive behaviour. */
  currentUserId?: string;
}

/**
 * Decide what record to persist when an inbound push has the same identity
 * as an existing cache row (same server or local message id).
 *
 * - `existing === undefined`: nothing to protect; take `incoming` (promoting
 *   it to `sent` when it is our own message arriving on another device).
 * - otherwise: keep the existing row's identity and any display data the
 *   push does not carry, and let the push contribute only what it actually
 *   knows.
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

  // From here on the push refers to a row we already hold.
  //
  // Start from `existing`, not from `incoming`: the row's stable id, its
  // content and its authorship are established facts, and a push is not
  // entitled to overwrite them with blanks. This is the invariant that
  // makes the status-push case harmless without having to recognise it.
  const incomingHasContent = incoming.content !== undefined && incoming.content !== '';
  const incomingHasPayload = incoming.payload !== undefined && incoming.payload.length > 0;

  // A status-only push (no payload, no content) says nothing about what the
  // message *is* — only that something happened to it. Anything it would
  // "contribute" to the display fields is an absence, not a value.
  const carriesMessageBody = incomingHasContent || incomingHasPayload;

  return {
    ...existing,
    // Identity never moves. §3.3 of SDK_ENTITY_MODEL_SPEC: the stable id is
    // the primary key, and everything the UI holds is keyed by it.
    id: existing.id,
    // Server identity / ordering: fill gaps, never regress.
    server_message_id: existing.server_message_id ?? incoming.server_message_id,
    local_message_id: existing.local_message_id ?? incoming.local_message_id,
    pts: existing.pts ?? incoming.pts,
    // Display data: only a push that actually carries the body may touch it.
    content: carriesMessageBody ? incoming.content : existing.content,
    payload: incomingHasPayload ? incoming.payload : existing.payload,
    message_type: carriesMessageBody ? incoming.message_type : existing.message_type,
    // Authorship comes from the message, not from whoever reported a status.
    from_uid: carriesMessageBody ? incoming.from_uid : existing.from_uid,
    // Status only moves forward. A row we already confirmed as sent must not
    // fall back to the push wire's default 'received'.
    status:
      existing.status === 'pending' || existing.status === 'sent'
        ? 'sent'
        : carriesMessageBody
          ? incoming.status
          : existing.status,
    // Revocation is monotonic: once revoked, always revoked.
    revoked: existing.revoked === true || incoming.revoked === true
      ? true
      : existing.revoked,
  };
}
