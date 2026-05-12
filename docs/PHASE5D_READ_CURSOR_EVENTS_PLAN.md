# Phase 5D — Read Cursor Event Consumption Mini Spec

> Status: **draft**, pre-implementation. Freezes the event contract,
> handler semantics, and the no-persistence policy for surfacing read-
> cursor updates to host apps. Phase 5A (markRead + local
> `applyReadCursorUpdate`) is the prerequisite and is already merged.
> Phase 5C (outbox) is unrelated but its `outbox_state_changed` /
> `outbox_drained` event surface is the design template for 5D's
> two-event split.

## Goal

Stop dropping `peer_read_pts_updated` and start surfacing read-cursor
state changes to the host app via L1 events. Today the SDK's
`maybeConsumeReadCursorPush` only handles `self_read_pts_updated`
(updates `channel.read_pts` and zeros `unread_count`); the peer variant
is silently consumed with a stale `// Phase 5B will surface this`
comment that's been there since Phase 5B shipped.

After 5D the host app can:
- Observe its own read-cursor advances (multi-device / cross-tab) via
  a typed L1 event AND keep relying on the existing
  `channel.read_pts` / `unread_count` cache projection.
- Render "peer has read up to message X" badges in 1:1 chats — a
  Web-IM staple — by subscribing to a separate L1 event.

## Non-goals (explicitly out of scope for 5D)

- **No `read_receipts` IndexedDB table.** v1 is event-only. The cache
  surface (`channel.read_pts` for self) does not change. Host apps
  that need persistent peer-read state keep their own copy until a
  later phase decides whether SDK ownership pays its way.
- **No in-memory peer-cursor map either.** Emitting events is
  enough for v1; introducing a per-channel-per-peer Map adds
  observable surface (`peerReadCursors()` getter etc.) and
  invalidation rules we don't need yet. Revisit when a real UI
  surfaces a concrete query.
- **No group peer-read events.** The server only fires
  `peer_read_pts_updated` for **direct (1:1) channels**; group read
  state is query-based on the server (`list_read_members_by_message_pts`),
  not push-based. The TS SDK does not invent a synthetic group-peer
  event. Group read receipts are a future query-API surface.
- **No read-cursor projection to other clients' message rows.** The
  spec does NOT add per-message "read by" metadata to `MessageRecord`.
- **No retry / backoff for missed events.** Read-cursor pushes are
  best-effort; if the SDK misses one (offline, disconnected), the
  host's view of peer-read may lag until the next push or until the
  SDK's hypothetical future "pull peer cursors" RPC is built.
- **No JSON u64 string migration for the notification wire.** The
  notification's `read_pts` is per-channel pts (small integers — far
  below 2^53), so JSON-number → JS number is precision-safe in
  practice. Same protocol-debt note as Phase 5B but lower priority.

---

## Wire contract (frozen by server)

The notification rides on `PushMessageRequest` with
`message_type === ContentMessageType::System` (numeric `5`). The
push's `payload` is the JSON-serialised
`ChannelReadCursorNotification`. **No new RPC route, no new packet
type — the wire is already there; we only change SDK behaviour.**

### `ChannelReadCursorNotification` (server source)

`privchat-protocol/src/notification.rs:28-68`. Shape:

```ts
interface ChannelReadCursorNotification {
  message_type: 'notification';     // outer envelope label
  content: string;                  // human-readable hint, ignored by SDK
  metadata: ChannelReadCursorNotificationMetadata;
}

interface ChannelReadCursorNotificationMetadata {
  /** Always literal "channel_read_cursor_updated". */
  notification_type: 'channel_read_cursor_updated';
  /** Discriminator — self vs peer. */
  visibility: 'self_read_pts_updated' | 'peer_read_pts_updated';
  /** u64 on the wire, JSON number. */
  channel_id: number;
  /** 1 = direct, 2 = group. */
  channel_type: number;
  /** u64 on the wire — server-side `to_string()`'d, so already a
   *  string in JSON. Safe round-trip. */
  reader_id: string;
  /** u64 per-channel pts; JSON number. Per-channel pts is far below
   *  2^53 in practice (precision-safe). */
  read_pts: number;
  /** Server wall-clock millis at broadcast. */
  updated_at: number;
}
```

### Server emission rules (immutable)

`privchat-server/src/service/read_state_service.rs`:

| Trigger                                  | Self push? | Peer push?                              |
| ---------------------------------------- | ---------- | --------------------------------------- |
| User X advances `read_pts` on a direct channel  | Yes — to ALL of X's online connections | Yes — to the OTHER member of the channel |
| User X advances `read_pts` on a group channel   | Yes — to ALL of X's online connections | **No** — group peer state is query-based |
| User X repeats markRead with the same `read_pts` | No — server only broadcasts when `advanced=true` (DB MAX-merge skips no-ops) | No — same gate |
| User X markRead with a smaller `read_pts`        | No — `advanced=false` | No |

