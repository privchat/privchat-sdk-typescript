# Web Runtime Integration Notes — Multi-Tab Coordination

> **Scope.** This document is a **design note for `privchat-web`**, the
> upcoming React + shadcn/ui web app that will consume `@privchat/sdk`.
> It is **not** part of `@privchat/sdk` core implementation scope.
>
> **Why this lives here.** It was originally drafted as `Phase 6A`
> inside `@privchat/sdk` while we were still scoping multi-tab against
> the SDK API surface. After review (see git history) we concluded
> that browser-only runtime concerns — `BroadcastChannel` leader
> election, page lifecycle, multi-tab coordination, UI state — belong
> to the web app project, not the platform-neutral SDK that also
> targets Tauri / Electron / Cocos / Kotlin Multiplatform / Node.
>
> The notes are kept in the SDK repo for now because the SDK is the
> only place this work has been thought through. **Move this file to
> `privchat-web/docs/` once that repo exists**; the SDK should not
> grow browser-only runtime code.
>
> **What the SDK provides for the web app's runtime.** The hooks
> needed to drive a multi-tab leader/follower model from the host
> already exist in `@privchat/sdk`:
>
> - `connect()` / `disconnect()` / `dispose()` — lifecycle.
> - `connectionState()` / `sessionSnapshot()` — introspection.
> - `flushOutbox()` / `syncChannel()` / `markRead()` — leader-driven
>   wire operations.
> - `outboxEntries()` / `observeOutbox()` — for follower reads.
> - `observeConversation()` / `cachedChannels()` / `getCachedMessages()` —
>   cache reads from any tab (IndexedDB is shared across tabs natively).
> - `observeEvents()` / `onPushMessage()` / `onReadCursorUpdated()` /
>   `onPeerReadCursorUpdated()` — event surface for cross-tab fanout.
>
> The web app composes these into the leader/follower runtime
> described below; the SDK does not impose the policy.

---

## Goal

When a user opens the same account in N browser tabs, the SDK must
behave as **one logical client** with at most one live WebSocket. v1
locks in a leader/follower runtime: exactly one tab owns the
transport at any given moment; the others read the shared
IndexedDB cache and route writes through the leader.

Concretely 6A delivers:

1. A reliable-enough leader election (lease + heartbeat over
   `BroadcastChannel`, lease persisted in `localStorage`). "Reliable
   enough" = at most one leader almost-always; transient overlap
   during election windows is acceptable as long as outbox dedup +
   server-side idempotency catch it.
2. A clear runtime split: leader runs transport / push absorb /
   sync / outbox flush; follower reads cache + writes outbox + emits
   local-echo.
3. Cache invalidation hints over `BroadcastChannel` so followers
   notice when leader writes the IndexedDB rows they're observing.
4. Graceful degradation when `BroadcastChannel` is unavailable
   (older Safari, Node test runners): every instance behaves as its
   own leader. Server-side idempotency (`local_message_id` dedup,
   `read_pts` MAX-merge) prevents user-visible breakage.

## Non-goals (explicitly out of scope for 6A)

- **No formal consensus.** No Raft/Paxos. Lease + heartbeat is
  intentional; race windows are absorbed by Phase 5C outbox dedup +
  server idempotency.
- **No leader-RPC forwarding for `markRead` / `syncChannel` /
  `flushOutbox` in v1.** These remain leader-only. Followers throw
  `NotLeaderError`. Host-app coordinates if it needs cross-tab
  read-cursor advance (typically by routing UI focus to the leader
  tab, or by waiting for follower→leader promotion). v2 (6B?) can
  add an opaque `client.requestLeaderAction(...)` if real UX needs
  it.
- **No follower local-echo of mark-read state.** A follower's
  `client.markRead()` rejects; the host app waits for promotion or
  forwards via its own coordination.
- **No cross-tab event-bus mirroring.** Each tab has its own L1
  event bus. Followers don't see leader's `message_received`
  events directly — they observe cache invalidations and re-read.
  Push-style cross-tab events are deferred (would need a per-event
  serialise/deserialise contract; not minimal-viable).
- **No media coordination.** Phase 6B handles `media`/file caches
  and per-tab download budgets.
- **No outbox per-tab assignment.** The outbox table is one shared
  table keyed by `local_message_id`. The leader drains it
  globally; followers contribute rows from anywhere.
