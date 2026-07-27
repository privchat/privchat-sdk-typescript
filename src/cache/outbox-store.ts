// Phase 5C-1a: low-level IndexedDB adapter for the outbox store.
//
// Pure CRUD over `CacheDB.outbox` — no scheduling, no retry, no engine
// state. Higher layers (5C-1c OutboxEngine, 5C-1b sendTextMessage
// rewrite) own behaviour. This file is intentionally state-free so it
// can be unit-tested in isolation against a freshly-constructed CacheDB.
//
// Conventions:
//   - All time fields are wall-clock milliseconds (`Date.now()`).
//   - `outbox_id` is the canonical primary key. `local_message_id` is
//     a unique secondary index — schema-enforced uniqueness so a host
//     bug that double-enqueues the same logical message fails fast.
//   - Status filtering on multi-condition queries happens client-side
//     after a single index range scan. The expected outbox depth is
//     small (typical chat: 0–10 rows; pathological case: hundreds);
//     we don't yet need a compound `[status+next_attempt_at]` index.

import type { CacheDB } from './indexeddb-store.js';
import type { OutboxEntry, OutboxStatus } from './types.js';

// ----- Write ops -----

/** Insert or replace one entry. Caller is responsible for setting
 *  `created_at` (on first put) and `updated_at` (on every put). */
export async function putOutboxEntry(
  db: CacheDB,
  entry: OutboxEntry,
): Promise<void> {
  await db.outbox.put(entry);
}

/**
 * Apply a partial update to an entry's mutable fields. Bumps
 * `updated_at` to `Date.now()` automatically unless the patch already
 * supplies it. Returns the post-update entry, or `undefined` if no row
 * matched the `outbox_id` (no-op).
 *
 * Mutable fields only: status, attempt_count, local_commit_failures,
 * next_attempt_at, last_error, updated_at, record_key. Immutable identity fields
 * (outbox_id, channel_id/type, local_message_id, from_uid,
 * content_type, payload, created_at) intentionally cannot be patched
 * here — to change those, delete and re-put.
 */
/** Mutable fields of an outbox row. Identity fields are not patchable. */
export interface OutboxStatusPatch {
  status?: OutboxStatus;
  attempt_count?: number;
  local_commit_failures?: number;
  repair_attempts?: number;
  repair_kind?: 'identity_conflict';
  conflicting_id?: string;
  conflicting_channel_id?: string;
  repair_lease_token?: string;
  repair_lease_until?: number;
  repair_next_attempt_at?: number;
  acked_server_message_id?: string;
  acked_message_seq?: number;
  next_attempt_at?: number;
  last_error?: string | null;
  record_key?: string;
  updated_at?: number;
}

function applyOutboxPatch(existing: OutboxEntry, patch: OutboxStatusPatch): OutboxEntry {
  const next: OutboxEntry = { ...existing };
  if (patch.status !== undefined) next.status = patch.status;
  if (patch.attempt_count !== undefined) next.attempt_count = patch.attempt_count;
  if (patch.local_commit_failures !== undefined) {
    next.local_commit_failures = patch.local_commit_failures;
  }
  if (patch.repair_attempts !== undefined) next.repair_attempts = patch.repair_attempts;
  if (patch.repair_kind !== undefined) next.repair_kind = patch.repair_kind;
  if (patch.conflicting_id !== undefined) next.conflicting_id = patch.conflicting_id;
  if (patch.conflicting_channel_id !== undefined) {
    next.conflicting_channel_id = patch.conflicting_channel_id;
  }
  if (patch.repair_lease_token !== undefined) {
    next.repair_lease_token = patch.repair_lease_token;
  }
  if (patch.repair_lease_until !== undefined) {
    next.repair_lease_until = patch.repair_lease_until;
  }
  if (patch.repair_next_attempt_at !== undefined) {
    next.repair_next_attempt_at = patch.repair_next_attempt_at;
  }
  if (patch.acked_server_message_id !== undefined) {
    next.acked_server_message_id = patch.acked_server_message_id;
  }
  if (patch.acked_message_seq !== undefined) {
    next.acked_message_seq = patch.acked_message_seq;
  }
  if (patch.next_attempt_at !== undefined) next.next_attempt_at = patch.next_attempt_at;
  if (patch.record_key !== undefined) next.record_key = patch.record_key;
  if ('last_error' in patch) {
    if (patch.last_error === null || patch.last_error === undefined) {
      delete next.last_error;
    } else {
      next.last_error = patch.last_error;
    }
  }
  next.updated_at = patch.updated_at ?? Date.now();
  return next;
}