Implication: a `peer_read_pts_updated` event ALWAYS implies
`channel_type === 1` (direct). The TS SDK should defensively check
this and `console.warn` if a peer event ever arrives with
`channel_type !== 1` (server bug, not host concern).

### Out-of-order arrival

Network can deliver pushes in any order. If alice receives
`read_pts: 300` after `read_pts: 400`, the existing
`applyReadCursorUpdate` in `client.ts:1266` already MAX-merges:

```ts
const incoming = BigInt(new_read_pts);
const current = BigInt(channel.read_pts);
if (incoming <= current) return;  // no-op, idempotent
```

5D keeps this for the self path. For the peer path, the spec MUST emit
events for ALL incoming pushes (no MAX-suppression) — host apps may
want to log the regressed event for diagnostic purposes. Hosts that
don't care can MAX-merge themselves.

---

## Authoritative state

5D is **stateless on the SDK side** for peer reads. Self reads keep
their existing projection.

```
ChannelRecord.read_pts        ← Phase 5A: self-MAX-merged here.
                                Phase 5D does NOT change this.
ChannelRecord.unread_count    ← Phase 5A: zeroed on self-advance.
                                Phase 5D does NOT change this.

Peer read state               ← NOT stored. Host app subscribes to the
                                event and keeps whatever shape it
                                needs.
```

The single new piece of state is the L1 event emit, which lives in
the existing `EventBus` ring buffer (already replayed via
`recentEvents` / `eventsSince`).

---

## API surface (additions)

### Two L1 event variants

```ts
/**
 * Self-side read-cursor advance. Either:
 *   - We just markRead'd and the server is echoing back the canonical
 *     accepted_read_pts (multi-device convergence); OR
 *   - Another device of ours markRead'd and the server is fanning out
 *     to all of our online connections.
 *
 * The SDK has ALREADY applied this to `channel.read_pts` and zeroed
 * `unread_count` BEFORE the event fires (existing 5A behaviour). The
 * event is purely informational; the cache projection is the
 * authoritative side effect.
 *
 * Fires ONLY when the local `channel.read_pts` actually advances —
 * a duplicate or out-of-order broadcast that fails the MAX-merge is
 * suppressed (see Decisions §3).
 */
interface ReadCursorUpdatedEvent {
  type: 'read_cursor_updated';
  channel_id: string;
  channel_type: number;
  /** Reader is always the current user; kept on the event so
   *  consumers can write generic handlers shared with the peer
   *  variant. */
  reader_id: string;
  /** Decimal string at the SDK boundary. */
  read_pts: string;
  /** Pre-merge `channel.read_pts`. Omitted on cold-start paths where
   *  no prior value exists for the channel. Useful for unread-bump
   *  animations and multi-device convergence diagnostics. */
  previous_read_pts?: string;
  /** Server wall-clock millis. Optional — present on push-driven
   *  paths; absent on direct `markRead` RPC echoes if the server
   *  doesn't surface it (defensive). */
  updated_at?: number;
}

/**
 * Peer-side read-cursor advance. The other member of a 1:1 channel
 * has read up to `read_pts`. The SDK does NOT project this anywhere
 * (no cache write, no IDB row, no in-memory map); host apps render
 * their own "read by" markers.
 *
 * Only fires for direct channels (`channel_type === 1`). Group
 * "peer-read" is query-only on the server and is out of scope for v1.
 *
 * Fires for EVERY peer push the SDK receives. v1 has no peer-state
 * MAX-merge — the server is the only source of truth, and the SDK
 * doesn't keep a copy to diff against.
 */
interface PeerReadCursorUpdatedEvent {
  type: 'peer_read_cursor_updated';
  channel_id: string;
  channel_type: number;     // always 1 in v1; defensively dropped otherwise
  /** The peer who advanced — NOT the current user. */
  reader_id: string;
  read_pts: string;
  /** Reserved for shape symmetry with the self variant. v1 always
   *  omits it (the SDK doesn't track peer state to diff against). */
  previous_read_pts?: string;
  updated_at?: number;
}

type SdkEvent =
  | ...existing variants
  | ReadCursorUpdatedEvent
  | PeerReadCursorUpdatedEvent;
```

### Optional typed helpers

Mirroring the existing `onPushMessage` / `onAuthExpired` shape:

```ts
client.onReadCursorUpdated(cb: (event: ReadCursorUpdatedEvent) => void): Unsubscribe;
client.onPeerReadCursorUpdated(cb: (event: PeerReadCursorUpdatedEvent) => void): Unsubscribe;
```

These are sugar over `observeEvents` + a type filter. They're cheap and
match the existing per-event-type accessor pattern.

### No new public methods on the cache