- **No cookies, no SharedWorker, no ServiceWorker.** v1 is plain
  `BroadcastChannel` + `localStorage`. ServiceWorker-backed leader
  is a credible v2 if real workloads demand it; out of scope here.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  Tab 1 (leader)                Tab 2 (follower)                  │
│  ┌────────────────────┐       ┌────────────────────┐             │
│  │ PrivchatClient     │       │ PrivchatClient     │             │
│  │ ┌────────────────┐ │       │ ┌────────────────┐ │             │
│  │ │ TransportClient│ │       │ │ TransportClient│ │             │
│  │ │  (CONNECTED)   │ │       │ │  (idle/null)   │ │             │
│  │ └────────────────┘ │       │ └────────────────┘ │             │
│  │ MessageStore (mem) │       │ MessageStore (mem) │             │
│  │ OutboxEngine 🟢    │       │ OutboxEngine 🔴   │             │
│  │ SyncEngine 🟢      │       │ SyncEngine 🔴     │             │
│  └─────────┬──────────┘       └─────────┬──────────┘             │
│            │                            │                        │
│            ▼                            ▼                        │
│      ┌──────────┐    invalidate    ┌──────────┐                  │
│      │ Indexed  │◄────────────────►│ Indexed  │                  │
│      │   DB     │                  │   DB     │                  │
│      │ (shared) │                  │  (same)  │                  │
│      └──────────┘                  └──────────┘                  │
│            ▲                            ▲                        │
│            │                            │                        │
│            └──────── BroadcastChannel ──┘                        │
│                  (heartbeat / events)                            │
│                                                                  │
│      ┌──────────────── localStorage ─────────────────┐           │
│      │ leader lease: { tab_id, expires_at, dbName }  │           │
│      └───────────────────────────────────────────────┘           │
└──────────────────────────────────────────────────────────────────┘
```

🟢 active   🔴 dormant (constructor still creates them, but
`flushOutbox()` / `syncChannel()` early-return / throw on a follower)

### Per-instance roles

Every `PrivchatClient` instance starts in **`'unknown'`** role on
construct, then transitions to **`'leader'`** or **`'follower'`** once
election completes (typically <500ms after `connect()` is called).
Role transitions over the lifetime of the instance:

```
unknown ──init──▶ {leader, follower}
follower ──leader_lease_expired+won──▶ leader     (promotion: auto-connect if lastAuth set)
leader ──voluntary_resign──▶ follower             (rare; e.g. tab hidden)
leader ──involuntary_evict──▶ follower            (very rare; another tab forced takeover)
{leader, follower} ──close──▶ closed              (terminal)
```

The host-app can poll the role via `client.tabRole()` or subscribe
to `client.observeTabRole(cb)` to react to promotions.
`observeTabRole` fires immediately with the current role on
subscribe, then on every subsequent transition.

**Promotion replay sequence** (when a follower becomes leader): if
the tab has captured a `lastAuth` (because its host called
`authenticate(...)` while it was a follower), the new leader runs:

```
connect()
  → authenticate(uid, token, deviceId)   // from captured lastAuth
  → for each entry in activeSubscriptions: subscribe(...)
  → syncOnReconnect()                    // 5B-1d wiring
  → flushOutbox()                        // 5C-1d wiring
```

If `lastAuth` is absent (host never authenticated this tab), the
new leader stays in `'leader-but-disconnected'` mode (state =
`'disconnected'`, transport idle) until the host calls
`authenticate(...)`. **v1 deliberately does NOT persist tokens to
IndexedDB or localStorage** — the host owns refresh/storage. A
freshly-promoted leader without `lastAuth` is the host's problem
to fix.

---

## Leader election protocol

### Lease shape (in `localStorage`)

```ts
// Key: `privchat:leader:${dbName}` — scoped to the cache instance,
// so different dbName / different account = different lease.
interface LeaderLease {
  /** Tab-scoped id — fresh per `PrivchatClient` construction. */
  tab_id: string;
  /** Wall-clock millis at which the lease expires. */
  expires_at: number;
  /** Optional: the user_id this leader serves. Cross-checked on
   *  follower side to detect account switches. */
  uid?: string;
  /** Schema version. Future-proofs against changes. */
  v: 1;
}
```

### Election flow

```
on construct:
  tab_id = randomId()
  read lease; if lease.expires_at > now → I'm a follower
                                      → start follower loop
                                      → return
  attempt to claim:
    write lease { tab_id, expires_at: now + 5000, uid }
    via BroadcastChannel: "claim" { tab_id }
    wait 200ms for any "counter_claim" with smaller tab_id
    if got counter_claim from a tab with smaller tab_id:
      yield → become follower
    else:
      I'm leader → start leader loop

