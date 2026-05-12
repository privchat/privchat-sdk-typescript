// In-memory channel + message store with observer fan-out. Sits between
// IndexedDB (persistent, slow) and the SDK's user-facing observers (sync,
// fast). The store owns:
//   - per-channel sorted message buffer (ascending by timestamp)
//   - per-channel observer registry
//   - dedup by record_key (server_message_id || local_message_id)
//   - patch synthesis (`upserted` + `removed` listing record_keys)
//
// IndexedDB I/O does NOT live here — the cache layer (PrivchatClient
// methods) drives it. The store is pure in-memory state that fires
// observers synchronously.

import {
  messageRecordKey,
  type ChannelRecord,
  type ConversationPatch,
  type ConversationSnapshot,
  type MessageRecord,
} from './types.js';

// Conversation identity is the channel_id alone. `channel_type` is an
// attribute of the channel (used by UI to pick "direct settings vs group
// settings", to render avatars, to gate group-specific menus, etc.) but it
// MUST NOT participate in conversation deduplication.
//
// Earlier the key was `${channel_id}::${channel_type}` — that allowed two
// records with the same channel_id but different channel_type to coexist as
// "two conversations". That was a bug: an IM gateway is the source of truth
// for what a channel is, and a single channel_id is supposed to identify a
// single chat. If the gateway ever returns conflicting types for the same
// channel_id, the store overwrites with the latest record and surfaces a
// console warning so the bug is visible at the right layer.
type ChannelKey = string; // = channel_id

const channelKey = (channel_id: string): ChannelKey => channel_id;

type ConversationListener = (
  snapshot: ConversationSnapshot,
  patch: ConversationPatch,
) => void;

export class MessageStore {
  private readonly channels = new Map<ChannelKey, ChannelRecord>();
  private readonly buffers = new Map<ChannelKey, MessageRecord[]>();
  private readonly listeners = new Map<ChannelKey, Set<ConversationListener>>();
  private readonly channelListListeners = new Set<(channels: ChannelRecord[]) => void>();

  // ----- Channel state -----

  upsertChannel(record: ChannelRecord): void {
    const k = channelKey(record.channel_id);
    const prev = this.channels.get(k);
    if (prev !== undefined && prev.channel_type !== record.channel_type) {
      // The gateway is supposed to be authoritative for channel identity.
      // If the same channel_id flips channel_type between two records,
      // surface the inconsistency at the boundary instead of silently
      // letting it fan out into duplicate UI rows.
      console.warn(
        `[privchat] channel_type drift for channel_id=${record.channel_id}: ` +
          `${prev.channel_type} → ${record.channel_type}. ` +
          `Overwriting with the latest record. This usually indicates a server bug.`,
      );
    }
    this.channels.set(k, record);
    this.notifyChannelList();
  }

  upsertChannels(records: ChannelRecord[]): void {
    if (records.length === 0) return;
    let changed = false;
    for (const r of records) {
      const k = channelKey(r.channel_id);
      const prev = this.channels.get(k);
      if (prev !== undefined && prev.channel_type !== r.channel_type) {
        console.warn(
          `[privchat] channel_type drift for channel_id=${r.channel_id}: ` +
            `${prev.channel_type} → ${r.channel_type}. ` +
            `Overwriting with the latest record. This usually indicates a server bug.`,
        );
      }
      this.channels.set(k, r);
      changed = true;
    }
    if (changed) this.notifyChannelList();
  }

  /**
   * Look up a channel by its identity. `channel_type` is no longer part of
   * the key; the optional second argument is retained for API compatibility
   * with R0 callers and for runtime asserts on consumers that still pass it.
   */
  getChannel(channel_id: string, _channel_type?: number): ChannelRecord | undefined {
    return this.channels.get(channelKey(channel_id));
  }

  /** Sorted by `updated_at` desc — channel-list view ordering. */
  listChannels(): ChannelRecord[] {
    return [...this.channels.values()].sort((a, b) => b.updated_at - a.updated_at);
  }

  observeChannelList(cb: (channels: ChannelRecord[]) => void): () => void {
    this.channelListListeners.add(cb);
    return () => {
      this.channelListListeners.delete(cb);
    };
  }

