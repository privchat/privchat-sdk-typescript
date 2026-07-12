# RC-2 resume-sync regression harness

Deterministic end-to-end check of the reconnect / resume-sync / outbox /
subscription-replay path against a live `privchat-server`. Kept as the
long-term regression for anything touching the SyncEngine, outbox,
reconnect state machine, or subscription replay.

## Run

```bash
# needs a privchat-server on ws://127.0.0.1:9080/ (see privchat-server)
npm run build
node examples/reconnect-resume/rc2-resume-sync.mjs 5
# or via npm (builds first):
npm run example:reconnect -- 5
```

Exit code `0` iff every run is green.

## What each run asserts

1. `simulateUnexpectedDisconnect()` → **exactly one** reconnect cycle
   (`reconnecting → connected → authenticating → authenticated`), not a logout.
2. **Exactly one** resume-sync round — `sync/get_difference` is called once
   (counted by wrapping `rpcCallTyped` on the instance). Guards against the
   "multiple resume triggers → duplicate sync" regression.
3. Peer's messages sent while we were offline are **backfilled** on reconnect.
4. Our own message queued while offline auto-flushes on reconnect, is **sent**,
   its `server_message_id` is backfilled, and the outbox row is **drained**.
5. **No duplicate** `server_message_id`; timestamp **order preserved**.

## Notes / gotchas

- Node needs `fake-indexeddb/auto` (imported at the top) for the cache client.
- Do **not** pass a custom non-snowflake `local_message_id` to
  `sendTextMessage` — the server requires a snowflake and the outbox row will
  otherwise end up `failed`. Let the SDK generate it; match by the returned id.
- The local server may not log RPC routes at INFO, so the resume-sync round is
  counted client-side rather than from server logs.
