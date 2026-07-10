# @privchat/sdk

TypeScript SDK for [PrivChat](https://privchat.dev) — a typed, wire-compatible client built on FlatBuffers + msgtrans. Targets browser (web) and Tauri/Electron desktop. Follows the same protocol contract and method-naming conventions as the Rust [`privchat-sdk`](../privchat-sdk).

> **Status:** v0.1.0-alpha. Phase 3 complete (protocol codecs + typed protocol facade + Rust-style RPC sugar + L1 event bus + auto-reconnect + token-refresh primitive). Local message store / outbound queue / sync engine intentionally **not** yet implemented — see [Roadmap](#roadmap).

---

## What's in vs. out

**Currently shipped (good for: admin consoles, customer-service tools, lightweight web management UIs):**

- Transport: WebSocket via `@msgtrans/client`, auto-reconnect with backoff
- Wire format: FlatBuffers protocol codec for every PrivChat message type
- Typed protocol facade: `authorize / sendMessage / subscribe / unsubscribe / rpc / ping`
- Rust-style typed RPC sugar: ~30 methods covering friend / group / channel / blacklist / message / account / presence
- Token refresh primitive (`refreshAccessToken`) + frozen `AuthErrorKind` classification
- L1 strong-typed event bus with sequence-id-based replay (`observeEvents` / `eventsSince` / `recentEvents`)
- Connection-state machine + session snapshot

**Not yet implemented (needed for: full Telegram-Web / WeChat-Web style clients):**

- Persistent message store (IndexedDB / sql.js)
- Local timeline cache + read-through fetch
- Offline outbound queue + retry + persistence
- Read cursor + unread count local projection
- PTS-based sync engine (`get_difference`, `mark_read_to_pts`)
- Multi-tab coordination (BroadcastChannel + leader election)
- Media download state machine

The roadmap below maps how those will land in Phase 4 → 6.

---

## Architecture

The SDK follows a layered "browser-first, server-authoritative" model:

```
┌────────────────────────────────────────┐
│  L1  in-memory store (UI projection)   │   ← short-lived, current view
├────────────────────────────────────────┤
│  L2  IndexedDB read-through cache      │   ← Phase 4+ (planned)
├────────────────────────────────────────┤
│  L3  PrivChat server (source of truth) │   ← always authoritative
└────────────────────────────────────────┘
        ↑                ↑
        │                │
   WS push (delta)   RPC (history / sync / repair)
```

**Authority rules** (these don't move):

| Data                          | Source of truth          |
| ----------------------------- | ------------------------ |
| Message content               | server                   |
| `server_message_id` / `pts`   | server                   |
| Read cursor (`read_pts`)      | server                   |
| `local_message_id` / pending state | client (transient) |
| IndexedDB rows                | cache only (read-through)|

The SDK never lets local state become canonical — IndexedDB rows can be re-fetched from the server at any time.

---

## Quickstart

```typescript
import { PrivchatClient } from '@privchat/sdk';

const client = new PrivchatClient({ url: 'wss://im.example.com:9080/' });

// 1. Lifecycle
await client.connect();

// 2. Auth (Rust-style convenience: layer 2)
//    Refresh-token storage is YOUR responsibility (e.g. localStorage).
const auth = await myBackend.login(username, password);
localStorage.setItem(`refresh_${auth.user_id}`, auth.refresh_token);
await client.authenticate(String(auth.user_id), auth.token, auth.device_id);

// 3. Subscribe to a channel + listen for pushes
await client.subscribeChannel('900710001', 1);
client.onPushMessage((msg) => {
  console.log('new message', msg.server_message_id, msg.payload);
});

// 4. Typed business RPC (no manual rpcCallTyped, no raw routes)
const search = await client.accountSearch('alice');
await client.friendApply(search.users[0]!.user_id, 'hi from web');

// 5. Token expired? Catch + refresh + retry.
client.onAuthExpired(async (e) => {
  if (e.reason === 'recoverable') {
    const stored = localStorage.getItem(`refresh_${auth.user_id}`)!;
    const fresh = await client.refreshAccessToken(stored, auth.device_id);
    if (fresh.refresh_token) {
      localStorage.setItem(`refresh_${auth.user_id}`, fresh.refresh_token);
    }
    await client.authenticate(String(auth.user_id), fresh.access_token, auth.device_id);
  } else {
    /* terminal: force re-login */
  }
});
```

---

## API surface

### Lifecycle

```typescript
client.connect(): Promise<void>;
client.disconnect(): Promise<void>;
client.dispose(): Promise<void>;       // terminal: closes transport + Dexie
client.isConnected(): boolean;
client.connectionState(): ConnectionState;
client.sessionSnapshot(): SessionSnapshot;
client.currentAccessToken(): string | null;
```

`ConnectionState` enum mirrors Rust: `disconnected | connecting | connected | authenticating | authenticated | reconnecting | closing`.

`dispose()` is the **terminal lifecycle hook** for host runtimes (browser tab unmount, Tauri window close, KMP bridge teardown). It cancels reconnect timers, closes the transport, clears in-memory observers, and closes the IndexedDB Dexie handle. **Persisted IndexedDB rows survive** — a freshly-constructed client with the same `cache.dbName` resumes from where the previous instance left off. Use `disconnect()` to suspend the WebSocket while keeping the instance alive; use `dispose()` when the instance itself is going away. Idempotent.

### Layer 1 — Protocol facade (typed, full FlatBuffers fields)

Use these when you need every field on the wire (`MessageSetting`, raw payload bytes, etc.):

```typescript
client.authorize(req: AuthorizationRequest): Promise<AuthorizationResponse>;
client.sendMessage(req: SendMessageRequest): Promise<SendMessageResponse>;
client.subscribe(req: SubscribeRequest): Promise<SubscribeResponse>;
client.unsubscribe(req: SubscribeRequest): Promise<SubscribeResponse>;
client.rpc(req: RpcRequest): Promise<RpcResponse>;
client.ping(req?: PingRequest): Promise<PongResponse>;
```

### Layer 2 — Rust-style convenience (flat-args, mirrors `privchat-sdk` Rust)

```typescript
client.authenticate(userId, token, deviceId): Promise<AuthorizationResponse>;
client.refreshAccessToken(refreshToken, deviceId): Promise<RefreshAccessTokenResult>;
client.subscribeChannel(channelId, channelType, token?): Promise<SubscribeResponse>;
client.unsubscribeChannel(channelId, channelType): Promise<SubscribeResponse>;
client.sendTextMessage({ channel_id, channel_type, from_uid, content }): Promise<SendTextOperationResult>;
client.rpcCall(route, bodyJson): Promise<string>;
client.rpcCallTyped<Req, Resp>(route, req): Promise<Resp>;
```

### Typed business RPC (Phase 3)

Wrappers over `rpcCallTyped` for routes the server actually exposes — verified shape, no JSON gymnastics:

```typescript
// Account
client.accountSearch(query, page?, pageSize?);

// Friend
client.friendApply(targetUserId, message?, source?, sourceId?);
client.friendAccept(fromUserId, message?);
client.friendPending();
client.friendCheck(friendId);
client.friendRemove(friendId);
client.friendSetAlias(targetUserId, alias);

// Blacklist
client.blacklistAdd(callerUserId, blockedUserId);
client.blacklistRemove(callerUserId, blockedUserId);
client.blacklistList(callerUserId);
client.blacklistCheck(callerUserId, targetUserId);

// Channel
client.channelDirectGetOrCreate(targetUserId, source?, sourceId?);
client.channelPin(channelId, pinned);
client.channelHide(channelId);
client.channelMute(channelId, muted);

// Group
client.groupCreate(name, description?);
client.groupInfo(groupId);
client.groupMemberAdd(groupId, userId, role?);
client.groupMemberList(groupId);
client.groupMemberLeave(groupId);

// Message
client.messageHistory(channelId, limit?, beforeServerMessageId?);
client.messageRevoke(serverMessageId, channelId);
client.messageReactionAdd(serverMessageId, emoji);
client.messageReactionRemove(serverMessageId, emoji);
client.messageReactionList(serverMessageId);

// Presence
client.sendTyping(channelId, isTyping, actionType?, channelType?);
client.batchGetPresence(userIds);
```

### L1 event bus

```typescript
client.observeEvents(cb: (env: SequencedSdkEvent) => void): Unsubscribe;
client.lastEventSequenceId(): number;
client.recentEvents(limit: number): SequencedSdkEvent[];
client.eventsSince(fromSequenceId: number, limit: number): SequencedSdkEvent[];

// Type-narrowed helpers
client.onPushMessage(cb): Unsubscribe;
client.onPushBatch(cb): Unsubscribe;
client.onPong(cb): Unsubscribe;
client.onAuthExpired(cb): Unsubscribe;
client.onConnectionStateChanged(cb): Unsubscribe;
```

L1 event variants currently emitted: `connection_state_changed`, `message_received`, `message_batch_received`, `pong_received`, `auth_expired`, `sync_full_rebuild_required` (Phase 5B), `outbox_state_changed` + `outbox_drained` (Phase 5C), `read_cursor_updated` + `peer_read_cursor_updated` (Phase 5D). Reserved for later phases (enum slots only): `message_status_changed`, `entity_changed`, `presence_changed`, `typing_received`, `recovery_lifecycle_changed`.

### Cache APIs (Phase 4 — opt-in)

Default: cache **disabled**. When disabled, every method below throws `CacheDisabledError`. Phase 3 callers see no behaviour change.

```typescript
const client = new PrivchatClient({
  url,
  cache: { enabled: true, dbName: 'privchat' },
});

// One-shot bootstrap: joins entity/sync_entities (channel +
// channel_read_cursor) into local channels table. Pages internally.
await client.bootstrapChannels();

// Sync read of in-memory channel list (sorted by updated_at desc).
const channels = client.cachedChannels();

// Subscribe to channel-list mutations (bootstrap, push-driven re-sort).
const offChannels = client.observeChannelList((list) => { /* sidebar */ });

// Open a conversation:
//   1. emits cached snapshot (is_remote=false) if any
//   2. fetches remote latest window via message/history/get
//   3. merges + persists + emits remote snapshot (is_remote=true)
const remote = await client.openConversation('348', 2, { limit: 50 });

// Scroll older history. Cursor defaults to the oldest in-memory record
// that has a server_message_id (pending rows aren't valid pagination cursors).
const older = await client.scrollHistory('348', 2, {
  beforeServerMessageId: '123456',
  limit: 50,
});

// Sync read of in-memory message buffer (ascending by timestamp; cache
// has no per-channel pts on history rows — pts is push-only).
const cached = client.getCachedMessages('348', 2);

// Subscribe to per-conversation updates (cached / remote / push / local-echo).
const off = client.observeConversation('348', 2, (snapshot, patch) => {
  // snapshot.is_remote distinguishes cache-emit vs server-emit.
  // patch.upserted + patch.removed give incremental UI hints.
});

// Cache introspection.
client.isCacheEnabled(); // true

// Phase 5B-1: pull missed commits via sync/get_difference. Per-channel
// gap-fill — usually you don't call this manually; it auto-fires for
// every active subscription after a successful reconnect.
const result = await client.syncChannel('348', 2);
if (result.status === 'synced') {
  console.log(`applied ${result.commits_applied} commits, latest_pts=${result.latest_pts_after}`);
}
```

```typescript
// SyncResult shape — observable, not a thrown error. The host app
// decides what to do with 'rebuild_required' (typically: prompt the
// user to re-bootstrap or wipe the cache).
interface SyncResult {
  channel_id: string;
  channel_type: number;
  status: 'current' | 'synced' | 'resynced' | 'rebuild_required';
  commits_applied: number;
  pages_fetched: number;
  latest_pts_before: string;
  latest_pts_after: string;
}
```

**Method list:** `bootstrapChannels` / `cachedChannels` / `observeChannelList` / `openConversation` / `scrollHistory` / `getCachedMessages` / `observeConversation` / `markRead` / `syncChannel` / `flushOutbox` / `outboxEntries` / `observeOutbox` / `discardOutboxEntry` / `isCacheEnabled`.

Inbound `PushMessageRequest` / `PushBatchRequest` are absorbed into the cache (memory synchronously, IndexedDB async). `channel.latest_pts` lifts from the highest `pts` in the push; `unread_count` bumps when `from_uid !== currentAccessTokenUser` AND `pts > read_pts` AND not a revoke. The **local-trumps-self-push** merge in `mergeOnPushAbsorb` ensures the server's own-message fan-out (which carries empty content + `'received'` status) cannot regress a row our local-echo / outbox-flush ACK already promoted to `'sent'`.

### `sendTextMessage` operation result (Phase 5C contract)

```typescript
type SendTextOperationResult =
  | {
      status: 'sent';
      local_message_id: string;
      response: SendMessageResponse; // server ACK: server_message_id, message_seq, client_seq, reason_code
    }
  | {
      status: 'queued';
      local_message_id: string;
      outbox_id: string; // outbox row primary key (alias of local_message_id in 5C)
    };

const result = await client.sendTextMessage({
  channel_id: '348',
  channel_type: 2,
  from_uid: '900710001',
  content: 'hello',
});

if (result.status === 'sent') {
  console.log(result.response.server_message_id);
} else {
  // Queued: outbox holds the row; will replay on reconnect or manual flush.
  console.log('outbox_id:', result.outbox_id);
}
```

Two important contracts to keep straight:

- **Layer-1 `client.sendMessage(req)`** (protocol facade): strict reject on
  transport failure / offline. Use this when you want classical Promise
  semantics and don't need the outbox.
- **Layer-2 `client.sendTextMessage(...)`** (SDK convenience): on a cache-
  enabled client, **never rejects on offline**. Offline / mid-reconnect /
  send-failure paths persist the message to IndexedDB and resolve with
  `status: 'queued'`. The cache row stays `pending` until the next
  successful flush. Cache-disabled clients keep the strict reject contract
  (no outbox to fall back to).

### Outbox API (Phase 5C — opt-in with cache)

```typescript
// Manual flush — kicks every channel with due rows. Reconnect auto-fires
// this for you AFTER syncOnReconnect; manual flush is for "Retry all" UX.
const flushed = await client.flushOutbox();
// → { attempted, sent, failed, skipped, remaining }

// Snapshot the persisted outbox rows.
const rows = await client.outboxEntries();
// Optional filters: { statuses, channel_id, channel_type, limit }

// Subscribe to snapshot changes — fires on every state mutation.
const offOutbox = client.observeOutbox((entries) => {
  // Re-render the "pending sends" badge / list.
});

// Drop a row WITHOUT sending. Removes the matching cache `pending` row and
// emits `outbox_state_changed { status: 'discarded' }`.
await client.discardOutboxEntry(localMessageId);
```

```typescript
interface OutboxFlushResult {
  attempted: number;  // rows the engine actively tried to send
  sent:      number;  // rows ACKed and deleted
  failed:    number;  // rows whose attempt failed (transient or rejected)
  skipped:   number;  // rows skipped because state !== 'authenticated'
  remaining: number;  // outbox row count after the flush settles (incl. frozen rows)
}
```

Tuning (all optional):

```typescript
new PrivchatClient({
  url, cache: { enabled: true },
  outbox: {
    enabled: true,           // default: true when cache.enabled
    initialDelayMs: 1_000,   // first retry delay
    maxDelayMs: 30_000,      // backoff cap
    maxAttempts: 8,          // freeze the row after this many transient failures
  },
});
```

### Outbox L1 events

```typescript
client.observeEvents((env) => {
  if (env.event.type === 'outbox_state_changed') {
    // Per-entry transition. status ∈ pending | sending | sent | failed | discarded.
    // 'sent' / 'discarded' are transient — the row is deleted at/before emit.
    console.log(env.event.status, env.event.local_message_id, env.event.last_error);
  }
  if (env.event.type === 'outbox_drained') {
    // The queue went from non-empty to empty. Toggle a "global pending" badge off.
  }
});
```

### Phase 5C boundaries

What 5C explicitly **does not include** (deferred to Phase 6 or later):

- Multi-tab outbox coordination via `BroadcastChannel` / leader election
- Media upload queue (chunked file send, thumbnail cache)
- E2EE payload queue
- Complex retry-policy UI (e.g. user-tunable backoff curves, per-message priority)
- Automatic `mark_read` triggered by outbox flush (still Phase 5A's concern)
- Peer read-receipt UI events — delivered in Phase 5D (`peer_read_cursor_updated`)

Detailed state machine, decisions, and merge invariants:
[docs/PHASE5C_OUTBOUND_QUEUE_PLAN.md](./docs/PHASE5C_OUTBOUND_QUEUE_PLAN.md).

### Read cursor events (Phase 5D)

Two L1 events surface the read-cursor state changes that the server
broadcasts via `PushMessageRequest` with `message_type = System` (5).
The SDK already consumed `self_read_pts_updated` internally for the
`channel.read_pts` projection (Phase 5A); 5D adds the host-visible
events and starts handling `peer_read_pts_updated` instead of dropping
it.

```typescript
// Self: fires when the local channel.read_pts actually advances —
// driven by either markRead RPC echoes or self_read_pts_updated push.
// No-op MAX-merges (incoming <= current) are suppressed.
client.onReadCursorUpdated((event) => {
  console.log('my read cursor advanced', event.read_pts, event.previous_read_pts);
});

// Peer: direct-channel only. The other member of a 1:1 channel has
// read up to `read_pts`. Cache is NOT updated; host renders its own
// "read by" markers.
client.onPeerReadCursorUpdated((event) => {
  console.log('peer read cursor advanced', event.reader_id, event.read_pts);
});
```

```typescript
interface ReadCursorUpdatedEvent {
  type: 'read_cursor_updated';
  channel_id: string;
  channel_type: number;
  /** Always the current user; kept for shape symmetry with the peer event. */
  reader_id: string;
  read_pts: string;
  /** Pre-merge value. Omitted on cold-start paths where no prior row existed. */
  previous_read_pts?: string;
  /** Server wall-clock millis. Present on push-driven paths;
   *  absent on the markRead RPC echo (the server response doesn't
   *  carry it). */
  updated_at?: number;
}

interface PeerReadCursorUpdatedEvent {
  type: 'peer_read_cursor_updated';
  channel_id: string;
  /** Always 1 (direct) in v1. Group peer reads are query-only on the
   *  server; the SDK suppresses + warns on any push with another type. */
  channel_type: number;
  /** The peer who advanced — NOT the current user. */
  reader_id: string;
  read_pts: string;
  /** Reserved for shape symmetry. v1 always omits it (the SDK doesn't
   *  track peer state to diff against). */
  previous_read_pts?: string;
  updated_at?: number;
}
```

`markRead` semantics (Phase 5A + 5D combined):

```typescript
const result = await client.markRead('348', 2, '50');
// 1. Sends `message/status/read_pts` to the server.
// 2. On success, MAX-merges the local channel.read_pts against the
//    server-accepted pts. Zeros unread_count if it advanced.
// 3. If (and only if) the local cursor advanced, emits
//    `read_cursor_updated`. A no-op markRead (smaller pts) does not.
```

#### Phase 5D boundaries

What 5D explicitly **does not include**:

- No `read_receipts` IndexedDB table — events only.
- No in-memory peer-cursor map — host apps own peer-read state.
- No group peer-read events — the server's group read state is
  query-based, not push-based; future work may add a `listPeerReads`
  RPC surface.
- No per-message "read by" projection on `MessageRecord`.
- No retry / backoff for missed events — read-cursor pushes are
  best-effort. Reconnect doesn't replay them.
- No multi-device self-push test in `accounts/phase15` — the harness
  uses one device per account; the self event is exercised through
  the `markRead` RPC echo, the push path is covered by unit tests.

Detailed wire contract, decisions, and handler flow:
[docs/PHASE5D_READ_CURSOR_EVENTS_PLAN.md](./docs/PHASE5D_READ_CURSOR_EVENTS_PLAN.md).

---

## Token refresh contract

Frozen by `TOKEN_REFRESH_SPEC`. The SDK is deliberately stateless about refresh tokens — **the business layer owns persistence**.

| Step                       | Owner          |
| -------------------------- | -------------- |
| Capture `refresh_token` from login response | business |
| Persist (`localStorage` / Tauri keychain)    | business |
| Detect expiry (catch `auth_expired` event)  | business |
| Call `client.refreshAccessToken(...)`        | business → SDK primitive |
| Store rotated `refresh_token` if returned    | business |
| Replay `client.authenticate(...)`            | business |

Error classification (`AuthErrorKind`):

| Code(s)                           | Kind          | Action                              |
| --------------------------------- | ------------- | ----------------------------------- |
| `10000` AuthRequired, `10002` TokenExpired | recoverable   | Refresh + replay `authenticate`     |
| `10001 / 10003..10010`            | terminal      | Force re-login                      |
| anything else (incl. 5xx)         | transient     | Auto-reconnect retries              |

Reconnect logic respects this: on `authenticate` failure during reconnect, recoverable stops the cycle and emits `auth_expired` (waits for business layer); terminal clears `lastAuth` and stays disconnected.

---

## Reconnect

Default behaviour: enabled, exponential backoff `1s → 2s → 4s → ... → 30s`, infinite attempts.

```typescript
new PrivchatClient({
  url: '...',
  reconnect: {
    enabled: true,
    initialDelayMs: 1_000,
    maxDelayMs: 30_000,
    multiplier: 2,
    maxAttempts: Infinity,
  },
});
```

On reconnect after unexpected close:
1. Re-establish transport (with backoff).
2. Replay last successful `authenticate(uid, token, deviceId)`.
3. Re-subscribe every channel that was active.
4. **Sync active channels** (5B-1): for each active subscription, call `syncChannel(...)` in parallel via `Promise.allSettled`, pulling any commits missed while offline.
5. **Flush the outbox** (5C): `flushOutbox()` drains queued sends. **Order matters** — sync runs before flush so any commit the server accepted-but-didn't-ACK is observed first; the engine then sees the matching `server_message_id` already present locally and short-circuits the row to deletion without re-sending.
6. On step 2 failure → emit `auth_expired` and stop the cycle.

The reconnect itself does NOT depend on steps 4 or 5 succeeding. A per-channel sync or flush failure is logged via `console.warn` and otherwise ignored — the next reconnect (or an explicit `client.syncChannel(...)` / `client.flushOutbox()`) will retry. This keeps the connection-state machine single-axis: transport+auth+subscribe drive `connectionState`, sync + outbox convergence is observable but independent.

---

## Roadmap

The SDK is being built in phases. Each phase is gated by a real-server E2E run (`examples/accounts`).

**Phase 5 closed the SDK as a runtime foundation** (tag
`ts-sdk-phase5-web-im-runtime`): protocol, reconnect, IndexedDB cache,
sync, outbox, read cursor events, and lifecycle disposal. Browser-only
runtime concerns (multi-tab leader election, page-visibility policy,
React timeline UI) move to the consuming `privchat-web` app — see
the Phase 6 row below. The SDK stays platform-neutral so it can also
serve Tauri, Electron, Cocos Creator, and Kotlin Multiplatform hosts.

| Phase | Status | Scope |
| ----- | ------ | ----- |
| **1** | ✅ done | FlatBuffers protocol codec + cross-language fixture verification |
| **2** | ✅ done | `PrivchatClient` with typed protocol facade + push handlers |
| **3** | ✅ done | RPC sugar / L1 event bus / auto-reconnect / token-refresh primitive / state queries |
| **4** | ✅ done | **Opt-in cache-first-read-through IndexedDB store** (Dexie). `bootstrapChannels` joins `entity/sync_entities` (channel + read_cursor) into local `channels`. `openConversation` emits cached then remote. `scrollHistory` paginates by `before_server_message_id`. Inbound push absorbed into memory + IndexedDB. `sendTextMessage` performs local echo (pending → sent ACK). |
| **5A** | ✅ done | **Read-cursor projection**: `client.markRead(channel, type, read_pts)` calling `message/status/read_pts`; idempotent MAX-merge into local `channel.read_pts`; multi-device convergence via the `self_read_pts_updated` system push (`applyReadCursorUpdate`). |
| **5B** | ✅ done | **Reconnect gap-fill sync engine**: `client.syncChannel(channel, type)` driving `sync/get_difference`; per-channel mutex; 20900 `SyncChannelResyncRequired` recovers via `openConversation`; 20902 `SyncFullRebuildRequired` emits an L1 event for the host to handle; `latest_pts` persisted in `sync_state`; auto-fires for every active subscription after reconnect. |
| **5C** | ✅ done | **Persistent outbound queue**: `sendTextMessage` resolves with a discriminated `'sent' \| 'queued'` result instead of rejecting on offline. Outbox rows persist in IndexedDB across page reloads; `flushOutbox` drains them with per-channel FIFO + exponential backoff; reconnect auto-flushes after sync; ACK swap converges the cache `pending` row to `sent`; `outbox_state_changed` + `outbox_drained` L1 events. Local-trumps-self-push merge protects the acked row from server fan-out. |
| **5D** | ✅ done | **Read cursor event consumption**: `read_cursor_updated` fires when the local `channel.read_pts` actually advances (no-op merges suppressed) — sourced from both `markRead` RPC echoes and `self_read_pts_updated` push. `peer_read_cursor_updated` fires for direct-channel peer reads, sourced from `peer_read_pts_updated` push (group peer reads stay query-only). No persistence, no peer-state map — events only. |
| **6** | moved to `privchat-web` | **Multi-tab + media** are browser/web-app concerns, not SDK core. The SDK is platform-neutral (also targets Tauri / Electron / Cocos Creator / Kotlin Multiplatform); `BroadcastChannel` leader election, page lifecycle, IndexedDB ownership policies, and React-side timeline UI live in the consuming web app. The SDK exposes the lifecycle hooks (`connect` / `disconnect` / `dispose`), state queries, and event observers needed to drive a multi-tab runtime from the host. See [`docs/WEB_RUNTIME_INTEGRATION_NOTES.md`](./docs/WEB_RUNTIME_INTEGRATION_NOTES.md) for the design notes. |

### Phase 4 behaviour

#### Terminology

| SDK | Storage model |
| --- | ------------- |
| Rust `privchat-sdk` | **local-first** — local DB is the primary read source; a background sync engine keeps it close to the server |
| TS Web SDK Phase 4   | **cache-first-read-through** — IndexedDB is an acceleration cache; the server is always the primary read source |
| TS Web SDK Phase 5+  | **web-constrained local-first-lite** — once `sync/get_difference` + PTS + read-cursor projection land, the SDK approaches (but does not match) Rust's local-first model |

The TS SDK is deliberately **not** a port of the Rust local-first engine. Browser constraints (weaker IndexedDB transactions, eviction, multi-tab, Safari quirks) make a 1:1 port the wrong target.

#### New-device login

A newly-installed web client **does not download all historical messages**. It bootstraps channel watermarks and fetches message bodies only when the user opens or scrolls a conversation:

| Step | Action | Loads message bodies? |
| ---- | ------ | --------------------- |
| Authenticate            | `client.authenticate(...)`                                                                                                | No |
| Bootstrap channels      | `client.bootstrapChannels()` joins `entity/sync_entities("channel")` + `("channel_read_cursor")` into local `channels`     | No |
| Open conversation       | `client.openConversation(...)` emits the cached window first, then RPC `message/history/get`, merges, writes back          | Yes — one window |
| Scroll up               | `client.scrollHistory(..., { beforeServerMessageId })` pages backwards via `before_server_message_id`                      | Yes — paginated |
| Receive push (live)     | the SDK absorbs `PushMessageRequest` / `PushBatchRequest` into the in-memory store + IndexedDB and notifies observers      | Only the new message |
| Send text               | `client.sendTextMessage(...)` inserts a `pending` record, swaps to `sent` after server ACK                                  | n/a (local echo) |

The bootstrap call returns metadata + cursors only. The SDK does not do a full-history sync at login.

#### `read_pts` is a high-water mark, not a list

`read_pts` is a per-user, per-channel high-water mark: "messages with `pts <= read_pts` are read", not "the set of read message ids". `bootstrapChannels` reads it from `channel_read_cursor.last_read_pts` per channel; channels without a cursor row default to `"0"`. Multi-device unread sync is a single integer per channel, not a join over a read-receipt table. The Phase 4 SDK reads `read_pts`; Phase 5A adds `client.markRead(...)` (route `message/status/read_pts`) which advances the cursor and is mirrored locally; Phase 5D additionally surfaces every actual advance as a `read_cursor_updated` L1 event (no-op merges suppressed).

#### IndexedDB schema (Phase 4)

All snowflake / u64 ids are carried as `string` at the cache + public API boundary (FlatBuffers internals use `bigint`). This avoids JS `number` precision loss above 2^53 and matches the Rust SDK's `StoredMessage` distinction between three id roles.

```typescript
// channels — bootstrap result + ongoing state. Compound primary key.
{
  channel_id: string;
  channel_type: number;
  title?: string;
  latest_pts: string;          // per-channel pts; lifted by push (history wire has no pts)
  read_pts: string;            // per-user read cursor; defaults to "0" when no cursor row
  unread_count: number;        // server-computed value; SDK does NOT recompute it
  last_message_preview?: string;
  updated_at: number;
  sync_version: number;        // Phase 5 incremental-sync token
}

// messages — partial cache; server is source of truth.
// Identity fields:
//   - server_message_id: server-assigned snowflake (delivered rows + ACKed sends)
//   - local_message_id : client-side snowflake (pending rows pre-ACK; nulled by server)
//   At least one of the two is always present; both may coexist on an ACKed send.
//   pts is per-channel and only carried by push / send-ACK, NOT by message/history/get.
{
  channel_id: string;
  channel_type: number;
  server_message_id?: string;  // server snowflake; undefined while a send is pending
  local_message_id?: string;   // client snowflake; set by sendTextMessage local echo
  pts?: string;                // per-channel pts (BigInt-compared); undefined for history rows
  from_uid: string;
  message_type: string;        // application content type ("text"/"image"/...) — mirrors Rust StoredMessage
  content: string;
  payload: Uint8Array;          // raw FlatBuffers payload from push (empty for history rows)
  timestamp: number;            // sort key for the in-memory window (always present)
  status: 'received' | 'pending' | 'sent' | 'failed';
  revoked: boolean;
  mime_type?: string;
}

// sync_state — what window is locally loaded per channel. Bounds are
// timestamps because history wire carries no pts.
{
  channel_id: string;
  channel_type: number;
  min_loaded_at?: number;
  max_loaded_at?: number;
  latest_pts?: string;          // populated once Phase 5 PTS engine lands
  last_sync_at: number;
}
```

Compound primary keys: `channels &[channel_id+channel_type]`, `messages &[channel_id+channel_type+record_key]`, `sync_state &[channel_id+channel_type]`. Secondary indexes: `channels.updated_at`, `messages.[channel_id+channel_type+timestamp]`, `messages.[channel_id+channel_type+server_message_id]`.

`record_key` is an internal string derived as `s:<server_message_id>` when the row is server-acknowledged, else `l:<local_message_id>`. It is added by the IndexedDB layer (not part of the public `MessageRecord`) so a pending row can swap identity to its server-assigned id atomically as `removed=['l:...']` + `upserted=[acked]`.

#### Four read paths (kept distinct)

```
bootstrap():            channel list + cursors only             (no message bodies)
openConversation():     IndexedDB window → RPC latest → merge   (one window of bodies)
scrollHistory():        RPC before_server_message_id pagination (more bodies, on demand)
push (inbound):         decode → in-memory upsert → emit → async IndexedDB write
```

UI never waits on IndexedDB writes. Push is fully asynchronous from a storage perspective; observers fire from memory in the same microtask the packet arrived in.

#### Send path

`sendTextMessage` inserts a `pending` MessageRecord keyed by `local_message_id` (record_key `l:<local_message_id>`), then RPC-sends. On ACK the record is replaced with `status: 'sent'` + the real `server_message_id` + `pts` — a single patch carries `removed=['l:<local_message_id>'] + upserted=[acked]` (the new row's record_key is `s:<server_message_id>`). On transport throw or non-zero `reason_code`, the record is marked `failed`. No persistent outbound queue (Phase 5).

#### Authority rules

IndexedDB is **cache-only**. Server `pts` always wins on conflict. The SDK refuses to treat IndexedDB as authoritative — it can be wiped, re-populated from the server, and the user state is unaffected.

#### What Phase 4 explicitly does NOT include

- Persistent outbound queue (deferred — see Phase 5B boundaries)
- PTS sync engine / `sync/get_difference` gap-fill on reconnect (delivered in Phase 5B-1)
- Read-cursor write path / auto `mark_read` (delivered in Phase 5A)
- Multi-tab coordination via `BroadcastChannel` / leader election (Phase 6)
- Media download state machine + thumbnail cache (Phase 6)

### Phase 5B-1 behaviour

Reconnect-driven gap-fill via `sync/get_difference`. After a successful re-authenticate the SDK fires `syncChannel(...)` for every active subscription in parallel; commits are merged into the cache, `channel.latest_pts` is lifted, and `unread_count` bumps for newly-inserted foreign messages whose `pts > read_pts`. Per-channel mutex inside the engine prevents concurrent passes on one channel.

Recovery codes:

| Code  | Status returned     | Cache effect                                                                                       |
| ----- | ------------------- | -------------------------------------------------------------------------------------------------- |
| 20900 | `'resynced'`        | Buffer wiped + re-hydrated via `openConversation`. `latest_pts` reset to `"0"` (NOT lifted to the error envelope's `current_pts`). |
| 20902 | `'rebuild_required'`| Cache untouched. L1 event `sync_full_rebuild_required` emitted; host app decides recovery UX.      |

#### What Phase 5B-1 explicitly does NOT include

- Persistent outbound queue / retry on send failure (delivered in Phase 5C)
- Background periodic sync (only fires on reconnect or explicit `syncChannel`)
- Multi-tab coordination via `BroadcastChannel` (Phase 6)
- Peer read-receipt UI events (delivered in Phase 5D)
- Media download state + thumbnail cache (Phase 6)
- Server-side u64-as-string serialization on JSON RPC routes — see [docs/TS_SDK_KNOWN_ISSUES.md](./docs/TS_SDK_KNOWN_ISSUES.md)

Detailed state machine, merge rules, and decision rationale: [docs/PHASE5B_SYNC_ENGINE_PLAN.md](./docs/PHASE5B_SYNC_ENGINE_PLAN.md).

---

## Examples

`examples/accounts/` — multi-account E2E that registers / authenticates / friends-systems / direct-sends / searches / blacklists across alice / bob / charlie against a real `privchat-server`. See `examples/accounts/README.md` for run instructions.

```bash
npm run example:accounts
```

---

## Development

```bash
npm install
npm run typecheck    # tsc --noEmit
npm test             # vitest run — 353 unit tests
npm run build        # prebuild(codegen) + tsc -p tsconfig.build.json → dist/
npm run example:accounts   # requires a running privchat-server
```

Use **npm** — both `package-lock.json` and `pnpm-lock.yaml` are checked in, but
every script and doc here is npm-based.

### Build & package

`npm run build` compiles **ESM only** (`import`, no CJS `require`) with type
declarations, driven by plain `tsc` (`tsconfig.build.json`) — no bundler:

- output: `dist/index.js` (`main`), `dist/index.d.ts` (`types`), plus source maps
- `prebuild` regenerates FlatBuffers first (see below), so `dist/` always tracks the wire format
- the npm tarball ships only `["dist", "README.md", "LICENSE"]` (`files` field)

> **Not yet published.** `package.json` is `"private": true` with no
> `prepublishOnly`/`publishConfig` — publishing is intentionally disabled while
> the API stabilizes. The first external release will go to npm on a **beta**
> tag (scoped public package `@privchat/sdk`); until then, consume it via a
> `file:`/workspace link to a sibling clone.

FlatBuffers codegen runs automatically via `prebuild` (`scripts/codegen.mjs`). The generator reads `.fbs` files **directly from a sibling clone of `privchat-protocol`** — there is no vendored schema copy in this package, so the wire format is single-sourced and any drift surfaces immediately as a compile error.

#### Required layout

```
<parent>/
├── privchat-protocol/protocol/*.fbs   ← canonical wire format (must be cloned as sibling)
└── privchat-sdk-typescript/           ← this package
```

If `../privchat-protocol/protocol/` is missing, `npm run codegen` fails fast with instructions. Downstream npm consumers are unaffected — they install the published `dist/` (already-generated TS), not the `.fbs` files.

### Cross-language fixture verification

Round-trips the wire format Rust ↔ TS:

```bash
# from privchat-protocol/
cargo run --example cross_lang_fixtures           # dump → tests/fixtures/from-rust/
# from privchat-sdk-typescript/
npm test                                           # decode + re-encode → tests/fixtures/from-ts/
# from privchat-protocol/
cargo run --example cross_lang_fixtures verify    # decode TS bytes back to Rust structs
```

---

## Project layout

```
src/
├─ codec/                 FlatBuffers wrapper per protocol message
│  ├─ ping.ts / subscribe.ts / send.ts / push.ts / rpc.ts / auth.ts / payload.ts / ids.ts
├─ generated/             flatc output (gitignored, regenerated by prebuild)
├─ message-type.ts        MessageType + SubscribeAction enums
├─ defaults.ts            ClientInfo / DeviceInfo defaults
├─ auth-error.ts          AuthErrorKind + classifyAuthErrorCode
├─ events.ts              EventBus + L1 SdkEvent union
├─ routes.ts              RPC route constants
├─ api-types.ts           Typed Request/Response shapes
├─ api-methods.ts         Prototype-augmented RPC sugar
├─ client.ts              PrivchatClient (lifecycle / state / facade)
└─ index.ts               Public surface

tests/
├─ *-roundtrip.test.ts        Codec round-trips
├─ cross-lang.test.ts         Rust ↔ TS fixture verification
└─ client/                    PrivchatClient behaviour
   ├─ protocol-facade.test.ts
   ├─ convenience.test.ts
   ├─ push.test.ts
   ├─ refresh-token.test.ts
   ├─ error-classification.test.ts
   ├─ events.test.ts
   ├─ reconnect.test.ts
   ├─ state-queries.test.ts
   ├─ api-methods.test.ts
   └─ fake-transport.ts

examples/accounts/        Multi-account E2E against a real server
```

---

## Compatibility

- Node.js ≥ 18 (uses native `WebSocket` polyfill via `@msgtrans/client`)
- Browsers with native WebSocket (all evergreen)
- Tauri / Electron via the same `@msgtrans/client` transport

Wire format is identical to the Rust `privchat-sdk` (verified by cross-language fixtures), so a TS web client can talk to a Rust mobile client through the same `privchat-server`.

---

## License

Apache-2.0
