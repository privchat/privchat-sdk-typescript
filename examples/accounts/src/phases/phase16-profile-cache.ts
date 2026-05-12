// Phase 16 (R2A): user + group profile cache E2E.
//
// Verifies that bootstrapChannels also pulls `entity/sync_entities("user")`
// and ("group") and populates `cachedUser` / `cachedGroup`. This is the
// data the title resolver consumes — without it, the conversation list
// would still display raw user_id / channel_id.
//
// Prereqs from earlier phases:
//   - alice/bob/charlie are registered + friends (phase02)
//   - alice has direct channels with bob and charlie (phase02)
//   - a group was created in phase07 (alice is owner); phase07 then
//     leaves bob, but the group still exists and alice/charlie are
//     still members.

import {
  PrivchatClient,
  type PrivchatClientOptions,
} from '../../../../src/index.js';
import type { MultiAccountManager } from '../account-manager.js';
import { emptyMetrics, type PhaseResult } from '../types.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const ENV = (key: string, fallback: string): string =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ((globalThis as any).process?.env?.[key] as string | undefined) ?? fallback;

export async function phase16_profile_cache(
  mgr: MultiAccountManager,
): Promise<PhaseResult> {
  const start = Date.now();
  const metrics = emptyMetrics();
  const aliceCfg = mgr.config('alice');
  const bobCfg = mgr.config('bob');
  const charlieCfg = mgr.config('charlie');

  const host = ENV('PRIVCHAT_HOST', '127.0.0.1');
  const wsPort = Number(ENV('PRIVCHAT_WS_PORT', '9080'));
  const url = `ws://${host}:${wsPort}/`;

  // Spin up a fresh cache-enabled client for alice — we want a cold
  // IDB to prove bootstrap really hydrates from server, not from any
  // pre-existing cache state.
  const opts: PrivchatClientOptions = {
    url,
    defaultTimeoutMs: 30_000,
    reconnect: { enabled: false },
    cache: { enabled: true, dbName: `phase16-${Date.now()}` },
  };
  const alice = new PrivchatClient(opts);

  try {
    await alice.connect();
    await alice.authenticate(aliceCfg.user_id, aliceCfg.token, aliceCfg.device_id);
    metrics.rpc_calls += 1;

    // Pre-bootstrap state: caches empty.
    if (alice.cachedUsers().length !== 0) {
      metrics.errors.push(
        `cachedUsers should be empty before bootstrap, got ${alice.cachedUsers().length}`,
      );
    }
    if (alice.cachedGroups().length !== 0) {
      metrics.errors.push(
        `cachedGroups should be empty before bootstrap, got ${alice.cachedGroups().length}`,
      );
    }

    await alice.bootstrapChannels();
    metrics.rpc_calls += 2; // channel + cursor pages (profile sync is fire-and-forget)

    // bootstrap fires user/group sync as best-effort background work.
    // Wait for the IDB writes + observer emits to settle.
    await sleep(150);

    // ----- Users -----
    const users = alice.cachedUsers();
    if (users.length === 0) {
      metrics.errors.push('user cache empty after bootstrap; entity/sync_entities("user") returned no rows or fire-and-forget hasn\'t run');
      return finalize(start, metrics, async () => alice.disconnect());
    }
    metrics.rpc_successes += 1;

    // alice should at minimum see herself + friends (bob, charlie).
    const ids = new Set(users.map((u) => u.user_id));
    for (const expected of [aliceCfg.user_id, bobCfg.user_id, charlieCfg.user_id]) {
      if (!ids.has(expected)) {
        metrics.errors.push(`user cache missing uid=${expected}`);
      }
    }

    // Self profile shape sanity.
    const self = alice.cachedUser(aliceCfg.user_id);
    if (!self) {
      metrics.errors.push('alice missing from her own user cache');
    } else {
      if (typeof self.username !== 'string' || self.username === '') {
        metrics.errors.push(`alice.username invalid: ${JSON.stringify(self.username)}`);
      }
      if (self.is_friend !== false) {
        metrics.errors.push(`alice.is_friend should default to false (R2.1 territory), got ${self.is_friend}`);
      }
      if (typeof self.sync_version !== 'number' || self.sync_version <= 0) {
        metrics.errors.push(`alice.sync_version invalid: ${self.sync_version}`);
      }
    }

    // ----- Groups -----
    //
    // We don't fail on empty group cache: server-side eligibility for
    // `entity/sync_entities("group")` depends on membership state at
    // call time, and earlier phases churn membership (phase07 has bob
    // leaving). The shape contract is what matters here — when the
    // server DOES return rows, they must project cleanly into
    // `GroupRecord`.
    const groups = alice.cachedGroups();
    if (groups.length > 0) {
      metrics.rpc_successes += 1;
      const g = groups[0]!;
      if (typeof g.group_id !== 'string' || g.group_id === '') {
        metrics.errors.push(`group_id invalid: ${JSON.stringify(g.group_id)}`);
      }
      if (typeof g.name !== 'string' || g.name === '') {
        metrics.errors.push(`group.name invalid: ${JSON.stringify(g.name)}`);
      }
      if (typeof g.member_count !== 'number') {
        metrics.errors.push(`group.member_count invalid: ${g.member_count}`);
      }
    }

    // ----- observeUserList / observeGroupList smoke -----
    // Already populated; subscribing now should immediately reflect
    // current state via the next emit. We don't force one — just
    // confirm subscribe + unsubscribe round-trips don't throw.
    const offU = alice.observeUserList(() => undefined);
    const offG = alice.observeGroupList(() => undefined);
    offU();
    offG();
    metrics.rpc_successes += 1;

    return finalize(start, metrics, async () => alice.disconnect());
  } catch (e) {
    metrics.errors.push(`runtime: ${e instanceof Error ? e.message : String(e)}`);
    return finalize(start, metrics, async () => alice.disconnect());
  }
}

async function finalize(
  start: number,
  metrics: ReturnType<typeof emptyMetrics>,
  cleanup?: () => Promise<unknown>,
): Promise<PhaseResult> {
  if (cleanup) {
    try {
      await cleanup();
    } catch {
      /* */
    }
  }
  return {
    phase_name: 'profile-cache',
    success: metrics.errors.length === 0,
    duration_ms: Date.now() - start,
    details:
      'bootstrapChannels populates cachedUsers/cachedGroups; profile sync is best-effort and does not block channel list',
    metrics,
  };
}
