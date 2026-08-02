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

import { decodeMessagePayloadEnvelope } from './codec/payload.js';
import {
  decodeRebuildableContent,
  isRebuildableFromPayload,
} from './cache/rebuild.js';
import {
  CacheDB,
  MessageStore,
  claimOutboxEntry,
  claimRepairRow,
  commitOutboxTransition,
  commitRepairTransition,
  deleteOutboxEntryIfOwner,
  deleteOutboxEntryIfRepairOwner,
  deleteOutboxEntry,
  listDueOutboxEntries,
  applyAck as cacheApplyAck,
  ProjectionRehydrateRequiredError,
  nextLocalMessageRecordId,
  updateOutboxStatus,
  upsertMessage as cacheUpsertMessage,
  type MessageRecord,
  type OutboxEntry,
} from './cache/index.js';
import type { SendMessageRequest, SendMessageResponse } from './codec/send.js';
import type { ConnectionState, OutboxStateChangedEvent } from './events.js';
import { contentTypeToWireTag } from './content-type.js';
import { isRetryableServerCode } from './send-error.js';

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
  /** How long a `sending` claim stays valid. After this the row is
   *  reclaimable, which is what unsticks an attempt whose process died.
   *  Must comfortably exceed a realistic send round-trip. Default 60s. */
  leaseMs?: number;
  /** Cap on one send round-trip. MUST stay below `leaseMs`, so an attempt
   *  gives up before its own lease can be reclaimed under it. Default 30s. */
  sendTimeoutMs?: number;
  /** Repair passes an `integrity_error` row gets before it is declared
   *  `local_data_error`. Default 3. */
  maxRepairAttempts?: number;
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
  /**
   * The local cache is inconsistent in a way retrying cannot fix.
   *
   * The host is expected to attempt repair (resync the channel, and if
   * that does not clear it, rebuild the cache) and to report the fault —
   * this is a corrupted database or a broken migration, not a hiccup.
   * Without it the row would sit in `integrity_error` and the UI would
   * show "syncing" forever, which is a worse lie than an error.
   */
  onIntegrityFault?: (fault: OutboxIntegrityFault) => void | Promise<void>;
}

