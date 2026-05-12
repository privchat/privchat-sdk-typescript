# Phase 5B-1 — Sync Engine Mini Spec

> Status: **draft**, pre-implementation. This spec freezes the state machine
> and boundaries for the gap-fill sync engine before any code is written.
> Phase 5B-0 (cache ID/PTS model alignment with Rust) is the prerequisite
> and is already merged.

## Goal

Make the cache *converge to the server* after any disconnect, by pulling the
deltas the client missed while offline. Concretely: after a successful
re-authenticate the SDK calls `sync/get_difference` per active channel,
merges the returned commits into the cache, and lifts `channel.latest_pts`
to the new server high-water mark.

## Non-goals (explicitly out of scope for 5B-1)

- Persistent outbound queue / retry storage (deferred to 5C)
- Multi-tab coordination via `BroadcastChannel` / leader election (Phase 6)
- Media download state machine, thumbnail cache (Phase 6)
- Background periodic polling — sync only fires on reconnect or explicit call
- Read-receipt peer UI / typing presence cross-device fan-out
- Full-resync UI affordance (server may emit `SyncFullRebuildRequired`; we
  log + emit an event, leaving recovery UX to the host app)
- Entity-family resync (`SyncEntityResyncRequired`, code 20901). 5B-1 is
  scoped to message PTS only; entity sync stays Phase 4 bootstrap-only.

---

## Wire contract (frozen by server)

Route: `sync/get_difference` (JSON RPC body, registered at
`privchat-server/src/rpc/sync/mod.rs:68`, handler at `:125`).
Per-channel cursor; one call per channel per sync pass.

### Request

```ts
interface GetDifferenceRequest {
  channel_id: number;     // u64 on wire — see "Type boundary" below
  channel_type: number;   // 1=private, 2=group
  last_pts: number;       // u64 cursor; client's max known pts
  limit?: number;         // default 100 server-side
}
```

### Response

```ts
interface GetDifferenceResponse {
  commits: ServerCommit[]; // ordered ASC by pts, contiguous when has_more=false
  current_pts: number;     // server's live channel pts (high-water mark)
  has_more: boolean;       // pagination signal
}

interface ServerCommit {
  pts: number;                    // u64 — per-channel ordering key
  server_msg_id: number;          // u64 — message identity (snowflake)
  local_message_id?: number;      // u64 — echo of client's local id (own sends only)
  channel_id: number;             // u64
  channel_type: number;           // u8
  message_type: string;           // "text" | "image" | ... — application content type
  content: unknown;               // JSON value — type-specific payload
  server_timestamp: number;       // i64 millis
  sender_id: number;              // u64
  sender_info?: SenderInfo;       // optional user metadata
}
```

### Stale-cursor errors

Server returns one of these via the standard RPC envelope `code` field:

| Code  | Name                          | Server condition                                                          | Client action                                            |
| ----- | ----------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------- |
| 20900 | `SyncChannelResyncRequired`   | `last_pts > current_pts`, OR commits empty when gap > 0, OR non-contiguous first commit (`pts != last_pts + 1`) | Drop channel cache window; re-call `openConversation()` (Phase 4 path); set `latest_pts = current_pts` |
| 20901 | `SyncEntityResyncRequired`    | Entity-family cursor outdated                                             | Out of scope for 5B-1 — log + ignore                     |
| 20902 | `SyncFullRebuildRequired`     | Catastrophic: server-side cache eviction, account migration, etc.          | Emit `sync_full_rebuild_required` event; SDK does NOT auto-wipe; host app decides |

---

## Type boundary (string vs number vs bigint)

Snowflake u64 ids must round-trip without precision loss. The boundaries
match Phase 5B-0:

| Layer                          | Representation         |
| ------------------------------ | ---------------------- |
| Wire (JSON RPC, on the network)| `number` (u64 — server currently emits as JSON number; **see protocol-debt note below**) |
| Wire (FlatBuffers push)        | `bigint` (uint/ulong)  |
| TS RPC adapter (`rpc-types.ts`)| `number` for wire fidelity, coerced at the boundary |
| TS cache + public API          | `string`               |