- No `peerReadCursors()` getter.
- No `observePeerReadCursors(cb)` snapshot subscription.
- No `clearPeerReadState()`.

If a real UI need surfaces these, add them in a follow-up — don't
speculate now.

---

## Handler flow

```
incoming PushMessageRequest
   │
   ▼
maybeConsumeReadCursorPush(push)
   │
   ├─ message_type !== 5 (System)? → return false (not ours, fall through)
   │
   ├─ tryDecodeReadCursorNotification(payload)?
   │       │
   │       └─ null? → return false (might be another system notification
   │                   type; let downstream handlers see it)
   │
   ├─ visibility === 'self_read_pts_updated'
   │       │
   │       ├─ snapshot previous = channel.read_pts (if channel exists)
   │       ├─ applyReadCursorUpdate(channel, type, read_pts)   ← existing
   │       │     │
   │       │     └─ MAX-guard: returns silently if no advance
   │       ├─ if advanced: bus.emit({ type: 'read_cursor_updated',     ← NEW
   │       │                          previous_read_pts: previous,
   │       │                          read_pts: new, ... })
   │       └─ return true (consumed; short-circuit absorb)
   │
   ├─ visibility === 'peer_read_pts_updated'
   │       │
   │       ├─ if channel_type !== 1: warn + return true (defensive — server bug)
   │       └─ bus.emit({ type: 'peer_read_cursor_updated', ... })  ← NEW
   │       └─ return true (consumed; short-circuit absorb)
   │
   └─ unknown visibility? → return false (defensive — let it through;
                            future system notifications might land here)
```

Two correctness invariants:

1. **Early-return for both self and peer.** The push must NOT reach
   `absorbPushIntoCache` or it would be persisted as a regular
   message in the cache buffer (System notifications have empty
   `content` and would clobber sibling rows; 5C's
   `mergeOnPushAbsorb` partially defends against this but the safer
   contract is "don't even try").

2. **Self projection happens BEFORE the event emit.** This way, when a
   host's `read_cursor_updated` listener immediately reads
   `client.cachedChannels()[i].read_pts`, the value is already
   the post-merge one. Same ordering rule the existing `markRead`
   path follows.

---

## Test plan

### Unit (vitest, fake transport)

1. **Self push, advance.** `self_read_pts_updated` with
   `read_pts > channel.read_pts` → `channel.read_pts` updated, event
   fires AFTER the cache write. Event payload includes
   `previous_read_pts` (the pre-merge value) and the new `read_pts`.
   Observers reading the cache inside the event handler see the
   new value.
2. **Self push, no-op MAX-merge.** `self_read_pts_updated` with
   `read_pts <= channel.read_pts` → cache unchanged AND **no event
   fired** (Decision §3). Suppression count tracked via the existing
   MAX-guard; only the log/debug path tracks it.
3. **Self push, cold start (no prior `read_pts`).** Channel exists
   but `read_pts === '0'` and the incoming push has any positive
   value → cache updated, event fires, `previous_read_pts === '0'`
   (or omitted — implementation choice, but the test pins one).
4. **Peer push, direct channel.** `peer_read_pts_updated` with
   `channel_type === 1` → `peer_read_cursor_updated` event fires;
   `channel.read_pts` and `unread_count` are unchanged.
5. **Peer push, group channel (defensive).** `peer_read_pts_updated`
   with `channel_type === 2` → event suppressed; `console.warn`
   fires.
6. **Wire-shape coercion.** `read_pts` is `number` on the wire; the
   event surface exposes it as decimal string. Confirm round-trip
   preserves the value for inputs up to 2^53.
7. **Unknown `visibility`.** `maybeConsumeReadCursorPush` returns
   `false`, push falls through to normal handling, no event fires.
8. **Non-system push** (regular text message) → handler returns
   `false`. Regression guard.
9. **Helpers.** `onReadCursorUpdated(cb)` and
   `onPeerReadCursorUpdated(cb)` filter the bus correctly and
   return working unsubscribe handles.
10. **Multi-device.** Two `self_read_pts_updated` pushes with
    monotonically increasing pts → two events, each with
    `previous_read_pts` matching the prior event's `read_pts`.

### Accounts E2E — `phase15-read-cursor-events.ts`

Single phase, real server, demonstrates the peer path end-to-end:

- alice + bob both online (cache-enabled clients on alice's side; bob
  uses the manager's cache-disabled client which already has
  `markRead` available via `mgr.client('bob').markRead(...)`).
- alice subscribes to the alice-bob direct channel + opens conversation.
- alice attaches a `peer_read_cursor_updated` listener.
- bob calls `mgr.client('bob').markRead(channel, type, current_pts)`.
- alice asserts:
  - exactly one `peer_read_cursor_updated` event fired
  - event.reader_id === bob's user_id
  - event.channel_id matches
  - event.read_pts > '0'
  - event.channel_type === 1 (direct)