/** Context for [`OutboxEngineHooks.onIntegrityFault`]. */
export interface OutboxIntegrityFault {
  outbox_id: string;
  local_message_id: string;
  channel_id: string;
  channel_type: number;
  /** The message IS on the server — recovery must not re-send it. */
  server_message_id: string;
  /** Which repair this fault needs. The host must branch on it: a
   *  `identity_conflict` is resolved by re-syncing the channel so the
   *  contested id can be re-minted; a `message_rehydrate` means our row is
   *  simply gone, and a channel sync will NOT bring it back once
   *  `latest_pts` has passed it — it needs a targeted fetch anchored on
   *  `server_message_id`, and must not re-mint. */
  repair_kind?: 'identity_conflict' | 'message_rehydrate';
  /** Local row id that could not be reconciled. */
  conflicting_id?: string;
  /** Channel holding the row that already owns that id. Reported for
   *  diagnosis only — repair must never delete it. */
  conflicting_channel_id?: string;
  error: string;
  /** 1 on the first pass. Compare against the configured cap to know how
   *  close this row is to being declared unrecoverable. */
  repair_attempt?: number;
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
const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_SEND_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_REPAIR_ATTEMPTS = 3;

/** Opaque per-attempt owner id. Only ever compared for equality. */
function newLeaseToken(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

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
  private readonly leaseMs: number;
  private readonly sendTimeoutMs: number;
  private readonly maxRepairAttempts: number;
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
    this.leaseMs = deps.config?.leaseMs ?? DEFAULT_LEASE_MS;
    // Clamped, not merely warned about. The API says the timeout must be
    // shorter than the lease; honouring a configuration that breaks that
    // would let attempts routinely outlive their lease, and while fencing
    // keeps local state correct it cannot stop the redundant network sends
    // that follow.
    const requestedTimeout = deps.config?.sendTimeoutMs ?? DEFAULT_SEND_TIMEOUT_MS;
    this.sendTimeoutMs = Math.min(requestedTimeout, Math.floor(this.leaseMs / 2));
    this.maxRepairAttempts = deps.config?.maxRepairAttempts ?? DEFAULT_MAX_REPAIR_ATTEMPTS;
    this.warn =
      deps.warn ??
      ((msg, ctx) => {
        // eslint-disable-next-line no-console
        console.warn(`[privchat:outbox] ${msg}`, ctx ?? {});
      });
    this.hooks = deps.hooks ?? {};
    if (requestedTimeout !== this.sendTimeoutMs) {
      this.warn('sendTimeoutMs clamped to stay below leaseMs', {
        requested: requestedTimeout,
        applied: this.sendTimeoutMs,
        leaseMs: this.leaseMs,
      });
    }
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
    // Quarantined rows are never `due` — they are frozen — so repair has to
    // be driven by status. Running it here (and from `recoverLocalState`
    // at startup) is what makes it survive a reload: a fault reported once
    // via a hook and then forgotten leaves the row stuck forever if the
    // page dies before the host acts on it.
    await this.repairIntegrityRows();
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

  /**
   * Public entry for startup: converge everything that needs no network.
   *
   * Repairs quarantined rows and replays stored ACKs. Deliberately callable
   * before (and without) a connection — both states describe messages the
   * server already has.
   */
  async recoverLocalState(): Promise<void> {
    await this.repairIntegrityRows();
    const due = await listDueOutboxEntries(this.db, this.now());
    const counters = { attempted: 0, sent: 0, failed: 0, skipped: 0 };
    for (const entry of due) {
      if (entry.status === 'ack_pending') {
        await this.retryLocalCommit(entry, counters);
      }
    }
  }

  /**
   * Drive `integrity_error` rows to a real end state.
   *
   * The message is on the server; what is broken is this device's ability
   * to reconcile it. Each pass asks the host to repair the cache (resync,
   * rebuild) and then replays the stored ACK — the conflict may well be
   * gone afterwards, and the row converges to `sent` like any other.
   *
   * When repair keeps failing the row moves to `local_data_error`. That is
   * the honest end state: "delivered, and this device cannot show it
   * correctly". Leaving it in `integrity_error` would mean a permanent
   * "syncing" spinner for something that will never converge.
   */
  private async repairIntegrityRows(): Promise<void> {
    const rows = await this.db.outbox
      .filter((r) => r.status === 'integrity_error')
      .toArray();
    if (rows.length === 0) return;

    for (const row of rows) {
      const token = newLeaseToken();
      // Claim first — the counter lives inside the claim, so it measures
      // repairs actually performed rather than flushes that happened to
      // race. A row already being repaired, or still backing off, is left
      // alone.
      const entry = await claimRepairRow(
        this.db,
        row.outbox_id,
        token,
        this.now(),
        this.leaseMs,
      );
      if (entry === undefined) continue;
      const attempts = entry.repair_attempts ?? 1;

      const repaired = await this.attemptRepair(entry, attempts, token);
      if (repaired) continue;

      // Back off before the next pass, and give up only after the budget
      // is spent on real attempts.
      const delay = Math.min(
        this.initialDelayMs * Math.pow(2, attempts - 1),
        this.maxDelayMs,
      );
      if (attempts >= this.maxRepairAttempts) {
        const last_error = `local-data-error: repair failed ${attempts}x; ${entry.last_error ?? ''}`;
        const stored = await commitRepairTransition(this.db, entry.outbox_id, token, {
          status: 'local_data_error',
          repair_lease_until: 0,
          last_error,
          updated_at: this.now(),
        });
        if (stored) {
          this.emit({ ...identityOf(entry), status: 'local_data_error', last_error });
        }
      } else {
        await commitRepairTransition(this.db, entry.outbox_id, token, {
          repair_lease_until: 0,
          repair_next_attempt_at: this.now() + delay,
          updated_at: this.now(),
        });
      }
    }
  }

  /**
   * One repair pass. Returns whether the row converged.
   *
   * For an id collision the fix is to re-mint OUR row's local id, not to
   * delete whichever row currently holds it — that row belongs to another
   * conversation and may be perfectly valid; deleting it to free an
   * arbitrary number would destroy a real message. `id` means nothing
   * except "unique", so re-minting ours is lossless.
   *
   * The host hook still runs: some faults are database-level damage that
   * only a resync or rebuild can address, and it is also where telemetry
   * belongs. It is awaited, so a repair that needs the network completes
   * before the replay below.
   */
  private async attemptRepair(
    entry: OutboxEntry,
    attempt: number,
    repairToken: string,
  ): Promise<boolean> {
    try {
      await this.hooks.onIntegrityFault?.({
        outbox_id: entry.outbox_id,
        local_message_id: entry.local_message_id,
        channel_id: entry.channel_id,
        channel_type: entry.channel_type,
        server_message_id: entry.acked_server_message_id ?? '',
        conflicting_id: entry.conflicting_id,
        conflicting_channel_id: entry.conflicting_channel_id,
        error: entry.last_error ?? 'integrity fault',
        repair_kind: entry.repair_kind,
        repair_attempt: attempt,
      });
    } catch (e) {
      this.warn('onIntegrityFault hook threw', { error: formatErr(e) });
    }

    // No identity re-mint arm any more. Ids stopped moving when the message
    // store's primary key became the stable `id`, so there is nothing to
    // contest and nothing to re-mint: the only repair left is re-hydrating a
    // projection the server still has.
    const server_message_id = entry.acked_server_message_id;
    if (server_message_id === undefined) return false;
    try {
      const owned = await this.applyAck(
        entry,
        {
          client_seq: 0,
          server_message_id,
          message_seq: entry.acked_message_seq ?? 0,
          reason_code: 0,
        },
        { kind: 'repair', token: repairToken },
      );
      if (owned) {
        this.emit({ ...identityOf(entry), status: 'sent', server_message_id });
        return true;
      }
    } catch (e) {
      this.warn('integrity repair replay failed', {
        outbox_id: entry.outbox_id,
        repair_attempts: attempt,
        error: formatErr(e),
      });
    }
    return false;
  }

  private async processRow(
    entry: OutboxEntry,
    counters: { attempted: number; sent: number; failed: number; skipped: number },
  ): Promise<void> {
    // Already delivered, only the local commit outstanding: recover WITHOUT
    // touching the network. The server has this message; sending it again
    // would rely on server-side idempotency records that do not live
    // forever, and if one ever expired the user would see their message
    // twice. The ACK we already received is persisted on the row, so the
    // retry is purely local.
    //
    // Checked BEFORE the connection gate on purpose: this work needs no
    // network, so blocking it while offline would leave a delivered message
    // showing as unsettled until connectivity returns, for no reason. It is
    // likewise not counted as an `attempted` send — nothing is sent.
    if (entry.status === 'ack_pending') {
      await this.retryLocalCommit(entry, counters);
      return;
    }

    if (this.getConnectionState() !== 'authenticated') {
      counters.skipped += 1;
      return;
    }

    // Claim the row for this attempt. Compare-and-set inside one
    // transaction: if another tab already holds a live lease we back off
    // rather than send the same message twice. The lease also bounds the
    // `sending` state — a process that dies mid-send would otherwise strand
    // the row there forever, since the due query is the only way back and
    // it skips leased rows.
    const token = newLeaseToken();
    const claimed = await claimOutboxEntry(
      this.db,
      entry.outbox_id,
      token,
      this.now(),
      this.leaseMs,
    );
    if (claimed === undefined) {
      // Someone else owns this attempt, or the row moved to a state that
      // must not be re-sent (it is already delivered).
      counters.skipped += 1;
      return;
    }
    entry = claimed;

    counters.attempted += 1;
    this.emit({ ...identityOf(entry), status: 'sending' });

    const req = this.buildRequest(entry);

    let resp: SendMessageResponse;
    try {
      // Bounded by design, and the bound is shorter than the lease: a send
      // that outlives its own lease is exactly how two owners end up
      // writing the same row. The timeout does not make fencing optional —
      // a suspended tab can exceed any timeout — it just makes the overlap
      // rare instead of routine.
      resp = await this.sendWithTimeout(req);
    } catch (e) {
      const lastError = await this.handleTransient(entry, token, e);
      if (lastError === undefined) return; // lease lost; not ours to report
      this.emit({ ...identityOf(entry), status: 'failed', last_error: lastError });
      counters.failed += 1;
      return;
    }

    if (resp.reason_code !== 0) {
      // 非零码分两类（SDK_ARCHITECTURE_SPEC §11.3）：会自己好的（限流 / 数据库抖动 /
      // 服务重启窗口）走退避重试；终局拒绝才冻结等用户重发。此前一律冻结，于是
      // 一次服务重启就要求用户把窗口里的消息全部手动重发。
      const lastError = isRetryableServerCode(resp.reason_code)
        ? await this.handleTransient(
            entry,
            token,
            new Error(`server rejected: code=${resp.reason_code}`),
          )
        : await this.handleRejected(entry, token, resp.reason_code);
      if (lastError === undefined) return;
      this.emit({ ...identityOf(entry), status: 'failed', last_error: lastError });
      counters.failed += 1;
      return;
    }

    try {
      const owned = await this.applyAck(entry, resp, { kind: 'send', token });
      if (!owned) return; // another owner took over; it will converge
    } catch (e) {
      // The server took the message, but the local commit — cache rekey plus
      // the outbox-row delete — did not land. The row is therefore still in
      // the outbox, so reporting `sent` here would be a lie the next flush
      // immediately contradicts.
      await this.handleLocalCommitFailure(entry, resp, token, e, counters);
      return;
    }
    this.emit({
      ...identityOf(entry),
      status: 'sent',
      server_message_id: resp.server_message_id,
    });
    counters.sent += 1;
  }

  /**
   * Send, bounded by `sendTimeoutMs`.
   *
   * The bound exists so an attempt cannot routinely outlive its own lease
   * and end up writing over a successor's state. It is a mitigation, not a
   * guarantee — a suspended tab blows through any timeout — which is why
   * every terminal transition is fenced on the lease token regardless.
   */
  private async sendWithTimeout(req: SendMessageRequest): Promise<SendMessageResponse> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.sendMessage(req),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error(`send timed out after ${this.sendTimeoutMs}ms`)),
            this.sendTimeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
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

