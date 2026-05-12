# Phase 5C — Persistent Outbound Queue Mini Spec

> Status: **draft**, pre-implementation. Freezes the state machine, IndexedDB
> shape, and trigger model for the persistent outbox before any code is
> written. Phases 5A (markRead), 5B-1 (sync engine), and the
> `sync/get_difference` u64-as-string fix are prerequisites and are merged.

## Goal

Make `sendTextMessage` reliable across page refreshes, network drops, and
brief offline periods. A pending message that did not receive an ACK
must:

1. Survive a page reload (persisted in IndexedDB).
2. Be replayed automatically when the transport reconnects + auth replays.
3. Be reconciled exactly once with the server's eventual ACK — whether
   that ACK arrives via the original send promise, a reconnect replay,
   or a `sync/get_difference` commit that echoes our `local_message_id`.

`sendTextMessage` becomes a **never-rejects-on-offline** primitive: it
resolves with `{ status: 'sent' | 'queued', ... }`. This is a breaking
change to the existing API — see Decisions §3 — and is the right one
for an IM product. The low-level Layer-1 `sendMessage()` keeps its
strict reject-on-disconnect contract for callers that need it.

The cache surface (MessageRecord status, observers, channel list) keeps
the same observable contract as Phase 4. New public surfaces:
`outboxEntries()` / `observeOutbox()` / `flushOutbox()` /
`retryOutboxEntry()` / `discardOutboxEntry()`, plus two L1 events.

## Non-goals (explicitly out of scope for 5C)

- Media uploads / chunked file send (separate Phase 6 surface)
- End-to-end encryption (orthogonal; never in 5C)
- Multi-tab outbox coordination via `BroadcastChannel` / leader election
  (Phase 6) — 5C assumes one tab owns the outbox; second-tab behaviour
  is "best effort, may double-send if both tabs were offline at queue
  time"
- Read receipt UI / `peer_read_pts_updated` exposure
- Server-side rate-limit graceful degradation (we surface `failed`,
  host UI decides UX)
- Backpressure / queue depth caps (5C assumes well-behaved usage; will
  add caps if real workloads need them)