export async function updateOutboxStatus(
  db: CacheDB,
  outbox_id: string,
  patch: OutboxStatusPatch,
): Promise<OutboxEntry | undefined> {
  const existing = await db.outbox.get(outbox_id);
  if (!existing) return undefined;
  const next = applyOutboxPatch(existing, patch);
  await db.outbox.put(next);
  return next;
}

/** Remove one entry by primary key. No-op when absent. */
export async function deleteOutboxEntry(
  db: CacheDB,
  outbox_id: string,
): Promise<void> {
  await db.outbox.delete(outbox_id);
}

// ----- Read ops -----

/** Fetch one entry by primary key. */
export async function getOutboxEntry(
  db: CacheDB,
  outbox_id: string,
): Promise<OutboxEntry | undefined> {
  return db.outbox.get(outbox_id);
}

/** Fetch one entry by its `local_message_id` (unique). */
export async function getOutboxByLocalMessageId(
  db: CacheDB,
  local_message_id: string,
): Promise<OutboxEntry | undefined> {
  return db.outbox.where('local_message_id').equals(local_message_id).first();
}

export interface ListOutboxOptions {
  /** Filter to one or more statuses. Default: all. */
  statuses?: OutboxStatus[];
  /** Cap result size. Default: unlimited. */
  limit?: number;
}

/**
 * Snapshot of the entire outbox, sorted by `created_at` ascending
 * (oldest first — matches the canonical FIFO ordering). Optional
 * status filter applies client-side post-fetch.
 *
 * For a UI sidebar / `outboxEntries()` getter this is the right call.
 * For per-channel FIFO drain use `listOutboxByChannel`.
 */
export async function listOutboxEntries(
  db: CacheDB,
  options: ListOutboxOptions = {},
): Promise<OutboxEntry[]> {
  let rows = await db.outbox.orderBy('[channel_id+created_at]').toArray();
  if (options.statuses && options.statuses.length > 0) {
    const allowed = new Set(options.statuses);
    rows = rows.filter((r) => allowed.has(r.status));
  }
  // Re-sort by created_at to give a global FIFO view (the compound
  // index is per-channel, not global). Cheap on small datasets.
  rows.sort((a, b) => a.created_at - b.created_at);
  if (options.limit !== undefined) rows = rows.slice(0, options.limit);
  return rows;
}

/**
 * Per-channel scan, ordered by `created_at` ascending. The natural
 * input to the engine's per-channel mutex loop.
 */
export async function listOutboxByChannel(
  db: CacheDB,
  channel_id: string,
  _channel_type: number,
): Promise<OutboxEntry[]> {
  return db.outbox
    .where('[channel_id+created_at]')
    .between([channel_id, -Infinity], [channel_id, Infinity])
    .toArray();
}

/**
 * Rows whose `next_attempt_at <= now` and which are eligible for work.
 *
 * `sending` rows are included **only when their lease has expired**. A
 * live lease means another attempt — possibly in another tab — owns the
 * row. An expired one means the owner died mid-flight: without this the
 * row would sit in `sending` forever, since nothing else selects it.
 * Reclaiming keeps the same `local_message_id`, so a resend the server
 * already saw is deduped rather than delivered twice.
 *
 * Sorted by `created_at` ascending. The engine's flush pass should
 * group by channel and respect per-channel mutex; this call is for
 * "what's ready to fire", not "in what order to fire".
 */
export async function listDueOutboxEntries(
  db: CacheDB,
  now: number,
): Promise<OutboxEntry[]> {
  const all = await db.outbox
    .where('next_attempt_at')
    .belowOrEqual(now)
    .toArray();
  return all
    .filter(
      (r) =>
        r.status === 'pending' ||
        r.status === 'failed' ||
        // Delivered, local commit outstanding: due for a LOCAL retry. The
        // engine must not put these back on the wire.
        r.status === 'ack_pending' ||
        (r.status === 'sending' && (r.lease_until ?? 0) <= now),
    )
    .sort((a, b) => a.created_at - b.created_at);
}

/**
 * Take ownership of a row for one send attempt. Compare-and-set, atomic.
 *
 * The transition is strict — only `pending`, `failed`, or a `sending` row
 * whose lease has expired may become `sending`. The caller's own idea of
 * the row's state is never trusted: it comes from a `listDueOutboxEntries`
 * snapshot that another tab may have invalidated in between. Concretely,
 * without the re-check this sequence sends a delivered message twice:
 *
 *   tab B snapshots the row as `pending`
 *   tab A sends it, fails to commit locally, writes `ack_pending`
 *   tab B claims from its stale snapshot and sends again
 *
 * `ack_pending` and `integrity_error` mean the server already has the
 * message. Nothing may drag them back onto the wire.
 *
 * Returns the claimed row, or `undefined` when the row is gone, held by a
 * live lease, or in a state that must not be re-sent.
 */
