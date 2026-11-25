# Three transports, one group (SD-12)

Requires a sibling privchat-server (built with the Quick Start schema),
privchat-sdk (build `cargo build -p privchat-sdk --example accounts`), this
checkout's installed JS dependencies and a Chromium installation for
Playwright CLI. Local PostgreSQL, Redis tools, OpenSSL and Python 3 are
required. Run only on an isolated fixture, never against deployed Weey.

The gate pins Alice to QUIC and Bob to TCP, and hands the third test account
to a real TypeScript SDK in Chromium. The browser bridge passes WebSocket
traffic to the same Server and closes only the browser's test-owned socket.
The native clients stay connected while the revoke and next message commit.
Assertions inspect native SQLite/browser cache and server read stats rather
than forcing a sync RPC after the browser reconnects.

From the common parent of all three repositories:

```bash
bash privchat-sdk-typescript/examples/cross-transport/run.sh \
  /absolute/path/to/privchat-server-binary \
  /absolute/path/to/accounts-example-binary
```

The test uses ports 59680-59686 by default; choose a free base via
`PRIVCHAT_FEATURE_BASE_PORT`. It cleans its own temporary server, browsers,
database and storage after a run. Set `PRINT_FIXTURE_LOGS=1` to print additional
diagnostics.