- Cross-channel ordering guarantees (FIFO is **per-channel only**)
- Migration of the rest of the JSON RPC routes to u64-string wire
  (tracked in `TS_SDK_KNOWN_ISSUES.md`; not 5C's job)
- Automatic background flush timer (5C only flushes on explicit hooks
  — connect, reconnect, or `flushOutbox(...)`)

---

## Wire contract (no new RPC needed)

The outbox sits **above** the existing protocol:

- Outgoing: builds a `SendMessageRequest` (FlatBuffers — same as Phase 2
  `sendTextMessage`).
- ACK: consumes `SendMessageResponse` (FlatBuffers) — `local_message_id`
  echoes back, `server_message_id` and `message_seq` (pts) are assigned.
- Sync correlation: a `sync/get_difference` `ServerCommit` whose
  `local_message_id` matches an outbox entry's `local_message_id` is
  treated as an ACK by the engine (already implemented in 5B-1c
  `mergeCommits` ACK-swap path; outbox just listens for the
  corresponding cache patch and removes the row).

**No server changes.** Server-side dedup already keys off
`local_message_id` (`MessageDedupService::mark_as_processed` in
`privchat-server`), so a duplicate replay returns the original ACK
shape — outbox treats it as a normal success.

---

## Authoritative state

```
IndexedDB `outbox` table  ← durable per-message state, single writer (the engine)
                            never visible to UI directly; consult via outboxEntries()
                            DELETED on success / retained on failure for retry/inspection

cache MessageStore        ← UI-facing projection
  - `pending` rows mirror outbox rows in the same channel (always present
    while outbox row exists)
  - `failed` rows: outbox row still present, status=failed; UI may retry
  - `sent` rows: outbox row deleted; cache row replaced via existing
    ACK-swap (5B-1c mergeCommits / sendTextMessage's ACK path)

OutboxEngine (in-memory)  ← scheduling state: which channels have
                            in-flight sends, retry timers per row,
                            per-channel mutex (parallel channels OK,
                            same-channel serialised to preserve order)
```

The cache MessageRecord and the outbox row are **two views of the same
fact**: the outbox row is the durable, ACK-tracking copy; the
MessageRecord is the UI-rendered copy. The engine writes both atomically
on enqueue and on terminal-state transitions.

---

## IndexedDB schema (new `outbox` table)

```typescript
// outbox — one row per send attempt currently outstanding.
// Compound primary key: just `local_message_id` (it's the canonical
// idempotency key against the server's dedup service AND it's already
// guaranteed unique per client by `generateLocalMessageId()`).
{
  local_message_id: string;       // PK; idempotency key for server dedup
  channel_id: string;
  channel_type: number;
  from_uid: string;
  message_type: number;           // wire MessageType (0=text, ...)
  content: string;                // display content (text body)
  payload: Uint8Array;             // encoded payload bytes (FlatBuffers-side ready)
  client_seq: number;             // client's send-side seq (mirrors SendMessageRequest.client_seq)
  /** Wall-clock at enqueue. Used for FIFO order within a channel. */
  created_at: number;
  /** Wall-clock of the last send attempt (0 if never sent). */
  last_attempt_at: number;
  /** Number of completed attempts (success-or-fail). 0 == enqueued only. */
  attempts: number;
  /** Per-message state. See state machine below. */
  status: 'pending' | 'sending' | 'failed';
  /** Optional last error info; only meaningful when status === 'failed'. */
  last_error?: {
    kind: 'transient' | 'rejected';
    code?: number;                // server reason_code or HTTP-ish hint
    message?: string;
  };
}
```

Indexes:
- `&local_message_id` (primary)
- `[channel_id+channel_type+created_at]` for per-channel FIFO scan
- `created_at` for global flush order

`status` is stored in IndexedDB but is **not** part of the public
MessageRecord shape — UI reads pending/failed off the cache row, which
the engine keeps in sync.

Note: there is **no** `sent` row in the outbox. A successful ACK deletes
the row. This is the simplest correctness model — "outbox row exists" =
"server has not confirmed yet".

---

## State machine (per outbox row)

```
                  enqueue
                  ───────▶ pending
                              │
                       attempt sending
                              │
                              ▼
                          sending ──────────┐
                          /    \             │
                  ack    /      \  error     │
                        ▼        ▼           │
                   (delete)    failed        │
                                │            │
                                │  retry     │
                                └────────────┘
```

Transitions:

| From | To | Trigger | Side effect |
| --- | --- | --- | --- |
| (none) | `pending` | `sendTextMessage()` enqueues | Insert outbox row + cache row (`status: 'pending'`) |
| `pending` | `sending` | Engine picks up + dispatches | Increment `attempts`, update `last_attempt_at`. Cache row stays `pending`. |
| `sending` | (deleted) | ACK received (any source) | Delete outbox row; cache row replaced via existing ACK-swap (`status: 'sent'`) |
| `sending` | `failed` | Transport throw / `reason_code !== 0` / timeout | Update `last_error`. Cache row → `failed`. |
| `failed` | `pending` | Retry trigger fires + within retry budget | Re-enter the loop. Cache row → `pending`. |
| `failed` | (no transition, terminal) | `last_error.kind === 'rejected'` OR attempts ≥ max | Stays `failed`. Manual `retryOutboxEntry(...)` resets attempts and re-enters `pending`. |

`sending` is the only state where the engine has a network operation
in-flight for that row. Per-channel mutex ensures FIFO ordering within
one channel — only one `sending` per `(channel_id, channel_type)` at a
time.

The four "user-facing statuses" the spec asked for map onto this:

- **pending**: outbox `pending` OR `sending` (UI doesn't distinguish)
- **sent**: outbox row deleted + cache row has `server_message_id`
- **failed**: outbox `failed`

---

## Trigger model

5C fires the engine on three triggers — no others.

1. **Direct enqueue** (`sendTextMessage` or future media/etc): writes
   the row, kicks the engine immediately. If transport is connected,
   the row goes pending → sending in the same microtask.

2. **Reconnect** — extending 5B-1d's `attemptReconnect` flow:

   ```
   attemptReconnect()
     → connect → re-authenticate → replay subscriptions
     → syncOnReconnect()              (5B-1d, already shipped)
     → flushOutbox()                  (5C, NEW)
     → cancelReconnect()
   ```

   `flushOutbox()` runs after sync so any commits the server already
   accepted but never ACKed to us are visible — the engine then sees
   "this local_message_id already has a server_message_id in the
   cache" and **deletes the row without re-sending** (idempotent
   completion via sync convergence).

3. **Manual `client.flushOutbox()`** — kick the engine on demand. Useful
   for "Retry all" UI buttons.

Explicitly NOT triggered by:
- A periodic background timer (no `setInterval`)
- A transport `'open'` event independent of auth (auth replay must
  succeed first; otherwise the send would 401)
- A push event (irrelevant — pushes are inbound only)

---

## ACK rules (three sources, one effect)

A row is removed from the outbox when its `local_message_id` is observed
to have an `server_message_id` from any of these sources:

1. **Direct send-ACK** (`sendMessage()` resolves, `reason_code === 0`):
   the engine writes the ACK back into the cache via the existing
   `replaceMessage`-keyed swap (`l:<localId>` → `s:<serverMsgId>`),
   then deletes the outbox row in the same IndexedDB transaction.

2. **Reconnect-replay ACK**: same path as (1) — the engine just
   re-issues the same `SendMessageRequest` (server dedup makes it
   idempotent).

3. **Sync-arrived correlation**: when `syncChannel` drains a page and
   any commit's `local_message_id` matches an outbox row, the engine
   treats it as a deferred ACK. Specifically:
   - 5B-1c's `mergeCommits` ACK-swap path already replaces the cache
     row (pending → sent) via `messageRecordKey` swap.
   - 5C adds a hook so the outbox engine listens for this swap (or
     polls the outbox table after each `syncChannel` returns
     `'synced'` / `'resynced'`), and **deletes the matching outbox
     row** without sending again.

The engine considers a row "done" when there is **either** an outbox
deletion (its own write) **or** a cache row with `server_message_id`
that matches the outbox row's `local_message_id`. The bookkeeping is
last-writer-wins with deletion as the canonical truth — if the cache
already has an ACKed row, the engine's send loop short-circuits and
deletes the outbox row without dispatching.

---

## Retry / backoff

Per-row, on transient failure:

```
delay = min(initialDelayMs * 2^attempts, maxDelayMs)
```

Defaults: `initialDelayMs = 1000`, `maxDelayMs = 30_000`,
`maxAttempts = 8` (≈ 1+2+4+8+16+30+30+30 ≈ 2 minutes total
attempt window).

After `maxAttempts`, the row stays `failed` with
`last_error.kind = 'transient'`. UI may surface a "Retry" button that
calls `retryOutboxEntry(localMessageId)` (resets `attempts` to 0).

Rejected sends (server `reason_code !== 0`) are **never** auto-retried.
They're terminal: `last_error.kind = 'rejected'`, `attempts` frozen at
the count when rejection landed. UI must offer manual retry or message
deletion.

`retryOutboxEntry` for a `rejected` row is allowed but should be a
deliberate user action — same as resending after editing in a typical
chat UI.

---

## Failure handling matrix

| Failure                            | outbox row state | cache row state | observable                         |
| ---------------------------------- | ---------------- | --------------- | ---------------------------------- |
| Transport throw mid-send           | `failed` (transient)  | `failed`         | next reconnect / `flushOutbox` retries |
| RPC timeout                        | `failed` (transient)  | `failed`         | retried per backoff                |
| `reason_code !== 0`                | `failed` (rejected)   | `failed`         | NOT auto-retried; UI must intervene |
| `maxAttempts` exhausted (transient)| `failed` (transient)  | `failed`         | manual `retryOutboxEntry` only     |
| IndexedDB write fails on enqueue   | (no row)         | (no cache row)  | `sendTextMessage` rejects loudly — caller must handle (this is a "your storage is broken" condition, not a normal flow) |
| IndexedDB write fails on delete (post-ACK) | row may remain | cache shows `sent` | next flush re-runs send; server dedup short-circuits to existing ACK |
| Browser tab closed mid-send        | row stays `sending` (worst case) | row stays `pending` | on next page load, engine treats `sending` as `failed (transient)` and retries |

The "tab closed mid-send" case is why we resurrect `sending` rows as
`failed` on cold start: we cannot tell if the request reached the
server or not. Server dedup makes the resend safe.

---

## API surface (additions)

### `sendTextMessage` return type changes (breaking)

```ts
/**
 * Resolves with the queued or sent state. Never rejects on offline —
 * an offline send becomes a `'queued'` result with the row persisted
 * to IndexedDB. The Promise rejects only when the SDK cannot enqueue
 * (e.g. cache disabled, IndexedDB write failure).
 */
client.sendTextMessage(input: SendTextInput): Promise<SendTextMessageResult>;

interface SendTextMessageResult {
  /** `'sent'` = server ACK landed inline; `'queued'` = persisted to outbox. */
  status: 'sent' | 'queued';
  /** Always present — the canonical idempotency + correlation key. */
  local_message_id: string;
  /** Present iff `status === 'sent'`. */
  server_message_id?: string;
  /** Per-channel pts (decimal string), present iff `status === 'sent'`. */
  message_seq?: string;
  /** Outbox PK; aliases `local_message_id` in 5C. Reserved for future
   *  divergence (e.g. dedicated UUID). */
  outbox_id?: string;
}
```

### Outbox introspection / control

```ts
interface OutboxEntry {
  local_message_id: string;
  channel_id: string;
  channel_type: number;
  from_uid: string;
  content: string;
  /** Persisted statuses only. Transient `sent` / `discarded` are emitted
   *  via `outbox_state_changed` but never appear here (the row is gone). */
  status: 'pending' | 'sending' | 'failed';
  attempts: number;
  created_at: number;
  last_attempt_at: number;
  last_error?: {
    kind: 'transient' | 'rejected';
    code?: number;
    message?: string;
  };
}

/** Snapshot of all queued / failed outbox rows. Sorted by created_at asc.
 *  Empty when cache (and hence outbox) disabled. */
client.outboxEntries(): OutboxEntry[];

/** Subscribe to outbox snapshot changes (full snapshot per emit).
 *  Use `observeEvents` if you need per-transition granularity instead. */
client.observeOutbox(cb: (entries: OutboxEntry[]) => void): Unsubscribe;

/** Manual flush — kicks every channel with queued rows.
 *  Resolves when one full pass has settled (success or fail per row). */
client.flushOutbox(): Promise<void>;

/** Force a specific row back to `pending`, resetting `attempts`.
 *  Throws if no row matches. */
client.retryOutboxEntry(local_message_id: string): Promise<void>;

/** Drop a row WITHOUT sending. Emits `outbox_state_changed` with
 *  `status: 'discarded'`, then removes the matching cache row.
 *  Throws if no row matches. */
client.discardOutboxEntry(local_message_id: string): Promise<void>;
```

### L1 event additions

Two new variants. The reserved `outbound_queue_drained` slot in
`events.ts` is renamed `outbox_drained`.

```ts
/** Per-entry transition signal. Fires for every state change in the
 *  outbox, including the transient `sent` / `discarded` outcomes
 *  (where the row is deleted at/before emit). UI animation hooks
 *  and debug consumers key off this. */
interface OutboxStateChangedEvent {
  type: 'outbox_state_changed';
  /** Outbox row identity. Equals `local_message_id` in 5C. */
  entry_id: string;
  channel_id: string;
  channel_type: number;
  local_message_id: string;
  /** Five-state surface — see Decisions §9. */
  status: 'pending' | 'sending' | 'sent' | 'failed' | 'discarded';
  /** Populated for `'sent'`. */
  server_message_id?: string;
}

/** Fires once whenever the outbox transitions from non-empty to empty.
 *  Targeted at "global pending badge" UIs. */
interface OutboxDrainedEvent {
  type: 'outbox_drained';
}

type SdkEvent =
  | ...existing variants
  | OutboxStateChangedEvent
  | OutboxDrainedEvent;
```

A flush pass that drains N rows therefore emits N
`outbox_state_changed` events plus one `outbox_drained` event at the
tail (assuming the queue ends empty). `observeOutbox` hosts can ignore
the L1 events entirely and just diff snapshots; the L1 stream is for
hosts that want push-style granularity without holding a full snapshot.

---

## Configuration

```ts
new PrivchatClient({
  url, cache: { enabled: true },
  outbox: {
    enabled: true,                  // default: true when cache.enabled
    initialDelayMs: 1_000,
    maxDelayMs: 30_000,
    maxAttempts: 8,
  },
});
```

Cache disabled → outbox disabled (the existing Phase 2 thin direct-send
behaviour stays unchanged). The outbox piggybacks on the cache's
IndexedDB instance (same DB, new table).

---

## Test plan

### Unit (vitest, fake transport, fake-indexeddb)

1. **Enqueue + immediate ACK (online).** `sendTextMessage` resolves
   with `{ status: 'sent', server_message_id, local_message_id }`. Row
   inserted then deleted; cache row swaps `l:` → `s:` once; observers
   see two patches; `outbox_state_changed` fires `pending` → `sending`
   → `sent`; `outbox_drained` fires once at the tail.
2. **Enqueue while offline.** Transport disconnected. `sendTextMessage`
   resolves with `{ status: 'queued', local_message_id, outbox_id }`
   (NOT rejected). Outbox row stays `pending`; cache row is `pending`.
3. **Online send throws → fallback to queued.** Transport throws mid-
   send. `sendTextMessage` resolves with `status: 'queued'` (not
   rejected). Outbox row state `sending` → `failed`; cache row
   `pending` → `failed`. Subsequent `flushOutbox` retries.
4. **Manual `flushOutbox` after recovery.** Row `failed` → `pending` →
   `sending` → deleted; cache row `failed` → `sent`. `outbox_drained`
   fires.
5. **`reason_code !== 0` (rejected).** Row stays
   `failed { kind: 'rejected' }`; auto-retry does NOT re-send;
   `flushOutbox` does not pick it up; only `retryOutboxEntry`
   re-sends.
6. **`maxAttempts` exhausted (transient).** After N transient failures,
   row stays `failed { kind: 'transient' }`; subsequent `flushOutbox`
   no-ops; only `retryOutboxEntry` re-sends.
7. **Cold start with `sending` row in IndexedDB.** Simulates tab killed
   mid-send: on construct, engine flips `sending` → `failed (transient,
   resumed)`; first `flushOutbox`/connect retries.
8. **Sync-arrived ACK.** Enqueue, simulate transport disconnect before
   ACK, then `syncChannel` returns a commit with the matching
   `local_message_id`. Outbox row deleted without re-send; cache row
   ACK-swapped by `mergeCommits`. `outbox_state_changed` fires `'sent'`;
   `outbox_drained` fires.
9. **Per-channel FIFO.** Enqueue 3 messages on the same channel; first
   send blocks via fake transport; observe second/third stay `pending`
   (NOT `sending`) until first resolves.
10. **Cross-channel parallelism.** Enqueue on two channels
    simultaneously; both reach `sending` concurrently; mutex is per-
    channel.
11. **`discardOutboxEntry`.** Row removed without sending; cache row
    removed; `outbox_state_changed` fires with `status: 'discarded'`;
    if queue becomes empty, `outbox_drained` fires.
12. **Backoff timing.** With `initialDelayMs: 50, multiplier: 2`, three
    consecutive transient failures schedule retries at +50, +100,
    +200ms (vitest fake timers).
13. **`disconnect()` retains the outbox.** Enqueue 2 rows offline;
    call `client.disconnect()`; reconstruct the client with the same
    `dbName`; assert `outboxEntries().length === 2`.

### Accounts E2E

Add `phase14-outbox.ts`:

- alice cache-enabled client.
- Disable transport (or use `simulateUnexpectedDisconnect`).
- Enqueue 2 messages via `sendTextMessage` (offline → outbox holds them
  as `pending`).
- Reload simulation: tear down + reconstruct the client with the SAME
  IndexedDB `dbName`; assert `outboxEntries()` recovers both rows.
- Reconnect → assert both messages land at server (verify via
  `messageHistory` from a separate online observer client) and the
  outbox empties.
- Reuse the phase13 disconnect/reconnect helper; share the mgr.bob /
  mgr.alice setup.

---

## Decisions

These are binding for 5C-1c. The five questions raised during spec
review are resolved as follows; the rest carry over from initial design.

1. **Outbox table lives in the same Dexie DB as the rest of the cache.**
   No second IndexedDB. Same `dbName`, new `version()` migration adding
   the `outbox` store. Bumps schema to v2.

2. **Idempotency key = `local_message_id`.** Single source of truth.
   Server-side dedup already keys off it; we do not invent a second
   key. The optional `outbox_id` field on the result type aliases
   `local_message_id` in 5C — reserved for future divergence.

3. **`sendTextMessage` resolves with a queued/sent result, never
   rejects on offline.** New return type
   `Promise<SendTextMessageResult>`:

   - `status: 'sent'` — server ACK landed inline. `server_message_id`
     populated; cache row already swapped to `sent`.
   - `status: 'queued'` — transport offline OR send threw. Outbox row
     persisted; cache row left at `pending`. `outbox_id` populated;
     `server_message_id` undefined.

   Rationale: the IM product mental model is "the user pressed send,
   the message stays". Rejecting forces every host to re-implement
   queueing themselves and leaks the SDK's reliability story. The
   low-level `sendMessage()` (Layer-1 facade) keeps its strict
   reject-on-disconnect contract for callers that need it.

   This is a breaking change to existing callers (`phase11_cache_smoke`,
   `phase12_mark_read`, `phase13_sync_gap_fill`, the manager's
   `sendTextMessage` users in earlier phases). Migration is
   straightforward: read `result.server_message_id` (now optional;
   present iff `status === 'sent'`).

4. **Persist `payload: Uint8Array` in IndexedDB as native binary.**
   Dexie / IndexedDB structured-clone supports `Uint8Array` natively.
   No base64. If the platform reads back as `ArrayBuffer`, the cache
   adapter normalises to `Uint8Array` at the boundary.

5. **`client.disconnect()` retains the outbox.** Disconnect is
   "transport closed, session may resume"; outbox is durable.
   The outbox is cleared only by:

   - explicit `client.logout()` / future `clearCurrentUser()`
   - `clearAll()` cache wipe
   - per-row `discardOutboxEntry(...)`
   - server returning a terminal-rejected ACK to a flush attempt
     (kind: `'rejected'` — row stays as a `failed` tombstone, not
     auto-cleared, but no longer auto-retried)

   `disconnect()` does NOT clear the outbox.

6. **Per-channel FIFO, cross-channel parallel.** Mutex is keyed
   `${channel_id}::${channel_type}` (same shape as the sync engine's
   per-channel mutex). Same-channel sends ship in `created_at` order;
   cross-channel sends race the mutex and effectively emit in arrival
   order, with no global serialisation.

7. **Reconnect order: subscriptions → sync → outbox.** Flush runs
   AFTER `syncOnReconnect` so any commit the server accepted-but-
   didn't-ACK is observed first; the outbox engine then sees the
   matching `server_message_id` already present in the cache and
   short-circuits the row to deletion without re-sending.

8. **No automatic background timer.** Triggers are: enqueue, connect,
   reconnect, manual flush. A periodic poller risks fighting with
   reconnect logic and adds nondeterminism.

9. **`outbox_state_changed` fires on every transition; payload is
   per-entry, not batched.** Five status values are surfaced via the
   event:

   ```
   pending | sending | sent | failed | discarded
   ```

   `sent` and `discarded` are **transient** — the outbox row is
   deleted before/at emit time; the event is the last signal a host
   gets for that row. The IndexedDB-persisted state set is just
   `pending | sending | failed` (3 states); the other two only exist
   on the wire.

   Hosts that want batched updates can use `observeOutbox(cb)` which
   gets the full snapshot per change. The L1 event keeps single-entry
   granularity for debug + animation hooks.

10. **Two L1 events:** `outbox_state_changed` (per-entry) and
    `outbox_drained` (queue cleared). The reserved
    `outbound_queue_drained` slot in `events.ts` is repurposed as
    `outbox_drained`. Hosts wanting a "global pending badge" toggle
    only need to listen for these two; everything else is observable
    via `outboxEntries()` snapshots.

11. **No multi-tab coordination in 5C.** If two tabs both enqueue
    while the network is down, both will replay on reconnect. Server
    dedup prevents double-commit per `local_message_id`. The second
    tab's local cache may show its send as `failed (rejected)`
    depending on server dedup response shape. Multi-tab is Phase 6.

---

## Sequenced subtasks

| # | Task | Gate |
| - | ---- | ---- |
| 5C-1a | **Schema + adapter.** `outbox` store via Dexie schema v2; `OutboxEntry` types in `cache/types.ts`; `outbox-store.ts` low-level CRUD (enqueue, list, get, update-state, delete, clear). Cold-start sweep that flips orphan `sending` rows back to `failed (transient, resumed)`. | unit tests for the new store |
| 5C-1b | **Enqueue + new `sendTextMessage` contract.** New `SendTextMessageResult` return type; offline / send-throw paths resolve with `status: 'queued'`; online path keeps direct ACK and resolves with `status: 'sent'`. Update existing callers (phase11 / phase12 / phase13) to read `result.server_message_id` defensively. | unit cases 1–3 + regression: existing accounts E2E 13/13 |
| 5C-1c | **Engine — flush + retry/backoff.** `OutboxEngine` class with per-channel mutex, exponential backoff loop, transient vs rejected error classification, `flushOutbox` / `retryOutboxEntry` / `discardOutboxEntry` public methods. | unit cases 4–6, 9–10, 12 |
| 5C-1d | **Reconnect hook.** Extend `attemptReconnect` chain: `re-auth → replay subscriptions → syncOnReconnect → flushOutbox → cancelReconnect`. Sync-arrived ACK short-circuit (case 8). | unit case 8 + reconnect tests still green |
| 5C-1e | **Observers + L1 events.** `observeOutbox` snapshot subscription; `outbox_state_changed` per-entry event; `outbox_drained` queue-empty event; rename reserved L1 slot. | unit case 11 + event-shape tests |
| 5C-1f | **Accounts `phase14-outbox`.** Offline-send → cold restart → reconnect → flush → cache converges to `sent`. Reuses phase13's `simulateUnexpectedDisconnect` helper. | accounts 14/14 |
| 5C-1g | **README.** Append Phase 5C subsection; document the new `sendTextMessage` contract (BREAKING) + `outboxEntries` / `flushOutbox` / `retryOutboxEntry` / `discardOutboxEntry` + the two events. | docs review |

Each subtask is committable independently. `5C-1c` is the largest diff;
`5C-1b` is the breaking-API change (gate on regression).