export async function claimOutboxEntry(
  db: CacheDB,
  outbox_id: string,
  lease_token: string,
  now: number,
  lease_ms: number,
): Promise<OutboxEntry | undefined> {
  return db.transaction('rw', db.outbox, async () => {
    const row = await db.outbox.get(outbox_id);
    if (row === undefined) return undefined;

    const claimable =
      row.status === 'pending' ||
      row.status === 'failed' ||
      (row.status === 'sending' && (row.lease_until ?? 0) <= now);
    if (!claimable) return undefined;

    const claimed: OutboxEntry = {
      ...row,
      status: 'sending',
      lease_token,
      lease_until: now + lease_ms,
      updated_at: now,
    };
    await db.outbox.put(claimed);
    return claimed;
  });
}

/**
 * Apply a terminal transition only while we still own the row.
 *
 * Fencing. A claim's lease can expire mid-flight — a stalled request, a
 * suspended tab — and another attempt can legitimately take over. When the
 * original owner finally returns it must not be able to overwrite the new
 * owner's state or delete the row out from under it. Returns false when
 * ownership was lost; the caller must then publish nothing, because
 * whatever it was about to say is no longer true.
 */
export async function commitOutboxTransition(
  db: CacheDB,
  outbox_id: string,
  lease_token: string,
  patch: OutboxStatusPatch,
): Promise<boolean> {
  return db.transaction('rw', db.outbox, async () => {
    const row = await db.outbox.get(outbox_id);
    if (row === undefined || row.lease_token !== lease_token) return false;
    await db.outbox.put(applyOutboxPatch(row, patch));
    return true;
  });
}

/**
 * Take ownership of one repair pass. Same discipline as the send lease.
 *
 * Without it every flush in every tab would run repair on the same row
 * concurrently, and a burst of flushes would burn the whole repair budget
 * in seconds — turning a recoverable fault into `local_data_error` before
 * any repair had a real chance. The attempt counter is incremented HERE,
 * inside the claim, so it counts repairs actually performed.
 */
export async function claimRepairRow(
  db: CacheDB,
  outbox_id: string,
  repair_lease_token: string,
  now: number,
  lease_ms: number,
): Promise<OutboxEntry | undefined> {
  return db.transaction('rw', db.outbox, async () => {
    const row = await db.outbox.get(outbox_id);
    if (row === undefined || row.status !== 'integrity_error') return undefined;
    if ((row.repair_lease_until ?? 0) > now) return undefined; // someone is on it
    if ((row.repair_next_attempt_at ?? 0) > now) return undefined; // backing off

    const claimed: OutboxEntry = {
      ...row,
      repair_attempts: (row.repair_attempts ?? 0) + 1,
      repair_lease_token,
      repair_lease_until: now + lease_ms,
      updated_at: now,
    };
    await db.outbox.put(claimed);
    return claimed;
  });
}

/** Apply a repair outcome only while we still own the repair pass. */
export async function commitRepairTransition(
  db: CacheDB,
  outbox_id: string,
  repair_lease_token: string,
  patch: OutboxStatusPatch,
): Promise<boolean> {
  return db.transaction('rw', db.outbox, async () => {
    const row = await db.outbox.get(outbox_id);
    if (row === undefined || row.repair_lease_token !== repair_lease_token) return false;
    await db.outbox.put(applyOutboxPatch(row, patch));
    return true;
  });
}

/** Delete the row only while we still hold the REPAIR lease on it. */
export async function deleteOutboxEntryIfRepairOwner(
  db: CacheDB,
  outbox_id: string,
  repair_lease_token: string,
): Promise<boolean> {
  return db.transaction('rw', db.outbox, async () => {
    const row = await db.outbox.get(outbox_id);
    if (row === undefined || row.repair_lease_token !== repair_lease_token) return false;
    await db.outbox.delete(outbox_id);
    return true;
  });
}

/** Delete the row only while we still own it. See `commitOutboxTransition`. */
export async function deleteOutboxEntryIfOwner(
  db: CacheDB,
  outbox_id: string,
  lease_token: string,
): Promise<boolean> {
  return db.transaction('rw', db.outbox, async () => {
    const row = await db.outbox.get(outbox_id);
    if (row === undefined || row.lease_token !== lease_token) return false;
    await db.outbox.delete(outbox_id);
    return true;
  });
}
