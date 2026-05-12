// Phase 5B-1e: end-to-end gap-fill via auto-reconnect.
//
// Flow:
//   1. Disconnect alice's manager-owned client so it doesn't fight us
//      for her (uid, device_id) slot during the reconnect dance.
//   2. Spin up a fresh cache-enabled alice client with FAST reconnect
//      backoff (so we don't wait whole seconds in CI).
//   3. Bootstrap channels, subscribe to the alice-bob direct channel,
//      open the conversation to seed the cache window.
//   4. Snapshot before-state: latest_pts, unread_count, message ids.
//   5. Force an unexpected transport close (NOT user-initiated, so the
//      auto-reconnect machinery engages).
//   6. While alice is offline, bob sends N messages to the channel via
//      the manager's bob client.
//   7. Wait for alice's reconnect to complete: connect → re-auth →
//      replay subscription → syncOnReconnect (5B-1d wiring).
//   8. Assert: cache contains all of bob's new messages, latest_pts
//      advanced past the old high-water mark, no duplicates exist, and
//      unread_count is bumped by N.

import { PrivchatClient, type SendTextOperationResult } from '../../../../src/index.js';
import {
  DIRECT_SYNC_CHANNEL_TYPE,
  type MultiAccountManager,
} from '../account-manager.js';
import { emptyMetrics, type PhaseResult } from '../types.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const ENV = (key: string, fallback: string): string =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ((globalThis as any).process?.env?.[key] as string | undefined) ?? fallback;

/** Number of gap messages bob will send while alice is offline. */
const GAP_COUNT = 3;

/** How long we'll wait for alice's auto-reconnect to land + sync to settle. */
const RECONNECT_DEADLINE_MS = 8_000;