  // ----- Message buffer -----

  /**
   * Replace the buffer with the given messages. Used when a fresh
   * remote fetch arrives — we trust the server's window completely.
   * Existing pending/local-echo records OUTSIDE that timestamp range
   * (typically newer-than-window) are preserved.
   */
  replaceWindow(
    channel_id: string,
    channel_type: number,
    records: MessageRecord[],
    is_remote: boolean,
  ): void {
    const k = channelKey(channel_id);
    const sorted = [...records].sort(compareTimestamp);
    const existing = this.buffers.get(k) ?? [];

    if (sorted.length === 0) {
      // Nothing to replace; existing buffer untouched.
      return;
    }

    const minTs = sorted[0]!.timestamp;
    const maxTs = sorted[sorted.length - 1]!.timestamp;
    const outsideRange = existing.filter(
      (m) => m.timestamp < minTs || m.timestamp > maxTs,
    );

    const merged = mergeByKey(outsideRange, sorted);
    this.buffers.set(k, merged);

    const oldKeys = new Set(existing.map(messageRecordKey));
    const newKeys = new Set(merged.map(messageRecordKey));
    const upserted = merged.filter((m) => !oldKeys.has(messageRecordKey(m)));
    const removed = [...oldKeys].filter((key) => !newKeys.has(key));
    this.notify(channel_id, channel_type, merged, { upserted, removed, is_remote });
  }

  /**
   * Insert or update a single record. Dedupes by record_key. Emits
   * a patch with just the affected record.
   */
  upsertMessage(record: MessageRecord, is_remote: boolean): void {
    this.upsertMessages(record.channel_id, record.channel_type, [record], is_remote);
  }

  upsertMessages(
    channel_id: string,
    channel_type: number,
    records: MessageRecord[],
    is_remote: boolean,
  ): void {
    if (records.length === 0) return;
    const k = channelKey(channel_id);
    const existing = this.buffers.get(k) ?? [];
    const byKey = new Map(existing.map((m) => [messageRecordKey(m), m]));
    const upserted: MessageRecord[] = [];
    for (const r of records) {
      const key = messageRecordKey(r);
      const prev = byKey.get(key);
      byKey.set(key, r);
      if (!prev || !messageEquals(prev, r)) upserted.push(r);
    }
    if (upserted.length === 0) return;
    const merged = [...byKey.values()].sort(compareTimestamp);
    this.buffers.set(k, merged);
    this.notify(channel_id, channel_type, merged, { upserted, removed: [], is_remote });
  }

  /**
   * Replace one record by its current record_key. If the new record
   * resolves to a DIFFERENT record_key (typical for local-echo ACK:
   * pending row keyed by local_message_id → sent row keyed by
   * server_message_id), the old key is included in the patch's
   * `removed` list so observers can drop the stale entry.
   */
  replaceMessage(
    channel_id: string,
    channel_type: number,
    oldRecordKey: string,
    next: MessageRecord,
    is_remote: boolean,
  ): void {
    const k = channelKey(channel_id);
    const existing = this.buffers.get(k) ?? [];
    const newKey = messageRecordKey(next);
    // Filter both keys: drop the pending row (oldRecordKey) AND any row
    // that already carries the new identity (newKey). The latter handles
    // the race where a self-push for our own message arrived BEFORE the
    // ACK swap — without this dedup the buffer would end up with two
    // rows for the same logical message (the push's stale receive +
    // the engine's authoritative sent).
    const filtered = existing.filter((m) => {
      const key = messageRecordKey(m);
      return key !== oldRecordKey && key !== newKey;
    });
    const merged = [...filtered, next].sort(compareTimestamp);
    this.buffers.set(k, merged);
    const removed = oldRecordKey !== newKey ? [oldRecordKey] : [];
    this.notify(channel_id, channel_type, merged, { upserted: [next], removed, is_remote });
  }