leader loop:
  every 2000ms:
    write lease { tab_id, expires_at: now + 5000, uid }
    broadcast "leader_heartbeat" { tab_id, expires_at }

follower loop:
  every 2500ms (slightly out of phase with leader):
    read lease
    if lease.tab_id is missing OR lease.expires_at <= now - 500:
      attempt to claim (above)
    else:
      stay follower

on tab close (`beforeunload`):
  if leader: write lease { tab_id, expires_at: 0 } + broadcast "resign"
```

### Tie-break

When two tabs claim simultaneously, the one with the **lexicographically
smaller `tab_id`** wins. Both tabs see each other's "claim" message,
the loser yields. tab_ids are random, so the tie-break is fair.

### Heartbeat interval / lease window

| Knob | Value | Reason |
| --- | --- | --- |
| Lease lifetime | 5000ms | Long enough to absorb 1–2 missed heartbeats from tab throttling (`requestIdleCallback` style backoff) |
| Heartbeat period | 2000ms | ~2.5x safety margin under throttling |
| Election claim wait | 200ms | Catches simultaneous tabs spawning within the same window; longer makes startup feel sluggish |
| Follower poll period | 2500ms | Detects crashed leader within ~5–7s |

These are constants in v1, not configurable.

### Cross-`dbName` isolation

The lease key includes `dbName`, so an app with two accounts
(different `dbName` per account) sees two independent leaders — one
tab can be leader for account A and follower for account B. This
falls out naturally from the keying.

---

## BroadcastChannel message contract

One channel per `dbName`: `new BroadcastChannel(`privchat:bc:${dbName}`)`.

```ts
type MultiTabMessage =
  // Leader election
  | { type: 'claim'; tab_id: string; uid?: string; v: 1 }
  | { type: 'counter_claim'; tab_id: string; v: 1 }
  | { type: 'leader_heartbeat'; tab_id: string; expires_at: number; v: 1 }
  | { type: 'leader_resigned'; tab_id: string; v: 1 }

  // Cache invalidation hints (leader → followers).
  // Followers re-read the affected scope from IndexedDB; we DO NOT
  // ship the new row content in the BC message (keeps payload small +
  // avoids a duplicate copy + dodges JS structured-clone surprises
  // for Uint8Array-heavy cache rows).
  | {
      type: 'cache_invalidated';
      scope: 'channels' | 'messages' | 'sync_state' | 'outbox';
      /** Optional narrowing key. For `channels` / `sync_state`:
       *  `${channel_id}:${channel_type}`. For `messages`: `${channel_id}:${channel_type}`
       *  (the affected channel — followers re-read the window).
       *  For `outbox`: `outbox_id`. */
      key?: string;
      v: 1;
    }

  // Follower → leader requests
  | { type: 'flush_outbox_requested'; v: 1 }
  | { type: 'sync_requested'; channel_id: string; channel_type: number; v: 1 }
  ;
