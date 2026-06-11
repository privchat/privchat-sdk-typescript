// Phase 5C-1c outbox engine. Drives `flushOutbox` + retry/backoff +
// per-channel FIFO + ACK swap. See `docs/PHASE5C_OUTBOUND_QUEUE_PLAN.md`
// for the full state machine, decisions, and merge invariants.
//
// Boundaries:
//   - This file is engine-only. Reconnect wiring (5C-1d), observers /
//     L1 events (5C-1e), and the phase14 E2E (5C-1f) live elsewhere.
//   - The engine never gates on its own connection knowledge — it asks
//     `getConnectionState()` per row. A `flushOutbox` call while the
//     client is offline or mid-reconnect resolves with `skipped > 0`
//     and `attempted = 0`, leaving rows untouched.
//   - Per-channel mutex via `Map<channelKey, Promise<void>>`. Identical
//     pattern to the sync engine. Same-channel sends ship in
//     `created_at` order; cross-channel sends fan out in parallel.
//   - Frozen rows (rejected, or transient with `attempt_count >=
//     maxAttempts`) carry `next_attempt_at = Number.MAX_SAFE_INTEGER`.
//     `listDueOutboxEntries` excludes them; only `retryOutboxEntry`
//     (5C-1e) reactivates them.

import {
  CacheDB,
  MessageStore,
  deleteMessageByRecordKey as cacheDeleteMessageByRecordKey,
  deleteOutboxEntry,
  listDueOutboxEntries,
  messageRecordKey,
  updateOutboxStatus,
  upsertMessage as cacheUpsertMessage,
  type MessageRecord,
  type OutboxEntry,
} from './cache/index.js';
import type { SendMessageRequest, SendMessageResponse } from './codec/send.js';
import type { ConnectionState, OutboxStateChangedEvent } from './events.js';
import { contentTypeToWireTag } from './content-type.js';

// ----- Public API -----

export interface OutboxFlushOptions {
  /** Restrict the flush to one channel. Default: all. */
  channel_id?: string;
  /** Restrict the flush to one channel_type (paired with channel_id
   *  for full disambiguation; passed alone, narrows by type only). */
  channel_type?: number;
  /** Cap on rows attempted in this flush pass. Excess rows stay due
   *  for the next flush. */
  limit?: number;
}

export interface OutboxFlushResult {
  /** Rows that the engine actively tried to send (transitioned through
   *  `sending`). Excludes rows skipped due to offline state. */
  attempted: number;
  /** Rows that ACKed and were deleted. */
  sent: number;
  /** Rows whose attempt failed (transient or rejected). */
  failed: number;
  /** Rows that were due but skipped because the client wasn't
   *  authenticated. Will retry on the next flush. */
  skipped: number;
  /** Total outbox row count after the flush settles. Includes frozen
   *  rows (max-attempts / rejected). */
  remaining: number;
}

export interface OutboxEngineConfig {
  /** First retry delay in ms after a transient failure. Default 1000. */
  initialDelayMs?: number;
  /** Maximum retry delay in ms after exponential growth. Default 30_000. */
  maxDelayMs?: number;
  /** Cap on transient retries. After this count the row freezes
   *  (`next_attempt_at = MAX_SAFE_INTEGER`) and only `retryOutboxEntry`
   *  reactivates it. Default 8. */
  maxAttempts?: number;
}

/**
 * Decoupling seam between the engine and the L1 event bus / observer
 * registry. The engine never imports `EventBus`; the host (PrivchatClient)
 * adapts these synchronous hooks into bus emits + snapshot
 * notifications.
 */
export interface OutboxEngineHooks {
  /** Fired on every persisted state transition: `sending`, `sent`
   *  (after row delete), `failed`. The host turns this into both an
   *  L1 `outbox_state_changed` emit AND a snapshot push to
   *  `observeOutbox` listeners. */
  onStateChanged?: (event: OutboxStateChangedEvent) => void;
}

