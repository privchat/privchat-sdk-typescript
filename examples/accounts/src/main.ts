// PrivChat TypeScript SDK — multi-account E2E example.
// Mirrors the Rust accounts example layout. Connects three clients (alice,
// bob, charlie) to a real privchat-server, runs a sequence of business
// phases, and exits non-zero if any phase fails.
//
// Env vars:
//   PRIVCHAT_HOST    server hostname (default 127.0.0.1)
//   PRIVCHAT_WS_PORT WebSocket port  (default 9080)

// Polyfill IndexedDB for Node so phase11 (cache smoke) can exercise Dexie.
// Browsers have native IndexedDB; this no-ops there in practice (the
// example is run via tsx in Node anyway).
import 'fake-indexeddb/auto';

import { MultiAccountManager } from './account-manager.js';
import { TestCoordinator } from './coordinator.js';
import { phases } from './phases/index.js';

async function main(): Promise<void> {
  console.log('\nPrivChat SDK Multi-Account Example (accounts) — TypeScript');
  console.log('==========================================================');
  console.log(`Phases: ${phases.length} (auth / friend / direct-send / search / blacklist / entity-sync / group / history / reactions / typing-presence / cache-smoke / mark-read / sync-gap-fill / outbox-persistence / read-cursor-events)\n`);

  const started = Date.now();
  const manager = await MultiAccountManager.create();

  for (const key of manager.accountKeys()) {
    const c = manager.config(key);
    console.log(`  ${key.padEnd(7)} => ${c.username} (uid=${c.user_id})`);
  }
  console.log();

  const coordinator = new TestCoordinator();
  await coordinator.runAll(manager, phases);

  const summary = coordinator.summary(Date.now() - started);
  console.log('\nSummary');
  console.log('-------');
  console.log(`total phases : ${summary.total}`);
  console.log(`passed       : ${summary.passed}`);
  console.log(`failed       : ${summary.failed}`);
  console.log(`duration     : ${(summary.duration_ms / 1000).toFixed(2)}s`);

  await manager.cleanup();

  if (summary.failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error('\n[FATAL]', e);
  process.exitCode = 1;
});