```

`v: 1` is a schema version for forward-compat. Receivers ignore
messages with unknown `v`.

### Sender / receiver matrix

| Message              | Sender   | Receiver  | Effect                                               |
| -------------------- | -------- | --------- | ---------------------------------------------------- |
| `claim`              | any      | all       | Trigger counter_claim if recipient has smaller tab_id |
| `counter_claim`      | any      | claimer   | Claimer yields if recipient's tab_id is smaller      |
| `leader_heartbeat`   | leader   | followers | Followers refresh their "current leader" memo        |
| `leader_resigned`    | leader   | followers | Followers attempt election immediately               |
| `cache_invalidated`  | leader   | followers | Followers re-read affected IDB rows + fire observers |
| `flush_outbox_requested` | follower | leader   | Leader calls its `flushOutbox()`                     |
| `sync_requested`     | follower | leader    | Leader calls its `syncChannel(channel_id, channel_type)` |

---

## State partitioning

| State               | Owner   | Notes                                                       |
| ------------------- | ------- | ----------------------------------------------------------- |
| `TransportClient`   | leader  | Follower's transport is constructed but never `connect()`'d |
| `lastAuth` (memory) | both    | Each tab's host app provides credentials independently — `client.authenticate(uid, token, deviceId)` runs locally on every tab. The leader USES it to wire up the connection; followers stash it for use after promotion. |
| `MessageStore` (memory) | both | Each tab's MessageStore is independent. Cross-tab convergence happens through IDB invalidations + re-reads. |
| `OutboxEngine`      | leader  | Constructed on every tab but `flushOutbox()` only runs on leader. Follower's `flushOutbox()` throws `NotLeaderError`. |
| `SyncEngine`        | leader  | Same as OutboxEngine — present but disabled on follower.    |
| `EventBus`          | each tab | Local to the tab. Followers don't see leader's bus emits directly. |
| `IndexedDB` (CacheDB) | shared (Dexie auto-coordinates) | The single source of truth. All cross-tab convergence is through it. |
| Leader lease (`localStorage`) | shared | Single row keyed by `dbName`. |

---

## API behaviour matrix

| Method                     | Leader behaviour | Follower behaviour |
| -------------------------- | ---------------- | ------------------ |
| `connect()`                | Establishes WebSocket. | **No-op + warn once** (Decisions §13 "intent-recording"). Resolves immediately; state stays `'disconnected'`. The intent is implicit — promotion always tries `connect()` if `lastAuth` is set. |
| `authenticate(uid, t, d)`  | Sends authorize, advances state, captures `lastAuth`. | **Captures `lastAuth` only** (intent-recording). State stays `'disconnected'`. Used by promotion. |
| `disconnect()`             | Closes WebSocket + clears auth. Voluntarily resigns leadership; broadcasts `leader_resigned`. | **Local teardown only**: clears this tab's `lastAuth` + `activeSubscriptions` + observers; does NOT close the leader's transport on other tabs and does NOT touch the lease (which the leader holds). |
| `subscribeChannel(...)`    | Subscribes via WebSocket. | **Records intent in `activeSubscriptions`** (intent-recording). DOES NOT send to the wire and DOES NOT broadcast. Replayed by promotion. |
| `unsubscribeChannel(...)`  | Unsubscribes via WebSocket. | Removes from `activeSubscriptions`. If the channel was never on the wire (added on this follower since last promotion), the net effect is "intent cancelled". If it was on the wire (recorded via promotion replay), it'll get re-replayed minus this entry on the next promotion. |
| `sendTextMessage(...)`     | Existing Phase 5C path (online → ACK swap; offline → outbox + return queued). | Always returns `'queued'`. Writes pending row to IDB messages + outbox row to IDB outbox. Broadcasts `flush_outbox_requested`. Returns `{ status: 'queued', outbox_id }`. **Cache-disabled follower throws** (no outbox to fall back to). |
| `markRead(...)`            | Existing Phase 5A + 5D path. | **Throws `NotLeaderError`** in v1. |
| `flushOutbox()`            | Drives the engine. | **Throws `NotLeaderError`** in v1. |
| `syncChannel(...)`         | Drives the engine. | **Throws `NotLeaderError`** in v1. |
| `discardOutboxEntry(id)`   | Existing Phase 5C path. | Permitted on follower (pure IDB write + cache mutation + invalidation broadcast). |
| `bootstrapChannels()`      | Calls `entity/sync_entities`; writes IDB; broadcasts `cache_invalidated { scope: 'channels' }`. | **Throws `NotLeaderError`** in v1. Semantically an RPC — DO NOT silently degrade to "read IDB". For local channel list use `cachedChannels()`. |
| `openConversation(...)`    | Reads cache + RPC `message/history/get`; writes IDB; broadcasts `cache_invalidated { scope: 'messages', key: '<channel_id>:<type>' }`. | Reads cache only (the cached emit). The remote-fetch step is skipped — returns the IDB window without an RPC. Document this clearly. |
| `scrollHistory(...)`       | Existing path. | **Throws `NotLeaderError`** in v1 (it's an RPC). |
| `outboxEntries()`          | Reads IDB outbox table. | Same — pure read. |
| `observeOutbox(cb)`        | Subscribes to local OutboxEngine hook + leader-side mutations. | Subscribes; followers refresh on `cache_invalidated { scope: 'outbox' }`. |
| `observeConversation(...)` | Existing path. | Existing path; receives updates via cache_invalidated → re-read → notify. |
| `cachedChannels()` / `getCachedMessages(...)` | Reads in-memory MessageStore. | Same. |
| `tabRole(): 'leader' \| 'follower' \| 'unknown'` | Returns `'leader'`. | Returns `'follower'` (or `'unknown'` during init). |
| `observeTabRole(cb)`       | **Fires immediately with the current role on subscribe**, then on every transition. | Same. |
| `isLeader(): boolean`      | `true` | `false` |

### Why `openConversation` doesn't RPC on follower

`openConversation` does two things: (a) emit the cached IDB window to
the observer, (b) RPC `message/history/get` for the latest server
window. Splitting these:

- (a) is pure-local; works on any tab.
- (b) requires WebSocket; leader-only.

For a follower, returning the cached window without the RPC is the
right behaviour — the leader will RPC on its own
`openConversation` call (or via reconnect/sync paths) and the
follower observes the result via `cache_invalidated`. If the host
app needs the RPC fetch deterministically, it should escalate
(forward to leader / wait for promotion).

---

## Cache invalidation patterns

When the leader mutates the IndexedDB cache, it broadcasts a
`cache_invalidated` hint. Followers act:

| Scope | Follower action |
| --- | --- |
| `channels` (no key) | Re-read entire channel list from IDB; rebuild `MessageStore.channels`; fire `observeChannelList` listeners. |
| `channels` (key) | Re-read one row; upsert into MessageStore.channels; fire listener. |
| `messages` (key required) | Re-read the channel's window from IDB; replace `MessageStore` buffer for that channel; fire `observeConversation` listeners. |
| `sync_state` (key required) | Re-read the row; usually no follower-visible projection (sync_state is engine-internal); reserved for future host introspection. |
| `outbox` (no key) | Re-read entire outbox table; fire `observeOutbox` listeners. |
| `outbox` (key) | Re-read just that row (or detect deletion); fire `observeOutbox` listeners with full snapshot. |

**Coalescing:** the leader buffers invalidation broadcasts within a
50ms tick — multiple writes to the same scope+key collapse into one
broadcast. This keeps follower IDB read load bounded under bursty
push absorption.

---

## Failure modes

| Scenario | Behaviour |
| -------- | --------- |
| Leader tab crashes (no `beforeunload`) | Lease expires after 5s. Followers detect on next poll (within 2.5s + 5s = 7.5s worst case) and elect a new leader. The new leader re-runs `connect()` + `authenticate()` if its host app supplied credentials; otherwise it stays disconnected until the host calls `authenticate()`. |
| Leader tab loses focus / browser throttles timers | Heartbeat may slip; lease may expire briefly; another tab may take over. When the original tab resumes, it sees lease.tab_id !== self → becomes follower. No data loss; outbox + IDB are shared. |
| BroadcastChannel unavailable (Safari < 15.4 etc.) | Each tab acts as its own leader. Multi-tab write conflicts fall to server-side dedup (local_message_id) and IDB transaction safety. Logged once on construct; no error thrown. |
| Two leaders briefly co-exist (election race window) | Both may attempt `flushOutbox`; outbox rows are unique by `local_message_id`, so the slower one's IDB write conflicts and is skipped. Both may attempt sync; sync engine is per-channel-mutex internally — but cross-instance, two engines could both fire `sync/get_difference`. Server is idempotent; result is wasted work. Acceptable. |
| Follower's `lastAuth` token expires while it's a follower | When it's promoted, the `authenticate()` it replays will fail with `auth_expired`. Standard recovery (host app refreshes token + replays) applies. |
| Network disconnects on leader | Leader's existing reconnect logic engages. Lease keeps refreshing (heartbeat is timer-based, not network-based). Followers see no transition. |
| User logs out on one tab (`disconnect()` + cache wipe) | Leader broadcasts `leader_resigned`. Followers detect lease gone + receive resignation; their host app should also call `disconnect()` + clear UI. v1 does NOT auto-cascade logout (host app's responsibility). |

---

## API surface (additions)

```ts
export interface MultiTabOptions {
  /** Disable multi-tab coordination entirely. Default: enabled when
   *  `BroadcastChannel` is available. Useful for tests, SSR, or
   *  hosts that intentionally want every tab to be independent. */
  enabled?: boolean;
}