  /**
   * Returns the `last_error` written to the row, or `undefined` when the
   * lease was lost — meaning another attempt now owns this row and this
   * one must write nothing and publish nothing.
   */
  private async handleTransient(
    entry: OutboxEntry,
    token: string,
    error: unknown,
  ): Promise<string | undefined> {
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
    const owned = await commitOutboxTransition(this.db, entry.outbox_id, token, {
      status: 'failed',
      attempt_count: newAttempts,
      next_attempt_at,
      last_error,
      updated_at: this.now(),
    });
    if (!owned) {
      this.warn('lease lost before recording the failure; another attempt owns the row', {
        outbox_id: entry.outbox_id,
      });
      return undefined;
    }
    return last_error;
  }

  /**
   * The send succeeded but the local commit did not.
   *
   * Two outcomes, split by whether retrying can possibly help:
   *
   *   - **transient storage failure** → `ack_pending`. The server's ACK is
   *     persisted on the row, so recovery replays it locally and never
   *     goes back on the wire. Deliberately NOT `handleTransient`: that
   *     counter measures how many times the *server* refused the message
   *     and freezes the row when exhausted — spending it here would
   *     eventually freeze a message that was successfully delivered.
   *   - **[`ProjectionRehydrateRequiredError`]** → `integrity_error`. The
   *     row is gone and its payload cannot rebuild it. Retrying cannot fix
   *     that, so the row is quarantined: no network, no retry loop,
   *     reported for repair.
   */
  private async handleLocalCommitFailure(
    entry: OutboxEntry,
    resp: SendMessageResponse,
    token: string | undefined,
    error: unknown,
    counters: { failed: number },
  ): Promise<void> {
    /** Fenced write when this attempt holds a lease; plain write when the
     *  caller is the lease-free local recovery path. */
    const write = async (patch: Parameters<typeof updateOutboxStatus>[2]): Promise<boolean> => {
      if (token === undefined) {
        await updateOutboxStatus(this.db, entry.outbox_id, patch);
        return true;
      }
      return commitOutboxTransition(this.db, entry.outbox_id, token, patch);
    };
    const ackFields = {
      acked_server_message_id: resp.server_message_id,
      acked_message_seq: resp.message_seq,
    };

    if (error instanceof ProjectionRehydrateRequiredError) {
      // A local-cache fault on an already-delivered message: quarantine
      // rather than retry, because retrying re-sends something the server
      // already has. There is only one repair kind left — the row is gone
      // and has to come back from the server. Identity conflicts went away
      // with the moving primary key.
      const last_error = `integrity: ${formatErr(error)}`;
      this.warn('local cache integrity fault; message IS delivered, row quarantined', {
        outbox_id: entry.outbox_id,
        repair_kind: 'message_rehydrate',
        conflicting_id: error.message_id,
        conflicting_channel_id: error.conflicting_channel_id,
        last_error,
      });
      const stored = await write({
        status: 'integrity_error',
        ...ackFields,
        // Persist WHAT is broken, not just that something is: a repair pass
        // after a restart has only the row to go on.
        repair_kind: 'message_rehydrate',
        conflicting_id: error.message_id,
        conflicting_channel_id: error.conflicting_channel_id,
        // Not due for a send ever again; the repair pass picks it up by
        // status instead.
        next_attempt_at: FROZEN_NEXT_ATTEMPT_AT,
        repair_next_attempt_at: this.now(),
        last_error,
        updated_at: this.now(),
      });
      if (!stored) return; // lease lost; the new owner owns the outcome
      this.emit({ ...identityOf(entry), status: 'integrity_error', last_error });
      // No repair from here. Repair is the persistent actor's job only —
      // a fire-and-forget call at this point would run concurrently with
      // the actor's own pass on the very next flush, giving one row two
      // uncoordinated repair drivers.
      counters.failed += 1;
      return;
    }

    const failures = (entry.local_commit_failures ?? 0) + 1;
    const delay = Math.min(
      this.initialDelayMs * Math.pow(2, failures - 1),
      this.maxDelayMs,
    );
    const last_error = `local-commit: ${formatErr(error)}`;
    this.warn('ACK could not be committed locally; message IS delivered', {
      outbox_id: entry.outbox_id,
      local_commit_failures: failures,
      last_error,
    });
    const stored = await write({
      status: 'ack_pending',
      ...ackFields,
      // `attempt_count` deliberately untouched.
      local_commit_failures: failures,
      next_attempt_at: this.now() + delay,
      last_error,
      updated_at: this.now(),
    });
    if (!stored) return;
    this.emit({ ...identityOf(entry), status: 'ack_pending', last_error });
    counters.failed += 1;
  }

