// In-memory profile cache for users + groups. Sits between IndexedDB
// (persistent, slow) and the SDK's user-facing observers (sync, fast).
//
// Mirrors `MessageStore`'s pattern: a Map keyed by entity id + a Set of
// snapshot listeners. Records are upserted in batch (entity sync pages
// land in groups), observers fire synchronously after every batch.
//
// IndexedDB I/O does NOT live here — the cache layer (PrivchatClient
// methods) drives both stores in parallel.

import type { FriendshipRecord, GroupRecord, UserRecord } from './types.js';

type Listener<T> = (snapshot: T[]) => void;

/**
 * Generic profile store for record-shaped entities keyed by a single
 * string id. Used for both users and groups; the type parameter
 * enforces id lookup.
 */
class ProfileStore<T extends { sync_version: number }> {
  private readonly records = new Map<string, T>();
  private readonly listeners = new Set<Listener<T>>();

  constructor(private readonly idOf: (record: T) => string) {}

  upsert(record: T): void {
    this.records.set(this.idOf(record), record);
    this.notify();
  }

  upsertMany(records: T[]): void {
    if (records.length === 0) return;
    for (const r of records) {
      this.records.set(this.idOf(r), r);
    }
    this.notify();
  }

  /**
   * Bulk apply: upsert one set of rows AND delete another set of ids
   * (tombstones) in a single observer fire. Used by entity-sync paths
   * where a server page mixes accepted rows + deletions; emitting once
   * keeps consumers from seeing intermediate states.
   */
  applyDelta(upserted: T[], deletedIds: string[]): void {
    if (upserted.length === 0 && deletedIds.length === 0) return;
    let mutated = false;
    for (const r of upserted) {
      this.records.set(this.idOf(r), r);
      mutated = true;
    }
    for (const id of deletedIds) {
      if (this.records.delete(id)) mutated = true;
    }
    if (mutated) this.notify();
  }

  /** Remove a single record by id. Idempotent (missing id is a no-op). */
  remove(id: string): void {
    if (this.records.delete(id)) this.notify();
  }

  get(id: string): T | undefined {
    return this.records.get(id);
  }

  /** Highest sync_version observed in memory. Useful for choosing
   *  `since_version` when the caller wants incremental sync without
   *  hitting IndexedDB. */
  maxSyncVersion(): number {
    let max = 0;
    for (const r of this.records.values()) {
      if (r.sync_version > max) max = r.sync_version;
    }
    return max;
  }

  list(): T[] {
    return [...this.records.values()];
  }

  size(): number {
    return this.records.size;
  }

  /** Subscribe to bulk snapshot emissions. Caller receives the full
   *  list on every change — entity-list UIs typically prefer this over
   *  per-row deltas. */
  observe(cb: Listener<T>): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  /** Drop everything (logout / clear_local_state). Notifies observers
   *  with an empty snapshot. */
  clear(): void {
    if (this.records.size === 0 && this.listeners.size === 0) return;
    this.records.clear();
    this.notify();
  }

  private notify(): void {
    if (this.listeners.size === 0) return;
    const snapshot = this.list();
    for (const cb of [...this.listeners]) {
      try {
        cb(snapshot);
      } catch {
        /* listener errors must not break the emit loop */
      }
    }
  }
}

export class UserStore extends ProfileStore<UserRecord> {
  constructor() {
    super((r) => r.user_id);
  }
}

export class GroupStore extends ProfileStore<GroupRecord> {
  constructor() {
    super((r) => r.group_id);
  }
}

export class FriendshipStore extends ProfileStore<FriendshipRecord> {
  constructor() {
    super((r) => r.user_id);
  }
}
