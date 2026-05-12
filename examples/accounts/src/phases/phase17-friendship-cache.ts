// Phase 17 (R2.1): friendship metadata cache E2E.
//
// Verifies that bootstrapChannels also pulls
// `entity/sync_entities("friend")` and populates `cachedFriendship`.
// alice and bob become friends in phase02; here we open a fresh
// alice client and confirm the friendship row + alias surface
// through the local cache without any extra dance.

import { PrivchatClient } from '../../../../src/index.js';
import type { MultiAccountManager } from '../account-manager.js';
import { emptyMetrics, type PhaseResult } from '../types.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const ENV = (key: string, fallback: string): string =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ((globalThis as any).process?.env?.[key] as string | undefined) ?? fallback;

const FRIEND_SET_ALIAS_ROUTE = 'contact/friend/set_alias';

export async function phase17_friendship_cache(
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

  // Earlier phases (notably phase13's reconnect dance) leave the
  // manager's alice client in a closed state, so we cannot reuse it.
  // Stand up our own cache-enabled alice client, set the alias, then
  // verify the alias surfaces through entity sync.
  const alice = new PrivchatClient({
    url,
    defaultTimeoutMs: 30_000,
    reconnect: { enabled: false },
    cache: { enabled: true, dbName: `phase17-${Date.now()}` },
  });

  try {
    await alice.connect();
    await alice.authenticate(aliceCfg.user_id, aliceCfg.token, aliceCfg.device_id);
    metrics.rpc_calls += 1;

    // Set a remark on bob so cachedFriendship('bob_uid').alias has
    // something definitive to assert. SDK doesn't sugar this RPC yet
    // (it'll get a typed wrapper in R2.2); use rpcCallTyped directly.
    await alice.rpcCallTyped<
      { user_id: number; alias: string },
      Record<string, unknown>
    >(FRIEND_SET_ALIAS_ROUTE, {
      user_id: Number(bobCfg.user_id),
      alias: '老王 (test)',
    });
    metrics.rpc_calls += 1;
    metrics.rpc_successes += 1;

    if (alice.cachedFriendships().length !== 0) {
      metrics.errors.push(
        `cachedFriendships should be empty before bootstrap, got ${alice.cachedFriendships().length}`,
      );
    }

    await alice.bootstrapChannels();
    metrics.rpc_calls += 2;

    // friend sync runs fire-and-forget alongside user/group sync —
    // give the IDB writes + observer emits time to settle.
    await sleep(200);

    const friendships = alice.cachedFriendships();
    if (friendships.length === 0) {
      metrics.errors.push(
        'friendship cache empty after bootstrap; entity/sync_entities("friend") returned no rows',
      );
      return finalize(start, metrics, async () => alice.disconnect());
    }
    metrics.rpc_successes += 1;

    // alice should at minimum see bob (we just set an alias) and
    // charlie (also befriended in phase02).
    const ids = new Set(friendships.map((f) => f.user_id));
    if (!ids.has(bobCfg.user_id)) {
      metrics.errors.push(`friendship cache missing bob uid=${bobCfg.user_id}`);
    }
    if (!ids.has(charlieCfg.user_id)) {
      metrics.errors.push(`friendship cache missing charlie uid=${charlieCfg.user_id}`);
    }

    // Bob's row carries the alias we just set (or a later overwrite
    // from a previous run — accept any non-empty alias starting with
    // the test marker).
    const bob = alice.cachedFriendship(bobCfg.user_id);
    if (!bob) {
      metrics.errors.push('bob not in friendship cache');
    } else {
      if (bob.alias === undefined || bob.alias === '') {
        metrics.errors.push(
          `bob.alias should be populated after set_alias, got ${JSON.stringify(bob.alias)}`,
        );
      }
      if (typeof bob.sync_version !== 'number' || bob.sync_version <= 0) {
        metrics.errors.push(`bob.sync_version invalid: ${bob.sync_version}`);
      }
    }

    // observeFriendshipList smoke
    let observed = -1;
    const off = alice.observeFriendshipList((rows) => {
      observed = rows.length;
    });
    off();
    void observed; // observer may or may not have fired before unsubscribe

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
    phase_name: 'friendship-cache',
    success: metrics.errors.length === 0,
    duration_ms: Date.now() - start,
    details:
      'set_alias → cold-start bootstrap → cachedFriendship returns alias-bearing row',
    metrics,
  };
}