export async function phase13_sync_gap_fill(
  mgr: MultiAccountManager,
): Promise<PhaseResult> {
  const start = Date.now();
  const metrics = emptyMetrics();

  const channelId = mgr.cachedDirectChannel('alice', 'bob');
  if (!channelId) {
    metrics.errors.push('alice-bob direct channel missing — earlier phases must run first');
    return finalize(start, metrics);
  }
  const channelKey = String(channelId);
  const aliceCfg = mgr.config('alice');
  const bobCfg = mgr.config('bob');

  // Drain the manager's alice client so it can't ping-pong with our
  // cache client over alice's session slot. Phase 13 is the last phase,
  // so no later code touches manager.alice.
  try {
    await mgr.client('alice').disconnect();
  } catch {
    /* already disconnected — ignore */
  }

  // Bob's manager client may still be cycling through reconnect after
  // phase12's eviction. Wait briefly until bob is back so the gap-send
  // RPCs go through.
  if (!(await waitForState(mgr.client('bob'), 'authenticated', 3_000))) {
    metrics.errors.push("bob's manager client did not re-authenticate within 3s");
    return finalize(start, metrics);
  }

  const host = ENV('PRIVCHAT_HOST', '127.0.0.1');
  const wsPort = Number(ENV('PRIVCHAT_WS_PORT', '9080'));
  const url = `ws://${host}:${wsPort}/`;

  const cacheClient = new PrivchatClient({
    url,
    defaultTimeoutMs: 30_000,
    // Fast backoff: we want the reconnect cycle to fire quickly under test.
    reconnect: { enabled: true, initialDelayMs: 100, maxDelayMs: 100, multiplier: 1 },
    cache: { enabled: true, dbName: `phase13-${Date.now()}` },
  });

  try {
    await cacheClient.connect();
    metrics.rpc_calls += 1;

    await cacheClient.authenticate(aliceCfg.user_id, aliceCfg.token, aliceCfg.device_id);
    metrics.rpc_calls += 1;
    metrics.rpc_successes += 1;

    await cacheClient.bootstrapChannels();
    metrics.rpc_calls += 2;

    // Subscribe to the alice-bob channel so the reconnect path has
    // something to replay AND so syncOnReconnect iterates this channel.
    await cacheClient.subscribeChannel(channelKey, DIRECT_SYNC_CHANNEL_TYPE);
    metrics.rpc_calls += 1;

    // Seed the in-memory cache + open buffer so we can compare before/after.
    const beforeOpen = await cacheClient.openConversation(channelKey, DIRECT_SYNC_CHANNEL_TYPE);
    metrics.rpc_calls += 1;

    const beforeChannel = cacheClient.cachedChannels().find((c) => c.channel_id === channelKey);
    if (!beforeChannel) {
      metrics.errors.push(`alice-bob channel ${channelKey} missing from cache after bootstrap`);
      return finalize(start, metrics, async () => cacheClient.disconnect());
    }
    const beforeLatestPts = beforeChannel.latest_pts;
    const beforeUnread = beforeChannel.unread_count;
    const beforeIds = new Set(
      beforeOpen.map((m) => m.server_message_id).filter((id): id is string => id !== undefined),
    );

    // Trigger the unexpected close. This bypasses disconnect() so
    // userInitiatedDisconnect stays false → reconnect machinery engages.
    await cacheClient.simulateUnexpectedDisconnect();

    // Bob fires N messages while alice is offline. Server stores commits
    // for the channel; alice can't receive them via push (no active
    // session), so they're only retrievable via sync/get_difference.
    const sentResults: SendTextOperationResult[] = [];
    for (let i = 0; i < GAP_COUNT; i++) {
      const r = await mgr.client('bob').sendTextMessage({
        channel_id: channelKey,
        channel_type: DIRECT_SYNC_CHANNEL_TYPE,
        from_uid: bobCfg.user_id,
        content: `phase13 gap-fill #${i + 1} @ ${Date.now()}-${i}`,
      });
      // Bob's manager client is cache-disabled (built by MultiAccountManager
      // without `cache.enabled`), so `sendTextMessage` keeps strict
      // semantics: throws on offline / non-zero reason_code, resolves with
      // `status: 'sent'` carrying response.server_message_id otherwise.
      // Phase 13 is the online happy path; expect 'sent' on every call.
      if (r.status !== 'sent') {
        metrics.errors.push(`bob sendTextMessage #${i + 1}: status=${r.status}`);
        return finalize(start, metrics, async () => cacheClient.disconnect());
      }
      sentResults.push(r);
      metrics.messages_sent += 1;
      // small spacing so server timestamps differ — keeps the cache's
      // timestamp-based sort stable across the new arrivals.
      await sleep(20);
    }

    // After the 5B-1c sync u64-as-string fix, bob's send-response
    // `server_message_id` and alice's sync-arrived
    // `MessageRecord.server_message_id` are byte-equal for the same
    // logical message. Match by id. The loop above bailed on any
    // status !== 'sent', so the type narrows safely below.
    const expectedNewIds = new Set(
      sentResults.map((r) =>
        r.status === 'sent' ? r.response.server_message_id : '',
      ),
    );

    // Wait for alice's reconnect to land. After auth + replay sub, the
    // 5B-1d wiring fires syncOnReconnect; we then poll until the cache
    // contains every gap-fill message.
    const ready = await waitForCondition(
      async () => {
        if (cacheClient.connectionState() !== 'authenticated') return false;
        const cached = cacheClient.getCachedMessages(channelKey, DIRECT_SYNC_CHANNEL_TYPE);
        const ids = new Set(cached.map((m) => m.server_message_id));
        for (const want of expectedNewIds) {
          if (!ids.has(want)) return false;
        }
        return true;
      },
      RECONNECT_DEADLINE_MS,
    );

    const cachedAfter = cacheClient.getCachedMessages(channelKey, DIRECT_SYNC_CHANNEL_TYPE);
    const channelAfter = cacheClient.cachedChannels().find((c) => c.channel_id === channelKey);

    if (!ready) {
      const cachedIds = new Set(cachedAfter.map((m) => m.server_message_id));
      const missing = [...expectedNewIds].filter((id) => !cachedIds.has(id));
      metrics.errors.push(
        `gap-fill incomplete after ${RECONNECT_DEADLINE_MS}ms: state=${cacheClient.connectionState()} missing_ids=${JSON.stringify(missing)}`,
      );
      return finalize(start, metrics, async () => cacheClient.disconnect());
    }
    metrics.rpc_successes += 1; // gap-fill arrival

    // Assertion: latest_pts advanced past the snapshotted high-water mark.
    if (!channelAfter) {
      metrics.errors.push('channel record missing post-sync');
    } else if (BigInt(channelAfter.latest_pts) > BigInt(beforeLatestPts)) {
      metrics.rpc_successes += 1;
    } else {
      metrics.errors.push(
        `latest_pts did not advance: before=${beforeLatestPts} after=${channelAfter.latest_pts}`,
      );
    }

    // Assertion: no duplicate server_message_id. Sync engine + push
    // absorption must dedupe via record_key derived from server_message_id.
    const idCounts = new Map<string, number>();
    for (const m of cachedAfter) {
      if (m.server_message_id !== undefined) {
        idCounts.set(m.server_message_id, (idCounts.get(m.server_message_id) ?? 0) + 1);
      }
    }
    const dupes = [...idCounts.entries()].filter(([, n]) => n > 1);
    if (dupes.length === 0) {
      metrics.rpc_successes += 1;
    } else {
      metrics.errors.push(
        `duplicate server_message_id(s): ${dupes.map(([id, n]) => `${id}×${n}`).join(', ')}`,
      );
    }

    // Assertion: unread_count bumped by exactly GAP_COUNT. All N messages
    // are from bob (foreign) and have pts past alice's read_pts, so the
    // bump should be exactly GAP_COUNT. The sync engine also dedupes on
    // re-application, so even if a stray push were to slip in, double-bump
    // is impossible.
    if (channelAfter) {
      const expectedUnread = beforeUnread + GAP_COUNT;
      if (channelAfter.unread_count === expectedUnread) {
        metrics.rpc_successes += 1;
      } else {
        metrics.errors.push(
          `unread_count = ${channelAfter.unread_count}, expected ${expectedUnread} (before=${beforeUnread} + gap=${GAP_COUNT})`,
        );
      }
    }

    // Cross-check: the previously-seen messages survived the sync (no
    // accidental window wipe).
    const cachedIdsAfter = new Set(cachedAfter.map((m) => m.server_message_id));
    for (const oldId of beforeIds) {
      if (!cachedIdsAfter.has(oldId)) {
        metrics.errors.push(`pre-disconnect message ${oldId} dropped during sync`);
      }
    }

    // Brief pause so async IndexedDB writes settle before we tear down.
    await sleep(50);

    return finalize(start, metrics, async () => cacheClient.disconnect());
  } catch (e) {
    const detail =
      e instanceof Error
        ? `${e.name}: ${e.message}${e.stack ? '\n' + e.stack.split('\n').slice(0, 3).join('\n') : ''}`
        : String(e);
    metrics.errors.push(`runtime: ${detail}`);
    return finalize(start, metrics, async () => cacheClient.disconnect());
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
    phase_name: 'sync-gap-fill',
    success: metrics.errors.length === 0,
    duration_ms: Date.now() - start,
    details: `unexpected disconnect → bob sends ${GAP_COUNT} → reconnect → syncOnReconnect → cache converges`,
    metrics,
  };
}

async function waitForCondition(
  pred: () => Promise<boolean>,
  deadlineMs: number,
): Promise<boolean> {
  const stop = Date.now() + deadlineMs;
  while (Date.now() < stop) {
    if (await pred()) return true;
    await sleep(50);
  }
  return false;
}

async function waitForState(
  client: PrivchatClient,
  target: string,
  deadlineMs: number,
): Promise<boolean> {
  const stop = Date.now() + deadlineMs;
  while (Date.now() < stop) {
    if (client.connectionState() === target) return true;
    await sleep(50);
  }
  return client.connectionState() === target;
}
