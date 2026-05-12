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
 * Mutable fields only: status, attempt_count, next_attempt_at,
 * last_error, updated_at, record_key. Immutable identity fields
 * (outbox_id, channel_id/type, local_message_id, from_uid,
 * content_type, payload, created_at) intentionally cannot be patched
 * here — to change those, delete and re-put.
 */
export async function updateOutboxStatus(
  db: CacheDB,
  outbox_id: string,
  patch: {
    status?: OutboxStatus;
    attempt_count?: number;
    next_attempt_at?: number;
    last_error?: string | null;
    record_key?: string;
    updated_at?: number;
  },
): Promise<OutboxEntry | undefined> {
  const existing = await db.outbox.get(outbox_id);
  if (!existing) return undefined;
  const next: OutboxEntry = { ...existing };
  if (patch.status !== undefined) next.status = patch.status;
  if (patch.attempt_count !== undefined) next.attempt_count = patch.attempt_count;
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
 * Rows whose `next_attempt_at <= now` AND whose status is `pending` or
 * `failed` (i.e. eligible for an immediate send attempt). Excludes
 * `sending` rows — those have an in-flight attempt already and would
 * double-send if picked up.
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
    .filter((r) => r.status === 'pending' || r.status === 'failed')
    .sort((a, b) => a.created_at - b.created_at);
}