**Concrete rule for sync engine:**
- Inputs to `getChannelDifference()` accept `pts: string` (consistent with rest of cache API). Adapter coerces via `Number(...)` on the wire for now (matches existing `sync/get_channel_pts` pattern in `phase12-mark-read.ts`).
- Outputs (commits → MessageRecord) coerce u64 fields to `string` at the boundary via `String(commit.pts)`, etc.
- `current_pts` returned to callers is `string`.

### Protocol debt: JSON u64 is not precision-safe in JavaScript

The current RPC wire emits u64 fields (`pts`, `server_msg_id`, etc.) as JSON
numbers. JavaScript's `number` cannot represent integers above `2^53 - 1`
without precision loss, and snowflake ids can in principle exceed this
limit. **5B-1 keeps compatibility with the existing server wire** and
coerces at the boundary, but this is a known protocol debt — not a
proven-safe design.

Long-term fix (out of scope for 5B-1): either (a) the server serializes
u64 fields as strings on JSON RPC routes, or (b) the sync route migrates
to a FlatBuffers RPC body where ulong is native. Track separately; revisit
the moment a real-world snowflake actually trips a precision bug.

---

## Authoritative state

```
ChannelRecord.latest_pts  ← per-channel high-water mark, advances monotonically
  - lifted by: push absorption, send-ACK (own message), sync engine
  - NOT lifted by: openConversation/scrollHistory (history wire has no pts)
  - NOT lifted by: 20900 resync recovery (see triggerResync rationale)

ChannelRecord.server_current_pts? ← OPTIONAL, observability-only (NEW in 5B-1)
  - written from a 20900 error envelope's `current_pts` (if present)
  - written from a successful sync pass's response.current_pts
  - host UI may use it to surface "X messages may have been missed" hints
  - MUST NOT influence merge / dedup / cursor decisions

SyncStateRecord.latest_pts ← mirrors ChannelRecord.latest_pts for persistence
  - written after each successful sync pass
  - read at startup (cold cache) before first sync to seed cursor

SyncStateRecord.last_sync_at ← wall-clock time of last successful sync per channel
  - used by future periodic-sync tier; 5B-1 only writes it

ChannelRecord.read_pts    ← unchanged from Phase 5A; sync engine MUST NOT touch it
```

The sync engine is *write-only* on `latest_pts` and *read-only* on `read_pts`.

### MessageRecord identity (inherited from 5B-0 — must not regress)

The sync engine MUST honour the Phase 5B-0 identity model:

- There is **no** `MessageRecord.message_id`. Anything implementing 5B-1
  that introduces a `message_id` field on the cache record is wrong and
  must be rejected in review.
- Server-originated commits (sync + push + history) populate
  `server_message_id`. They never populate `local_message_id` for rows
  the client did not originate.
- Client-originated pending rows populate `local_message_id`. The server
  ACK / sync echo (when `commit.local_message_id` matches) replaces the
  pending row with one that has BOTH `server_message_id` AND
  `local_message_id` set, so clients can correlate.
- `record_key` is **internal to the IndexedDB layer** — derived as
  `s:<server_message_id>` once delivered, else `l:<local_message_id>`.
  It is not part of the public `MessageRecord` shape and is not exposed
  on `commits[]` either.

---

## Trigger model

Two triggers in 5B-1, no others:

1. **Reconnect success.** After `attemptReconnect()` re-authenticates and
   replays subscriptions (`client.ts:1446-1451`), invoke `syncOnReconnect()`
   which iterates active subscriptions and calls
   `getChannelDifference()` per channel.

2. **Manual `client.syncChannel(channel_id, channel_type)`.** Public API,
   one channel, one round-trip. Useful for host apps that want explicit
   refresh ("pull-to-refresh" on mobile-style web UIs).

Explicitly NOT triggered by:
- Periodic timer
- `openConversation()` (stays Phase 4 — cache→remote history)
- `scrollHistory()` (stays Phase 4 — history pagination)
- Push receipt (push absorption already lifts `latest_pts`)

---

## State machine (per channel, per sync pass)

```
┌─────────────────────────────────────────────────────────────────────┐
│ idle ──▶ resolveCursor ──▶ rpcLoop ──▶ mergeCommits ──▶ persistPts ─┤
│                ▲                │              │              │      │
│                │                ▼              ▼              ▼      │
│                │           pageReturned   ResyncRequired   syncDone  │
│                │                │              │                     │
│                │                ▼              ▼                     │
│                └────────── has_more=true   triggerResync             │
│                                                                       │
└─────────────────────────────────────────────────────────────────────┘
```