export interface OutboxEngineDeps {
  db: CacheDB;
  store: MessageStore;
  /** Direct send. Throws on transport failure / RPC timeout (the
   *  Layer-1 sendMessage contract — NOT the queued sendTextMessage
   *  shape). */
  sendMessage: (req: SendMessageRequest) => Promise<SendMessageResponse>;
  /** Read the current connection state. Engine consults this per row
   *  before attempting a network operation. */
  getConnectionState: () => ConnectionState;
  /** Wall-clock provider — injectable for deterministic backoff tests. */
  now?: () => number;
  config?: OutboxEngineConfig;
  /** Logger sink. Defaults to console.warn. */
  warn?: (msg: string, ctx?: Record<string, unknown>) => void;
  /** Optional event hooks. Sync — host adapter is responsible for
   *  any further async fanout. */
  hooks?: OutboxEngineHooks;
}

const DEFAULT_INITIAL_DELAY_MS = 1_000;
const DEFAULT_MAX_DELAY_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 8;

/** Row freezes with this `next_attempt_at` — far enough in the future
 *  that no realistic `Date.now()` can mark it due. IndexedDB stores it
 *  fine; `BigInt`-aware comparators do not apply (we compare via
 *  number indexes). */
export const FROZEN_NEXT_ATTEMPT_AT = Number.MAX_SAFE_INTEGER;

// ----- Engine -----

export class OutboxEngine {
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly db: CacheDB;
  private readonly store: MessageStore;
  private readonly sendMessage: (req: SendMessageRequest) => Promise<SendMessageResponse>;
  private readonly getConnectionState: () => ConnectionState;
  private readonly now: () => number;
  private readonly initialDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly maxAttempts: number;
  private readonly warn: (msg: string, ctx?: Record<string, unknown>) => void;
  private readonly hooks: OutboxEngineHooks;

  constructor(deps: OutboxEngineDeps) {
    this.db = deps.db;
    this.store = deps.store;
    this.sendMessage = deps.sendMessage;
    this.getConnectionState = deps.getConnectionState;
    this.now = deps.now ?? (() => Date.now());
    this.initialDelayMs = deps.config?.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
    this.maxDelayMs = deps.config?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
    this.maxAttempts = deps.config?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.warn =
      deps.warn ??
      ((msg, ctx) => {
        // eslint-disable-next-line no-console
        console.warn(`[privchat:outbox] ${msg}`, ctx ?? {});
      });
    this.hooks = deps.hooks ?? {};
  }

  /**
   * Drain due rows. One pass: pick everything currently eligible,
   * group by channel, run channels in parallel (with per-channel
   * mutex serialising same-channel sends). Returns when every row
   * picked up by this call has settled (success / failure / skipped).
   *
   * Rows added DURING the flush (e.g. by a concurrent
   * `sendTextMessage`) are NOT picked up — they wait for the next
   * `flushOutbox` call. This keeps the contract simple and avoids
   * unbounded loop-while-not-empty behaviour.
   */
  async flushOutbox(options: OutboxFlushOptions = {}): Promise<OutboxFlushResult> {
    const startNow = this.now();
    let due = await listDueOutboxEntries(this.db, startNow);

    if (options.channel_id !== undefined) {
      due = due.filter(
        (e) =>
          e.channel_id === options.channel_id &&
          (options.channel_type === undefined || e.channel_type === options.channel_type),
      );
    } else if (options.channel_type !== undefined) {
      due = due.filter((e) => e.channel_type === options.channel_type);
    }

    if (options.limit !== undefined) {
      due = due.slice(0, options.limit);
    }

    const counters = { attempted: 0, sent: 0, failed: 0, skipped: 0 };

    if (due.length === 0) {
      const remaining = await this.db.outbox.count();
      return { ...counters, remaining };
    }

    // Group by channel for per-channel FIFO. Cross-channel runs in
    // parallel via `Promise.all`.
    const byChannel = new Map<string, OutboxEntry[]>();
    for (const row of due) {
      const key = mutexKey(row.channel_id, row.channel_type);
      const arr = byChannel.get(key) ?? [];
      arr.push(row);
      byChannel.set(key, arr);
    }

    await Promise.all(
      [...byChannel.entries()].map(([key, rows]) =>
        this.processChannel(key, rows, counters),
      ),
    );

    const remaining = await this.db.outbox.count();
    return { ...counters, remaining };
  }

