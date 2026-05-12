# TS SDK — Known Issues

Working list of behaviours that diverge from spec or surprise us during E2E.
Each entry should carry: an observed symptom, a likely cause, the user-facing
impact today, and a clear next action. Resolved entries get archived in
`KNOWN_ISSUES_RESOLVED.md` once their fix lands.

---

## ~~Push absorption clobbers own-message ACK swap~~ **RESOLVED**

**Found:** 2026-05-05, during Phase 5C-1f.
**Resolved:** 2026-05-05, by the local-trumps-self-push merge fix.

### What landed

Two complementary changes:

1. **`mergeOnPushAbsorb(existing, incoming, ctx)`** (`src/cache/merge.ts`)
   gates push absorption: if `incoming.from_uid === currentUserId` AND
   `existing.status === 'sent'`, the merge preserves existing's
   `content` / `status` / `payload` and only absorbs `pts` / `revoked`
   from incoming. `absorbPushIntoCache` calls this before every
   memory + IDB write, so the push cannot regress an acked row even
   when it lands AFTER the ACK swap.

2. **`MessageStore.replaceMessage`** now filters BOTH `oldRecordKey`
   AND `messageRecordKey(next)` from the buffer before adding `next`.
   Handles the symmetrical race: push arrives BEFORE the ACK swap, so
   the buffer contains a row keyed by `s:<serverId>` from the push;
   then ACK swap runs `replaceMessage(... 'l:<localId>', acked, ...)`
   where `acked` is also keyed by `s:<serverId>`. Without the new-key
   filter, the buffer would end up with two rows under the same key.

Phase 14's strict cache-row assertion is restored: alice2 subscribes
to her own channel and the server fans the push back, but the cache
row stays at `status: 'sent'` with the original content.

### Coverage
- `tests/cache/merge.test.ts` — 7 cases for `mergeOnPushAbsorb` (no
  existing / own-sent preservation / pts absorb / revoked promote /
  remote push pass-through / non-sent existing / undefined currentUserId).
- `tests/cache/message-store.test.ts` — added 1 case for the
  push-arrived-before-ACK race.
- `accounts/phase14-outbox` — strict cache-row assertion + the cache
  observer subscribed to its own channel to deliberately exercise
  the push fan-out.

---

## u64 precision loss on JSON RPC routes (sync wire)

**Found:** 2026-05-04, during Phase 5B-1e (`accounts` E2E `phase13-sync-gap-fill`).

### Observed
For a single logical message, the `server_message_id` carried by the
sender's `SendMessageResponse` (FlatBuffers wire) and the same id as it
arrives in the recipient's cache via `sync/get_difference` (JSON wire)
disagree on the lowest ~6 bits **when the snowflake exceeds the JS safe
integer range (2^53 − 1 ≈ 9.0×10^15)**.

Concrete capture:

```
sendTextMessage response (FlatBuffers)  → server_message_id = "574217498245861376"
sync/get_difference commit (JSON)       → server_message_id = "574217498245861400"

sendTextMessage response (FlatBuffers)  → server_message_id = "574217498359107584"
sync/get_difference commit (JSON)       → server_message_id = "574217498359107600"
```

The low bits round to multiples of ~24 / ~16 — the unmistakable signature
of an integer round-trip through IEEE 754 `double`.

### Root cause (confirmed)
`sync/get_difference` (and every other JSON RPC route that carries u64
ids) emits `server_msg_id`, `pts`, `local_message_id`, `channel_id`,
`sender_id` as JSON `Number`. JavaScript's `JSON.parse` decodes JSON
numbers to `f64`, losing the lower bits of any value above 2^53. The
SDK's TS-side coercion `String(num)` then materialises the rounded
value as a string, which is what lands in the cache.

This is the **"Protocol debt"** already flagged in
[`docs/PHASE5B_SYNC_ENGINE_PLAN.md`](./PHASE5B_SYNC_ENGINE_PLAN.md#protocol-debt-json-u64-is-not-precision-safe-in-javascript).

### Where it isn't
- **NOT in the push fan-out path.** `create_push_message_request`
  (`send_message_handler.rs:2056`) assigns `message_record.message_id:
  u64` directly into the FlatBuffers `PushMessageRequest` struct. No
  JSON intermediate. The push wire is precision-safe.
- **NOT in the SDK's FlatBuffers codec.** Both encode and decode go
  through `bigintToIdString` / `idStringToBigint`, verified by
  `tests/send-roundtrip.test.ts` and `tests/push-roundtrip.test.ts`.
- **NOT in `sendTextMessage`'s ACK path.** The ACK comes back via
  FlatBuffers, lossless.

The drift only happens on JSON RPC routes that carry u64 fields as
JSON numbers — currently the entire `sync/*` family, parts of
`message/*`, etc.

### Impact today
- **`accounts` phase13** matches gap-fill messages by **content**, not
  `server_message_id`, until the server is fixed. See
  `examples/accounts/src/phases/phase13-sync-gap-fill.ts` →
  `TODO(precision-loss)`.
- A host-app UI that keys joins on `server_message_id` after a sync
  pass will **not** match the same message's id obtained via the
  send-response (FlatBuffers) or push (FlatBuffers) paths. The SDK's
  own cache is internally consistent because `record_key` is derived
  from whichever id arrived first — but cross-source comparisons by
  the host break.
- Phase 4 local-echo ACK swap is **not** affected: it correlates by
  `local_message_id` (well below 2^53), and the swap path uses the
  FlatBuffers ACK, not the sync wire.
- Phase 5A `markRead` is **not** affected for the same reason: its
  `read_pts` payload is small (per-channel pts, not a snowflake).

### Fix path (server side)

Two viable approaches. Recommended **Option A**.

**Option A — JSON wire u64-as-string on the affected routes.**
Change `pts` / `server_msg_id` / `local_message_id` / `channel_id` /
`sender_id` etc. on `GetDifferenceRequest` / `GetDifferenceResponse` /
`ServerCommit` (and any sibling JSON RPC structs) from `u64` to
`String`. Server fills with `.to_string()`; deserialises with
`u64::from_str`. Precedent already exists in the codebase:
`ChannelReadCursorNotificationMetadata.reader_id: String` follows
exactly this pattern.

SDK side is essentially a no-op — TS already string-coerces at the
boundary; the `Number(req.last_pts)` in `client.ts:callSyncGetDifference`
becomes a no-op identity. Rust SDK clients need a one-line change to
parse string instead of u64 in the same routes.

**Option B — Bigint-aware JSON parser in the TS SDK.**
Replace `JSON.parse` in `rpcCallTyped` with a streaming parser that
emits BigInt for integers above 2^53. Heavier client change; doesn't
fix non-TS clients; defers the wire-shape question.

### Next action
Server team: audit all JSON RPC routes that carry u64 fields and
migrate to string serialisation on the wire (Option A). Once landed:

1. Drop the `Number(...)` coercion in `client.ts:callSyncGetDifference`.
2. Switch `accounts/phases/phase13-sync-gap-fill.ts` back to
   `server_message_id` matching (delete the content-fallback fallback +
   the `TODO(precision-loss)` comment).
3. Add a unit test that round-trips a snowflake > 2^53 through every
   sync RPC and asserts string equality end-to-end.

This bug is a **prerequisite for Phase 5C (persistent outbound queue)**.
5C correlates `local_message_id` ↔ `server_message_id` through the
outbox; if the server-acknowledged id can drift across wire types, the
outbox ACK swap logic is unsafe.