### resolveCursor
```
cursor = max(
  ChannelRecord.latest_pts ?? "0",
  SyncStateRecord.latest_pts ?? "0"
)
```
Mirrors Rust `max_message_pts(...)` + `load_resume_channel_pts(...)`. Two
sources because `ChannelRecord` is in-memory + persistent, and
`SyncStateRecord` is the durable cursor that survives a buffer eviction.

### rpcLoop
```
while true:
  resp = rpc.getDifference({ channel_id, channel_type, last_pts: cursor, limit: 100 })
  if resp.code == 20900: goto triggerResync
  if resp.commits.empty AND !resp.has_more: break  // already current
  yield resp.commits to mergeCommits
  cursor = resp.commits[-1].pts
  if !resp.has_more: break
  if pageCount >= MAX_PAGES (default 64): break + log warn
```
Hard page cap matches Rust SDK (`lib.rs:6311`). Larger gaps are a signal
that this channel needs a full resync, not a longer loop.

### mergeCommits
For each commit (ordered ASC by pts):
1. Build `MessageRecord` via `commitToMessageRecord(commit)` (new helper).
2. Compute `record_key`:
   - If `commit.local_message_id` is present **and** a pending row with
     that local_message_id exists in the buffer → ACK swap path:
     emit `removed=['l:<localId>'] + upserted=[acked]` (same shape as
     send-ACK in `client.ts`). This counts as a **transition**, not a
     newly-inserted row.
   - Else → straight upsert keyed by `s:<server_msg_id>`.
3. Idempotent dedupe: if a row with the same `s:<server_msg_id>` already
   exists, the commit is a **duplicate** — skip patch emit AND skip the
   unread bump in step 5. (Content equality check stays as a defense-in-depth
   short-circuit, but the dedup decision is by record_key, not by content.)