  // ----- Internal -----

  /**
   * Per-channel serialised loop. If a flush is already in flight for
   * this channel, we chain: wait for it to finish, then run our rows.
   * The map slot is freed only by the LAST work item registered for
   * a given channel, so a queued chain doesn't accidentally clear
   * a successor's mutex.
   */
  private async processChannel(
    key: string,
    rows: OutboxEntry[],
    counters: { attempted: number; sent: number; failed: number; skipped: number },
  ): Promise<void> {
    const prior = this.inFlight.get(key);
    const work = (async () => {
      if (prior) {
        await prior.catch(() => {
          /* swallow — prior failures must not poison this work */
        });
      }
      for (const row of rows) {
        await this.processRow(row, counters);
      }
    })();
    this.inFlight.set(key, work);
    try {
      await work;
    } finally {
      // Release the slot only if our work is still the registered one.
      // A later `processChannel` call for the same key will have
      // overwritten it; that work owns the slot now.
      if (this.inFlight.get(key) === work) {
        this.inFlight.delete(key);
      }
    }
  }

  private async processRow(
    entry: OutboxEntry,
    counters: { attempted: number; sent: number; failed: number; skipped: number },
  ): Promise<void> {
    if (this.getConnectionState() !== 'authenticated') {
      counters.skipped += 1;
      return;
    }

    counters.attempted += 1;

    // Mark as `sending` so a concurrent flush (or future cold-start
    // sweep) can recognise the in-flight state. listDueOutboxEntries
    // already filters out `sending`, so a parallel pass won't double-
    // attempt the row.
    await updateOutboxStatus(this.db, entry.outbox_id, {
      status: 'sending',
      updated_at: this.now(),
    });
    this.emit({ ...identityOf(entry), status: 'sending' });

    const req = this.buildRequest(entry);

    let resp: SendMessageResponse;
    try {
      resp = await this.sendMessage(req);
    } catch (e) {
      const lastError = await this.handleTransient(entry, e);
      this.emit({ ...identityOf(entry), status: 'failed', last_error: lastError });
      counters.failed += 1;
      return;
    }

    if (resp.reason_code !== 0) {
      const lastError = await this.handleRejected(entry, resp.reason_code);
      this.emit({ ...identityOf(entry), status: 'failed', last_error: lastError });
      counters.failed += 1;
      return;
    }

    await this.applyAck(entry, resp);
    this.emit({
      ...identityOf(entry),
      status: 'sent',
      server_message_id: resp.server_message_id,
    });
    counters.sent += 1;
  }

  private buildRequest(entry: OutboxEntry): SendMessageRequest {
    return {
      setting: { need_receipt: false, signal: 0 },
      client_seq: 0,
      local_message_id: entry.local_message_id,
      stream_no: '',
      channel_id: entry.channel_id,
      message_type: contentTypeToWireTag(entry.content_type),
      expire: 0,
      from_uid: entry.from_uid,
      topic: '',
      payload: entry.payload,
    };
  }

  /** Returns the `last_error` string written to the row (for the
   *  state-changed event payload). */
  private async handleTransient(entry: OutboxEntry, error: unknown): Promise<string> {
    const newAttempts = entry.attempt_count + 1;
    let next_attempt_at: number;
    let last_error: string;
    if (newAttempts >= this.maxAttempts) {
      next_attempt_at = FROZEN_NEXT_ATTEMPT_AT;
      last_error = `transient: max attempts (${this.maxAttempts}) exceeded: ${formatErr(error)}`;
      this.warn('outbox row exhausted retries', {
        outbox_id: entry.outbox_id,
        attempt_count: newAttempts,
        last_error,
      });
    } else {
      const delay = Math.min(
        this.initialDelayMs * Math.pow(2, entry.attempt_count),
        this.maxDelayMs,
      );
      next_attempt_at = this.now() + delay;
      last_error = `transient: ${formatErr(error)}`;
    }
    await updateOutboxStatus(this.db, entry.outbox_id, {
      status: 'failed',
      attempt_count: newAttempts,
      next_attempt_at,
      last_error,
      updated_at: this.now(),
    });
    return last_error;
  }