- alice's own cache state untouched: `channel.read_pts` and
  `unread_count` are whatever they were before bob's markRead (we
  also assert this — guards against accidental peer-projection bugs).

Optional self-side coverage in the same phase (small):
- alice attaches a `read_cursor_updated` listener.
- alice calls her own `markRead(...)`.
- alice asserts the self event fired with the new pts AND her cache's
  `channel.read_pts` matches the event's `read_pts`.

---

## Decisions

Binding for 5D-1c. The four spec-review questions are resolved here.

1. **Two distinct L1 event types.** `read_cursor_updated` (self) and
   `peer_read_cursor_updated` (peer). Cleaner type narrowing for
   consumers vs a single event with a `visibility` discriminator;
   matches the 5C pattern (`outbox_state_changed` vs
   `outbox_drained`).

2. **No persistence in v1.** No `read_receipts` IDB table, no in-
   memory peer-cursor map. Just events. Stateless surface = no
   invalidation rules to write.

3. **Self event fires AFTER `applyReadCursorUpdate`** AND **only when
   `read_pts` actually advanced.** A no-op MAX-merge (incoming
   `read_pts <= channel.read_pts`) suppresses both the cache update
   AND the event. Rationale:
   - The server already gates broadcast on `advanced=true`, so a no-
     op typically means an out-of-order replay we should ignore.
   - UIs that re-render on every event would flicker on duplicates.
   - Diagnostic visibility belongs in `console.debug`, not L1.

   For the same reason — symmetry — peer events fire on every
   incoming peer push regardless of any prior peer state we'd
   theoretically track. (We don't track any, so "advance" is
   undefined for peer in v1.)

4. **Public helper names: `onReadCursorUpdated` / `onPeerReadCursorUpdated`.**
   Match the L1 event type names. The unprefixed `Read` reads as
   "the current account's" by default; `Peer` is explicit for the
   1:1 counterpart.

5. **Peer event does NOT update cache, IndexedDB, or any in-memory
   state.** Pure event emit. Host apps own peer-read state shape +
   lifetime if they need it. Future phase may add a query API
   (`listPeerReadCursors(channel_id)`) backed by either an SDK-
   internal map or an on-demand server call — that decision
   depends on real Web-IM UI requirements that don't exist yet.

6. **Self event includes `previous_read_pts?: string`** carrying the
   pre-merge value. Useful for unread-counter animations,
   diagnostics, and multi-device convergence logs. Optional because
   the path that materialises the event (`applyReadCursorUpdate`)
   may run when the row was just bootstrapped and there is no
   meaningful "previous" — the field is omitted in that case
   rather than synthesised. Peer event also exposes the field for
   shape symmetry, but in v1 it's always omitted (we don't track
   peer state to diff against).

7. **`reader_id` stays on both events** even though it's redundant on
   the self path (always equals the current user). Symmetric shape
   makes generic handlers cleaner; multi-account / account-switch
   diagnostics get a free correlation key.

8. **Defensive on unexpected `channel_type` for peer events.** If a
   future server bug emits a peer push for a group channel, the
   SDK suppresses the event and `console.warn`s instead of fanning
   it out. Spec contract is "peer events are direct-channel only";
   we hold the line.

9. **Defensive on unknown `visibility` values.** Today only `self_*`
   and `peer_*` are defined. A future server change might add a
   third (group reads, threaded reads, ...). The handler returns
   `false` for unknowns so the push falls through to normal
   handling — defensible default, doesn't lock out forward-compat.

10. **`read_pts` stays JSON number on the wire.** Per-channel pts
    doesn't grow large enough for JS number precision to matter in
    practice. SDK boundary still string-coerces (`String(notif.metadata.read_pts)`)
    for cache consistency. If a future ID-shape RPC needs string-
    format, the broader Protocol-debt issue (TS_SDK_KNOWN_ISSUES.md)
    covers it.

---

## Sequenced subtasks

| # | Task | Gate |
| - | ---- | ---- |
| 5D-1c | `ReadCursorUpdatedEvent` + `PeerReadCursorUpdatedEvent` types in `events.ts`; `SdkEvent` union; export from `index.ts` | typecheck |
| 5D-1d | Update `maybeConsumeReadCursorPush` to emit both events; add `onReadCursorUpdated` / `onPeerReadCursorUpdated` helpers | unit cases 1–9 green |
| 5D-1e | Add `phase15-read-cursor-events.ts` accounts E2E (peer path + small self-path coverage) | accounts 15/15 |
| 5D-1f | README: append Phase 5D subsection; document the two events; update L1 event variants list | docs review |

Each subtask is committable independently. 5D-1d is the largest diff
(~30 lines + tests); the rest are small.