  /**
   * Replay a persisted ACK locally. No network: the message is already
   * delivered, and `acked_server_message_id` is the server's own answer
   * for it, captured when the send succeeded.
   */
  private async retryLocalCommit(
    entry: OutboxEntry,
    counters: { sent: number; failed: number },
  ): Promise<void> {
    const server_message_id = entry.acked_server_message_id;
    if (server_message_id === undefined) {
      // Cannot happen through `handleLocalCommitFailure`, which always
      // writes the ids alongside the status. Guard rather than silently
      // re-send: putting a delivered message back on the wire is the one
      // outcome this state exists to prevent.
      this.warn('ack_pending row has no stored ACK; leaving it for repair', {
        outbox_id: entry.outbox_id,
      });
      counters.failed += 1;
      return;
    }
    const resp: SendMessageResponse = {
      client_seq: 0,
      server_message_id,
      message_seq: entry.acked_message_seq ?? 0,
      reason_code: 0,
    };
    try {
      await this.applyAck(entry, resp, { kind: 'none' });
    } catch (e) {
      await this.handleLocalCommitFailure(entry, resp, undefined, e, counters);
      return;
    }
    this.emit({ ...identityOf(entry), status: 'sent', server_message_id });
    counters.sent += 1;
  }

  /** As `handleTransient`: `undefined` means the lease was lost. */
  private async handleRejected(
    entry: OutboxEntry,
    token: string,
    code: number,
  ): Promise<string | undefined> {
    const last_error = `rejected: code=${code}`;
    const owned = await commitOutboxTransition(this.db, entry.outbox_id, token, {
      status: 'failed',
      attempt_count: entry.attempt_count + 1,
      next_attempt_at: FROZEN_NEXT_ATTEMPT_AT,
      last_error,
      updated_at: this.now(),
    });
    return owned ? last_error : undefined;
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
  private async applyAck(
    entry: OutboxEntry,
    resp: SendMessageResponse,
    /**
     * Which lease authorises this commit. `send` is the claim taken before
     * going on the wire; `repair` is the one the repair actor holds. They
     * are separate fields on the row and must never be conflated — a
     * repair pass validating against the send token (or against nothing)
     * can delete a row a *different* owner is working on.
     *
     * `none` is only for the local ACK replay of an `ack_pending` row,
     * which no lease guards because it is not contended: the row cannot be
     * claimed for sending in that state.
     */
    lease: { kind: 'send' | 'repair'; token: string } | { kind: 'none' },
  ): Promise<boolean> {
    const pendingRec = await this.resolvePending(entry);
    const acked: MessageRecord = {
      ...pendingRec,
      server_message_id: resp.server_message_id,
      local_message_id: entry.local_message_id,
      pts: String(resp.message_seq),
      status: 'sent',
    };

    // IDB first: single rw transaction across messages + outbox so a tab
    // refresh can't observe a half-applied ACK. The write returns what it
    // stored, so memory publishes what is durable — not an optimistic `sent`
    // that a crash could roll back to forever-pending.
    //
    // The message row is updated IN PLACE. Its primary key is the stable id,
    // which the ack does not touch, so there is no delete-then-insert and
    // therefore no window, no collision to detect and no identity to re-mint.
    //
    // A failure propagates to the caller, which turns it into a transient
    // retry. Catching it here and continuing would publish `sent` for a row
    // still sitting in the outbox table.
    //
    // The outbox delete is fenced on the lease: if this attempt's lease
    // expired and another owner took over, the row is theirs and deleting
    // it here would erase their state. Losing the race is not an error —
    // the new owner converges — but this attempt must then publish nothing.
    let durable = acked;
    let owned = true;
    await this.db.transaction(
      'rw',
      this.db.messages_v2,
      this.db.outbox,
      this.db.cache_metadata,
      async () => {
        if (lease.kind === 'send') {
          owned = await deleteOutboxEntryIfOwner(this.db, entry.outbox_id, lease.token);
        } else if (lease.kind === 'repair') {
          owned = await deleteOutboxEntryIfRepairOwner(this.db, entry.outbox_id, lease.token);
        } else {
          await deleteOutboxEntry(this.db, entry.outbox_id);
        }
        if (!owned) return;
        durable = await cacheApplyAck(this.db, acked);
      },
    );
    if (!owned) {
      this.warn('lease lost before the ACK could be committed; leaving it to the new owner', {
        outbox_id: entry.outbox_id,
      });
      return false;
    }

    // Memory: pending → sent, in place. The id does not change, so the
    // patch carries no removal and any consumer holding it keeps holding
    // the same message.
    this.store.replaceMessage(
      entry.channel_id,
      entry.channel_type,
      durable.id,
      durable,
      false,
    );
    return true;
  }

  /**
   * Pull the pending MessageRecord out of memory if it's still there,
   * else reconstruct from the outbox row. Reconstruction only happens
   * on cold-start paths (5C-1f) where the in-process MessageStore is
   * fresh; for in-session flushes the memory hit is the common case.
   *
   * On the reconstruction path the cached row is consulted for its `id`:
   * the record identity must survive a cold start, not be re-minted (the
   * ACK deletes the pending row, so the store-level assign-once fallback
   * can no longer see it by then).
   */
  private async resolvePending(entry: OutboxEntry): Promise<MessageRecord> {
    // A command may only resolve to a message of its own send: same channel,
    // same `local_message_id`. The match is exact — a row without one is an
    // inbound message we never sent, and letting a damaged link claim one is
    // how somebody else's message gets rewritten as ours.
    const owns = (m: MessageRecord): boolean =>
      m.channel_id === entry.channel_id &&
      m.channel_type === entry.channel_type &&
      m.local_message_id === entry.local_message_id;

    const memHit = this.store
      .getMessages(entry.channel_id, entry.channel_type)
      .find((m) => m.id === entry.message_id && owns(m));
    if (memHit) return memHit;

    let cached = await this.db.messages_v2.get(entry.message_id);
    const linkIsWrong = cached !== undefined && !owns(cached);
    if (linkIsWrong) cached = undefined;
    if (cached === undefined) {
      // The optimistic row, found by the send's own identity. This is also
      // how a cold start reattaches: memory is empty, but the row is not.
      const byLocal = await this.db.messages_v2
        .where('[channel_id+local_message_id]')
        .equals([entry.channel_id, entry.local_message_id])
        .first();
      if (byLocal !== undefined) cached = byLocal;
    }

    // Last resort before declaring damage: the row the server already has.
    // A `message_rehydrate` repair fetches the message back by its server
    // id, and what lands is a history row — no `local_message_id`, because
    // history does not know which device sent it — so `owns()` rejects it
    // and only this probe can see it. The row is adopted; its identity is
    // not, because the command's `message_id` is what the UI and the outbox
    // still point at.
    if (cached === undefined && entry.acked_server_message_id !== undefined) {
      const rehydrated = await this.db.messages_v2
        .where('[channel_id+server_message_id]')
        .equals([entry.channel_id, entry.acked_server_message_id])
        .first();
      if (rehydrated !== undefined) {
        return { ...rehydrated, id: entry.message_id, local_message_id: entry.local_message_id };
      }
    }

    if (cached === undefined && !isRebuildableFromPayload(entry.content_type)) {
      // Gone, and this payload cannot make it again: media payloads are
      // structured bytes and attachments additionally need a local file the
      // outbox row never carried. A broken bubble on screen is worse than a
      // command the repair path can still act on.
      throw new ProjectionRehydrateRequiredError(
        entry.message_id,
        entry.channel_id,
        entry.content_type,
      );
    }
    if (cached !== undefined) return cached;

    if (linkIsWrong) {
      this.warn('outbox command names a message belonging to something else', {
        outbox_id: entry.outbox_id,
        message_id: entry.message_id,
      });
    }
    return {
      // A link we just rejected must not be reused as the rebuilt row's id:
      // writing under it would overwrite the very row we declined to claim.
      // An absent link is different — reusing it keeps the command attached
      // to what the UI still shows.
      id: linkIsWrong ? nextLocalMessageRecordId() : entry.message_id,
      channel_id: entry.channel_id,
      channel_type: entry.channel_type,
      local_message_id: entry.local_message_id,
      from_uid: entry.from_uid,
      message_type: entry.content_type,
      content: decodeRebuildableContent(entry),
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