  private async handleRejected(entry: OutboxEntry, code: number): Promise<string> {
    const last_error = `rejected: code=${code}`;
    await updateOutboxStatus(this.db, entry.outbox_id, {
      status: 'failed',
      attempt_count: entry.attempt_count + 1,
      next_attempt_at: FROZEN_NEXT_ATTEMPT_AT,
      last_error,
      updated_at: this.now(),
    });
    return last_error;
  }

  private emit(
    partial: Omit<OutboxStateChangedEvent, 'type'>,
  ): void {
    const event: OutboxStateChangedEvent = { type: 'outbox_state_changed', ...partial };
    try {
      this.hooks.onStateChanged?.(event);
    } catch (e) {
      this.warn('onStateChanged hook threw', { error: formatErr(e) });
    }
  }

  /**
   * Successful ACK: swap the cache `pending` row for a `sent` row and
   * delete the outbox row. Mirrors the inline path in
   * `sendTextMessage`'s online-success branch — same memory + IDB
   * sequence, just sourced from the persisted outbox entry instead of
   * the live request.
   */
  private async applyAck(entry: OutboxEntry, resp: SendMessageResponse): Promise<void> {
    const pendingKey = entry.record_key;
    const pendingRec = this.resolvePending(entry);
    const acked: MessageRecord = {
      ...pendingRec,
      server_message_id: resp.server_message_id,
      local_message_id: entry.local_message_id,
      pts: String(resp.message_seq),
      status: 'sent',
    };

    // Memory: pending → sent. Patches carry removed=[oldKey] when the
    // record_key changes (always the case here: l: → s:).
    this.store.replaceMessage(
      entry.channel_id,
      entry.channel_type,
      pendingKey,
      acked,
      false,
    );

    // IDB: single rw transaction across messages + outbox so a tab
    // refresh can't observe a half-applied ACK.
    await this.db
      .transaction('rw', this.db.messages, this.db.outbox, async () => {
        await cacheDeleteMessageByRecordKey(
          this.db,
          entry.channel_id,
          entry.channel_type,
          pendingKey,
        );
        await cacheUpsertMessage(this.db, acked);
        await deleteOutboxEntry(this.db, entry.outbox_id);
      })
      .catch((e) => {
        this.warn('applyAck IDB tx failed', {
          outbox_id: entry.outbox_id,
          error: formatErr(e),
        });
      });
  }

  /**
   * Pull the pending MessageRecord out of memory if it's still there,
   * else reconstruct from the outbox row. Reconstruction only happens
   * on cold-start paths (5C-1f) where the in-process MessageStore is
   * fresh; for in-session flushes the memory hit is the common case.
   */
  private resolvePending(entry: OutboxEntry): MessageRecord {
    const memHit = this.store
      .getMessages(entry.channel_id, entry.channel_type)
      .find((m) => messageRecordKey(m) === entry.record_key);
    if (memHit) return memHit;
    return {
      channel_id: entry.channel_id,
      channel_type: entry.channel_type,
      local_message_id: entry.local_message_id,
      from_uid: entry.from_uid,
      // Cache rows store the word form directly; the wire tag is only
      // materialised in buildRequest.
      message_type: entry.content_type,
      content: new TextDecoder().decode(entry.payload),
      payload: entry.payload,
      timestamp: entry.created_at,
      status: 'pending',
    };
  }
}

// ----- Helpers -----

function mutexKey(channel_id: string, _channel_type: number): string {
  // Conversation identity is the channel_id alone; see message-store.ts.
  return channel_id;
}

/** Pull the identity fields out of an outbox entry into the shape the
 *  state-changed event expects. Saves boilerplate at every emit site. */
function identityOf(entry: OutboxEntry): {
  outbox_id: string;
  local_message_id: string;
  channel_id: string;
  channel_type: number;
} {
  return {
    outbox_id: entry.outbox_id,
    local_message_id: entry.local_message_id,
    channel_id: entry.channel_id,
    channel_type: entry.channel_type,
  };
}

/** Application content type string → wire MessageType numeric tag.
 *  5C-1c only handles `'text'`; future content types extend this. */
function formatErr(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return String(e);
}
