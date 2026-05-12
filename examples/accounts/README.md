# accounts — TypeScript multi-account E2E

TypeScript port of the Rust [`accounts`](../../../privchat-sdk/crates/privchat-sdk/examples/accounts) example. Spins up three `PrivchatClient` instances (alice, bob, charlie) against a real `privchat-server` and runs a sequence of business phases, mirroring the layout of the Rust version.

## What it covers

| Phase | Name | Exercises |
| ----- | ---- | --------- |
| 1 | `auth/bootstrap` | register via RPC + `authenticate()` + connection state |
| 2 | `friend-system` | search → apply → pending → accept → check → direct channel create, for all 3 pairs |
| 3 | `direct-hello-send` | `sync/get_channel_pts` + `sync/submit` to send text to each direct channel |
| 4 | `account-search` | 6 cross-pair username search queries |
| 5 | `blacklist` | add → check → list → remove → recheck |

The phase set is intentionally a subset of the Rust example's 35 phases — only those that map to the SDK's current Phase 2 surface (no local DB, no outbound queue, no PTS sync engine) are implemented here. Add more under `src/phases/` as the SDK grows.

## Prerequisites

- A running `privchat-server` reachable from the host running this example. Default endpoint is `ws://127.0.0.1:9080/`.
- `npm install` from the repo root (one-time, picks up `tsx`).

## Running

```bash
# from privchat-sdk-typescript/
npm run example:accounts
```

This runs `npm run codegen` (sync schemas + flatc) and then `tsx examples/accounts/src/main.ts`.

Override the server endpoint with env vars:

```bash
PRIVCHAT_HOST=10.0.0.5 PRIVCHAT_WS_PORT=9080 npm run example:accounts
```

## Exit code

`0` if every phase passes, `1` otherwise. Suitable for CI.

## Layout

```
examples/accounts/
├─ src/
│  ├─ main.ts              entry — sets up manager, runs phases, prints summary
│  ├─ types.ts             AccountConfig / PhaseResult / TestSummary
│  ├─ routes.ts            RPC route constants (mirrors privchat_protocol::rpc::routes)
│  ├─ rpc-types.ts         typed Request/Response shapes used by the phases
│  ├─ account-manager.ts   3-account orchestrator (register, authenticate, send_text, ...)
│  ├─ coordinator.ts       phase runner + summary formatter
│  └─ phases/              one phase function per file
└─ README.md
```

## Notes vs Rust example

- **Local DB / queue not exercised.** The Rust example calls `manager.list_local_friends()`, `list_local_channels()`, etc. — TS Phase 2 has no local store, so phases skip those assertions.
- **`send_text` uses `sync/submit` RPC**, mirroring the Rust example. The protocol-level `sendMessage(SendMessageRequest)` is exercised by the SDK unit tests, not by this example.
- **Username suffix** is randomized per run so re-runs against the same server don't collide.