  removeMessage(
    channel_id: string,
    channel_type: number,
    recordKey: string,
  ): void {
    const k = channelKey(channel_id);
    const existing = this.buffers.get(k) ?? [];
    const next = existing.filter((m) => messageRecordKey(m) !== recordKey);
    if (next.length === existing.length) return;
    this.buffers.set(k, next);
    this.notify(channel_id, channel_type, next, {
      upserted: [],
      removed: [recordKey],
      is_remote: true,
    });
  }

  /**
   * Drop the entire in-memory buffer for one (channel_id, channel_type).
   * Emits a single patch listing every removed record_key. Used by the
   * sync engine's 20900-resync path; not exposed publicly.
   */
  clearBuffer(channel_id: string, channel_type: number): void {
    const k = channelKey(channel_id);
    const existing = this.buffers.get(k);
    if (!existing || existing.length === 0) return;
    const removed = existing.map(messageRecordKey);
    this.buffers.delete(k);
    this.notify(channel_id, channel_type, [], {
      upserted: [],
      removed,
      is_remote: true,
    });
  }

  /**
   * Sync read access. Sorted ascending by timestamp.
   */
  getMessages(channel_id: string, _channel_type?: number): MessageRecord[] {
    return this.buffers.get(channelKey(channel_id)) ?? [];
  }

  // ----- Observer wiring -----

  observeConversation(
    channel_id: string,
    _channel_type: number,
    cb: ConversationListener,
  ): () => void {
    const k = channelKey(channel_id);
    let set = this.listeners.get(k);
    if (!set) {
      set = new Set();
      this.listeners.set(k, set);
    }
    set.add(cb);
    return () => {
      const s = this.listeners.get(k);
      if (!s) return;
      s.delete(cb);
      if (s.size === 0) this.listeners.delete(k);
    };
  }

  /** Observer count for a given conversation — useful for tests. */
  listenerCount(channel_id: string, _channel_type?: number): number {
    return this.listeners.get(channelKey(channel_id))?.size ?? 0;
  }

  // ----- Wipe (logout / clear_local_state) -----

  clear(): void {
    this.channels.clear();
    this.buffers.clear();
    this.notifyChannelList();
  }

  // ----- Internal -----

  private notify(
    channel_id: string,
    channel_type: number,
    messages: MessageRecord[],
    patchPartial: Omit<ConversationPatch, 'channel_id' | 'channel_type'>,
  ): void {
    const k = channelKey(channel_id);
    const listeners = this.listeners.get(k);
    if (!listeners || listeners.size === 0) return;
    const snapshot: ConversationSnapshot = {
      channel_id,
      channel_type,
      messages,
      is_remote: patchPartial.is_remote,
    };
    const patch: ConversationPatch = { channel_id, channel_type, ...patchPartial };
    for (const cb of [...listeners]) {
      try {
        cb(snapshot, patch);
      } catch {
        /* listener errors must not break the emit loop */
      }
    }
  }

  private notifyChannelList(): void {
    if (this.channelListListeners.size === 0) return;
    const snapshot = this.listChannels();
    for (const cb of [...this.channelListListeners]) {
      try {
        cb(snapshot);
      } catch {
        /* swallow */
      }
    }
  }
}

// ----- Sort + merge helpers -----

function compareTimestamp(a: MessageRecord, b: MessageRecord): number {
  if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
  // Tie-breaker on record_key for stable order under identical timestamps.
  return messageRecordKey(a).localeCompare(messageRecordKey(b));
}

function mergeByKey(a: MessageRecord[], b: MessageRecord[]): MessageRecord[] {
  const byKey = new Map<string, MessageRecord>();
  for (const m of a) byKey.set(messageRecordKey(m), m);
  for (const m of b) byKey.set(messageRecordKey(m), m); // b wins on collision
  return [...byKey.values()].sort(compareTimestamp);
}

function messageEquals(a: MessageRecord, b: MessageRecord): boolean {
  return (
    a.server_message_id === b.server_message_id &&
    a.local_message_id === b.local_message_id &&
    a.pts === b.pts &&
    a.from_uid === b.from_uid &&
    a.message_type === b.message_type &&
    a.content === b.content &&
    a.timestamp === b.timestamp &&
    a.status === b.status &&
    a.revoked === b.revoked &&
    bytesEqual(a.payload, b.payload)
  );
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