4. Lift `ChannelRecord.latest_pts = max(latest_pts, commit.pts)`.
5. **Bump `unread_count` only for commits that are newly inserted in
   step 2.** A commit qualifies for unread bump iff ALL of the following
   hold:
   - The commit produced a fresh insert in step 2 (NOT a dedupe-skip
     in step 3, NOT a local-echo ACK swap in step 2, NOT an in-place
     update of an existing row).
   - `commit.sender_id !== currentUserId`.
   - `BigInt(commit.pts) > BigInt(channel.read_pts)` (using the
     channel's read_pts as snapshotted at the start of the merge —
     don't re-read it per commit).
   - `!commit.revoked` (when the revoke flag lands in the response
     shape; until then, treat as `false`).

   **This rule is intentionally narrower than the push-side policy.**
   `absorbPushIntoCache` can rely on push being one-shot per server
   commit; the sync engine must defend against repeated `syncChannel`
   calls re-applying the same commits and inflating `unread_count`. The
   shared helper (if any) MUST take a "newly-inserted" boolean from the
   caller — it cannot recompute that from the record alone.

### persistPts
After the loop exits cleanly:
```
SyncStateRecord.latest_pts = ChannelRecord.latest_pts
SyncStateRecord.last_sync_at = Date.now()
```
Write is async (non-blocking); failure logs but does not error the sync.

### triggerResync (on code 20900)
```
1. Drop in-memory buffer for (channel_id, channel_type) — emits removed=[allKeys]
2. Reset SyncStateRecord.latest_pts = "0"
3. Set ChannelRecord.latest_pts = "0"
4. Re-call openConversation(channel_id, channel_type) — Phase 4 path
   takes over: emits cached (now empty) + remote (latest history window)
5. If the error envelope carried `current_pts`, store it ONLY as
   ChannelRecord.server_current_pts (debug / observability field).
   DO NOT write it to ChannelRecord.latest_pts.
```

**Why we must not lift `latest_pts` to `current_pts` here.**
`openConversation` only fetches a *history window* (the latest N messages).
It does not prove the cache covers every commit up to `current_pts` — there
may be older commits between the bottom of the window and the previous
cursor that the resync deliberately abandoned. If we wrote
`latest_pts := current_pts` after `openConversation`, the next
`sync/get_difference` call would skip the gap, leaving the cache silently
inconsistent with the server.

**`latest_pts` continues to advance only via the canonical paths:**
1. Real-time push absorption (`absorbPushIntoCache` lifts from `message_seq`).
2. Successful sync commit application (`mergeCommits` lifts from `commit.pts`).
3. Send-ACK on own messages (`pts` returned by server in send response).

After a 20900-driven resync, the channel effectively starts with
`latest_pts = "0"` and naturally re-converges through paths 1–2 above. The
optional `server_current_pts` field is for diagnostics and host-app UX
hints (e.g. "X messages may have been missed since you last opened this
chat") — it MUST NOT influence merge decisions.

---

## Merge rules (canonical statements)

1. **`server_msg_id` is the dedup key.** Never use `pts` as identity (PTS
   may renumber after server-side compaction in pathological cases;
   `server_msg_id` is immutable).
2. **`pts` is monotonic per channel.** `ChannelRecord.latest_pts` only ever
   increases. Sync engine MUST clamp via MAX, never trust an out-of-order
   commit (which would itself be a bug, but defense-in-depth).
3. **Server payload is authoritative** for content + metadata on conflict.
   A pending local-echo row is replaced (not merged) when its
   `local_message_id` matches a returned commit.
4. **Pending local-echo rows are NEVER deleted** by the sync pass unless a
   commit explicitly references their `local_message_id`. A pending row
   that the server hasn't seen yet (still in flight) survives the merge.

---

## Failure handling

| Failure                                | Effect on cache              | Effect on cursor                   | Surfaces as          |
| -------------------------------------- | ---------------------------- | ---------------------------------- | -------------------- |
| Transport error mid-loop               | Partial commits already merged stay | Cursor advanced to last successful page | rejected promise; reconnect retry will resume from advanced cursor |
| RPC timeout (`defaultTimeoutMs`)       | No change                    | No change                          | rejected promise     |
| Code 20900 `SyncChannelResyncRequired` | Buffer dropped, refilled by `openConversation` | Reset to 0, then to `current_pts` | resolved promise; observers see remove + remote snapshot |
| Code 20902 `SyncFullRebuildRequired`   | No change                    | No change                          | resolved promise + L1 event `sync_full_rebuild_required`; host decides |
| Other non-zero `code`                  | No change                    | No change                          | rejected promise     |
| Persist write fails (IndexedDB)        | In-memory state correct      | Will re-fetch on next sync         | warn log, no throw   |

The sync engine never wipes cache state on transient errors; only an
explicit server-driven 20900/20902 causes the cache to give up its window.

---

## API surface (additions)

```ts
// Public
client.syncChannel(channel_id: string, channel_type: number): Promise<SyncResult>;

interface SyncResult {
  channel_id: string;
  channel_type: number;
  status: 'current' | 'synced' | 'resynced' | 'rebuild_required';
  commits_applied: number;        // 0 when 'current' or 'rebuild_required'
  pages_fetched: number;
  latest_pts_before: string;
  latest_pts_after: string;
}

// Internal (called by reconnect path)
private syncOnReconnect(): Promise<void>;            // iterates active subs
private getChannelDifference(...): Promise<...>;     // single RPC call
private commitToMessageRecord(commit): MessageRecord;

// L1 event additions (only the catastrophic one needs a slot)
type SdkEvent =
  | ...existing variants
  | { type: 'sync_full_rebuild_required'; channel_id: string; channel_type: number };
```

`syncChannel` rejects on transport/timeout/non-recoverable error; resolves
on `'current'`, `'synced'`, `'resynced'`, or `'rebuild_required'`. The
status is observable rather than a throw because rebuild-required is a
business decision, not an SDK failure.

---

## Test plan

### Unit (vitest, fake transport)
1. Empty response (`commits: [], has_more: false`) → status `'current'`, no patch emit.
2. Single page, 3 commits → 3 upserts, `latest_pts` advances to last `pts`.
3. Two pages (`has_more: true` then `false`) → 2 RPC calls, all 6 commits applied in order.
4. Local-echo ACK via sync: pre-seed pending row with `local_message_id=L`, response includes `commit{ local_message_id: L, server_msg_id: S }` → patch carries `removed=['l:L'] + upserted=[s:S]`.
5. Idempotent re-application: run sync twice with same response → second pass emits zero patches, `latest_pts` unchanged, `unread_count` unchanged.
6. Stale cursor → server returns code 20900 → buffer dropped, `openConversation` re-fired (mock fake-transport for both routes). After resync, `latest_pts === "0"` (NOT `current_pts`); `server_current_pts` reflects the value carried by the error envelope if any.
7. Page cap: server returns `has_more: true` for 65 pages → loop stops at 64, warn logged, status still `'synced'`.
8. Sender = self → `unread_count` does NOT bump even when `pts > read_pts`.
9. Sender = other, `pts > read_pts`, all commits newly inserted → `unread_count` bumps by exactly the count of qualifying commits.
10. **Re-sync does not double-bump unread:** seed cache with N already-deduped server commits + matching `read_pts < pts`, run sync that returns the same N commits → `unread_count` unchanged (every commit hits the dedupe-skip branch in step 3).
11. **Local-echo ACK does not bump unread:** seed cache with a pending row keyed by `local_message_id=L`, run sync returning a commit `{ local_message_id: L, server_msg_id: S, sender_id: self }` → patch is the swap; `unread_count` unchanged regardless of read_pts.

### Accounts E2E
Add `phase13-sync-gap-fill.ts`:
- alice opens cache-enabled client, snapshots `latest_pts` for alice-bob channel.
- alice disconnects (or simulates a close).
- bob sends N messages to the alice-bob channel (uses manager's bob client).
- alice reconnects → assert `syncOnReconnect` fires automatically, `latest_pts`
  advances to new server high-water, all N messages observable in
  `cachedMessages`.
- Negative path: zero out `SyncStateRecord.latest_pts` before reconnect to
  simulate a bad cursor → assert recovery via 20900 path.

---

## Decisions

The five questions raised during spec review are now resolved. These are
binding for 5B-1c implementation.

1. **Active-subscription source = the existing reconnect registry.**
   `syncOnReconnect` reads from the same `lastSubscriptions` /
   active-subscription registry that `attemptReconnect` already iterates
   to replay subscribes. We do **not** maintain a parallel channel set;
   the two paths share one source so they cannot diverge.

2. **`commit.sender_info` is NOT persisted in 5B-1.** MessageRecord stays
   at its 5B-0 shape. User-profile caching is a future, separate concern;
   keeping `sender_info` out of the message table avoids inflating every
   row with denormalized profile data.

3. **`syncChannel` is per-channel serialised.** The engine maintains a
   `Map<channelKey, Promise<SyncResult>>` (key = `${channel_id}:${channel_type}`).
   A second call against an in-flight channel returns the same promise —
   no duplicate RPC, no merge-time race. The map entry is deleted in a
   `finally` block on the in-flight promise.

4. **Reconnect ≠ sync.** A reconnect succeeds the moment transport + auth
   + subscription replay succeed. Per-channel sync failures log a
   warning and may emit a per-channel L1 event, but they DO NOT mark the
   reconnect itself as failed. The next reconnect (or an explicit
   `syncChannel`) is the natural retry point.

5. **`syncChannel` does not touch `read_pts`.** Read-cursor convergence is
   Phase 5A's job — `markRead` for client-driven advances,
   `applyReadCursorUpdate` for server pushes. Mixing them into 5B-1 would
   blur the single-axis rule and complicate idempotency reasoning.

---

## Sequenced subtasks

| # | Task                                                                   | Gate                                  |
| - | ---------------------------------------------------------------------- | ------------------------------------- |
| 5B-1c | Implement engine: `getChannelDifference` + `commitToMessageRecord` + `syncChannel` + persist | unit tests 1–9 green |
| 5B-1d | Wire `syncOnReconnect` into `attemptReconnect` after subscription replay | reconnect unit test still green |
| 5B-1e | Add `phase13-sync-gap-fill.ts`; run accounts E2E green                  | 13/13 phases pass                     |
| 5B-1f | README: append "Phase 5B" subsection under Roadmap; document `syncChannel` in Cache APIs section | docs review                           |

Each subtask is committable independently. `5B-1c` is the only large diff;
the rest are small.