new PrivchatClient({
  url, cache: { enabled: true, dbName: 'privchat' },
  multiTab: { enabled: true },  // default true if BC available
});

client.tabRole(): 'leader' | 'follower' | 'unknown';
client.isLeader(): boolean;
client.observeTabRole(cb: (role: TabRole) => void): Unsubscribe;
```

New error class:

```ts
export class NotLeaderError extends Error {
  constructor(method: string) {
    super(`${method}() requires the leader tab; this tab is a follower`);
    this.name = 'NotLeaderError';
  }
}
```

---

## Test plan

### Unit (vitest, fake-indexeddb, fake BroadcastChannel)

The MDN-spec `BroadcastChannel` exists in Node 18+ but is process-
local. For unit tests we install a fake that fans out within-process
across multiple `PrivchatClient` instances sharing a `dbName`.

1. **Solo tab → leader.** A single client constructs and elects
   itself leader within the election window.
2. **Two simultaneous tabs.** Two clients construct in the same
   tick; lexicographic tie-break selects one leader; the other is
   follower.
3. **Leader heartbeat keeps lease fresh.** Lease's `expires_at`
   advances every 2s; follower observes and stays put.
4. **Leader graceful resign.** Leader calls `disconnect()` →
   broadcasts `leader_resigned`; follower elects itself within
   200ms.
5. **Leader crash (no resign broadcast).** Stop heartbeating;
   follower detects lease expiry and elects within ~5–7s.
6. **Follower `flushOutbox` / `markRead` / `syncChannel` /
   `bootstrapChannels` / `scrollHistory` throw `NotLeaderError`.**
   `connect` / `subscribeChannel` / `authenticate` resolve
   silently and update local intent state; `connect` warns once.
7. **Follower `sendTextMessage` returns queued + writes outbox.**
   Outbox row visible via `outboxEntries()` on both tabs.
8. **Follower → leader `flush_outbox_requested` triggers leader's
   `flushOutbox()`.** Leader sends, ACKs, deletes outbox row,
   broadcasts `cache_invalidated { scope: 'outbox' }`. Follower
   re-reads and `observeOutbox` fires the empty snapshot.
9. **Cache invalidation: `messages` scope.** Leader receives push,
   absorbs into IDB, broadcasts `cache_invalidated {
   scope: 'messages', key }`. Follower's `observeConversation`
   fires with the new window (re-read from IDB).
10. **BroadcastChannel unavailable.** Construct with `multiTab.enabled:
    true` but no BC global → falls back to "self-leader" mode; no
    throws; warn logged once.
11. **`bootstrapChannels` on follower throws `NotLeaderError`.**
12. **Promotion replays `lastAuth` + `activeSubscriptions`.** A
    follower captured `authenticate()` and two `subscribeChannel`
    calls earlier; on promotion, it auto-runs `connect()` →
    `authenticate(...)` → `subscribe(ch1)` → `subscribe(ch2)` →
    `syncOnReconnect()` → `flushOutbox()`, in that order. State
    ends at `'authenticated'`.
13. **Promotion without `lastAuth` stays leader-but-disconnected.**
    A follower that never had `authenticate()` called gets
    promoted; transport stays idle, state stays `'disconnected'`,
    `tabRole()` returns `'leader'`. Host's later
    `authenticate(...)` triggers the connect path.
14. **Election race quorum.** 5 simultaneously-constructed clients
    converge on exactly one leader; others become followers.
15. **Follower `disconnect()` is local-only.** Calling
    `disconnect()` on a follower clears its in-memory state but
    does NOT broadcast `leader_resigned` and does NOT touch the
    leader's transport. Other tabs (including the leader) see no
    change to their state.

### Accounts E2E — `phase16-multi-tab.ts`

Single phase, single Node process, simulates multi-tab via two
PrivchatClient instances sharing a `dbName`:

- Construct alice-1 and alice-2 with the same `dbName`.
- Both `authenticate(...)`. Verify exactly one becomes leader.
- alice-1 (leader) `bootstrapChannels` + `subscribeChannel`.
- alice-2 (follower) `outboxEntries()` returns the same rows
  (proves IDB is shared).
- alice-2 `sendTextMessage(...)` → returns queued.
- Wait for leader to flush + propagate invalidation.
- Verify the message reaches the server (check via mgr.bob's
  `messageHistory`).
- Resign alice-1 → alice-2 promotes, becomes leader.
- alice-2 successfully runs `markRead` (which would have thrown
  `NotLeaderError` while it was a follower).

Phase 16 exercises the wire-realistic path; unit tests cover the
edge cases.

---

## Decisions

Binding for 6A-1c. User can override before implementation.

1. **Lease in `localStorage`, NOT IndexedDB.** localStorage is
   synchronous and cross-tab; ideal for the lease's small payload.
   IDB would add asynchrony to election decisions for no benefit.

2. **One `BroadcastChannel` per `dbName`** (not one per
   `PrivchatClient`). Channel names: `privchat:bc:${dbName}`.

3. **No leader-RPC forwarding in v1.** Follower throws
   `NotLeaderError` for `markRead` / `syncChannel` /
   `flushOutbox` / `bootstrapChannels` / `scrollHistory`.
   Forwarding via correlation-id BC messages is doable but adds
   significant surface (timeouts, error propagation, response
   shaping) — defer to 6B if real UX demands it.

4. **`sendTextMessage` works on both roles** (transparent dual-
   path). Leader does inline send; follower writes outbox + asks
   leader to flush. The `'queued'` semantic from Phase 5C handles
   this without ceremony.

5. **Cache invalidation messages carry hints, not payloads.**
   Followers re-read IDB. Avoids duplicate-copy correctness traps
   and cuts BC bandwidth at the cost of one extra IDB read per
   change.

6. **Coalesce invalidations within 50ms.** Bursty push absorption
   shouldn't fan out 100 BC messages.

7. **No automatic logout cascade.** When leader's host calls
   `disconnect()` + `clearAll()`, followers see lease vacated /
   IDB cleared but their host app must independently decide to
   tear down. This avoids ambiguous "did the user log out, or did
   they just close that tab?" — only the host can tell.

8. **Each tab has its own L1 event bus.** `observeEvents()` only
   sees events fired in the same tab. `cache_invalidated` →
   re-read → `observeConversation` fires on the follower IS the
   cross-tab convergence path for cache state. Discrete events
   like `outbox_state_changed`, `read_cursor_updated` are NOT
   broadcast in v1 — followers will reconstruct the state via
   `observeOutbox` snapshots / `cachedChannels()` reads.

9. **`MessageStore` is per-tab.** Both tabs maintain their own
   in-memory mirror, populated lazily via reads + invalidation
   refreshes. Memory cost doubles per tab, but state divergence
   is impossible because IDB is the single source of truth.

10. **Tab id format: 16 random hex chars.** Lexicographic
    tie-break is uniformly distributed.

11. **`multiTab.enabled` defaults to `true` when `BroadcastChannel`
    is globally available.** Tests / SSR / hosts that explicitly
    want single-tab semantics opt out via `multiTab.enabled: false`.

12. **Lease key namespaces by `dbName`** so a host running multiple
    accounts (each with its own `dbName`) gets independent leaders
    per account naturally.

13. **Per-API behaviour category on follower.** Every public method
    is classified into one of four buckets so the implementation
    doesn't re-debate this per-method. Buckets are picked by
    semantic, not by mechanism:

    | Bucket | Methods | Behaviour on follower |
    | --- | --- | --- |
    | **Allowed (pure-read / local-only mutation)** | `cachedChannels`, `getCachedMessages`, `observeConversation`, `observeChannelList`, `observeOutbox`, `observeEvents`, `outboxEntries`, `discardOutboxEntry`, `tabRole`, `isLeader`, `observeTabRole` | Run as on leader. No transport involved; pure IDB/memory operations. |
    | **Allowed (queues into shared state)** | `sendTextMessage` | Enqueue to IDB outbox; emit `outbox_state_changed { status: 'pending' }` locally; broadcast `flush_outbox_requested`. Returns `'queued'`. |
    | **Intent-recording (no RPC, replay on promotion)** | `connect`, `subscribeChannel`, `unsubscribeChannel`, `authenticate` | Mutate local state (e.g. `activeSubscriptions`, `lastAuth`) but DO NOT touch the wire. On promotion, the recorded intents are replayed in this order: `connect` → `authenticate` (if `lastAuth` present) → `subscribe` for each channel in `activeSubscriptions` → `syncOnReconnect` → `flushOutbox`. `unsubscribeChannel` removes from the set; if it was added since last promotion, it's a no-op net-wise. `connect` additionally `console.warn`s once per instance. |
    | **No-op (local teardown)** | `disconnect` | Tears down LOCAL runtime state (clears `lastAuth`, `activeSubscriptions`, MessageStore observers in the closing tab) and resigns this tab's role (if leader). Does NOT close the leader's transport on other tabs. |
    | **Throw `NotLeaderError`** | `markRead`, `flushOutbox`, `syncChannel`, `bootstrapChannels`, `scrollHistory`, `sendMessage` (Layer-1), `sendTextMessage` when cache is disabled (no outbox to fall back to), `rpc` / `rpcCall` / `rpcCallTyped`, `subscribe`/`unsubscribe` (Layer-1), `refreshAccessToken` | These methods inherently require the wire OR have a request/response contract that doesn't fit the queue+invalidate model. Host app must wait for promotion or coordinate with leader tab via its own channels. |

    The two `Allowed (queues into shared state)` and
    `Intent-recording` buckets are the load-bearing departures
    from "follower = read-only". They keep the host's UI code
    portable across tabs without forcing every host-app handler to
    branch on `isLeader()`.

---

## Sequenced subtasks

| # | Task | Gate |
| - | ---- | ---- |
| 6A-1 | `src/multitab/` skeleton: `tab-id.ts` (random id), `lease.ts` (localStorage read/write/expire), `channel.ts` (BroadcastChannel adapter + send/receive typing), `messages.ts` (the `MultiTabMessage` union + `v: 1` schema). Pure modules, no PrivchatClient touch. | unit tests for lease + message types |
| 6A-2 | `LeaderElection` class: claim / counter_claim flow, heartbeat loop, follower poll loop, role transitions. Emits `'leader'` / `'follower'` to a callback. Decoupled from PrivchatClient. | unit tests 1–5 + 13 |
| 6A-3 | `MultiTabRuntime` class: wraps the election + cache invalidation broadcast/receive + the leader-only operation gate. Provides `assertLeader(method)` for the API surface to use. | unit tests for invalidation coalescing |
| 6A-4 | Wire into `PrivchatClient`: construct `MultiTabRuntime` when `multiTab.enabled !== false` AND `BroadcastChannel` global exists; gate every leader-only method via `assertLeader`; route `sendTextMessage` follower path through outbox + `flush_outbox_requested`; broadcast invalidations from leader's existing IDB-write sites; handle promotion (replay `lastAuth` + auto-connect) | unit tests 6–12, regression: existing 15/15 accounts E2E still passes (multi-tab disabled by default in the existing test? OR enabled but the test uses a single client instance, which becomes leader) |
| 6A-5 | Add `phase16-multi-tab.ts` accounts E2E | accounts 16/16 |
| 6A-6 | README: append Phase 6A subsection; document the runtime split, the new methods (`tabRole`, `isLeader`, `observeTabRole`), and the `NotLeaderError`. | docs review |

Each subtask is committable independently. 6A-4 is the largest diff
and the only one touching the existing `PrivchatClient` body.

---

## Open work for after 6A

These are **explicitly out of 6A** but are the natural follow-ups:

- **6A.1 (cleanup):** Leader-RPC forwarding for `markRead` /
  `syncChannel` (the host UX of "I just hit the read receipt
  button on tab 2 but it threw" is not great).
- **6B (media):** thumbnail cache, file download state machine,
  storage quota; Phase 6B can build on top of the 6A leader
  contract (downloads should go through leader to avoid 4× the
  bandwidth on quad-tab users).
- **JSON-RPC u64-as-string migration on the remaining routes**
  (currently only `sync/get_difference`). Drive by need: when a
  route's snowflake field actually exceeds 2^53 in production,
  migrate it.
