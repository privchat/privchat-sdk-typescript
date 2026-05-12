// Phase 5A: markRead E2E. Spins up a cache-enabled client for bob,
// reads the alice→bob direct channel up to its server-current pts,
// then verifies:
//
//   1. server returns success with accepted_read_pts
//   2. local channels[bob-alice].read_pts advances to accepted
//   3. local unread_count drops to 0
//   4. observeChannelList fires with the updated record
//   5. (idempotency) calling markRead with a smaller pts does NOT
//      regress local read_pts, and server still returns success
//      (server clamps via GREATEST)
//
// Per-channel pts is fetched via `sync/get_channel_pts` because
// `message/history/get` does NOT carry pts (only snowflake message_id).

import { PrivchatClient } from '../../../../src/index.js';
import {
  DIRECT_SYNC_CHANNEL_TYPE,
  type MultiAccountManager,
} from '../account-manager.js';
import type {
  GetChannelPtsRequest,
  GetChannelPtsResponse,
} from '../rpc-types.js';
import { emptyMetrics, type PhaseResult } from '../types.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const ENV = (key: string, fallback: string): string =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ((globalThis as any).process?.env?.[key] as string | undefined) ?? fallback;

export async function phase12_mark_read(
  mgr: MultiAccountManager,
): Promise<PhaseResult> {
  const start = Date.now();
  const metrics = emptyMetrics();

  const channelId = mgr.cachedDirectChannel('alice', 'bob');
  if (!channelId) {
    metrics.errors.push('alice-bob direct channel missing — earlier phases must run first');
    return finalize(start, metrics);
  }

  // Cache-enabled client for bob. The alice→bob channel already has
  // traffic from phase03 (alice's "hello friend") + phase11 (alice's
  // local-echo "phase11 echo @ ..."), so we don't need to send another
  // message here — bob can openConversation and read whatever exists.
  //
  // We must use bob's original device_id because his JWT token is
  // device-bound (server rejects with 10001 on mismatch). Side effect:
  // server evicts bob's manager-owned session when this client
  // authenticates. That's fine — phase12 is the last phase, no later
  // manager call touches bob.
  const host = ENV('PRIVCHAT_HOST', '127.0.0.1');
  const wsPort = Number(ENV('PRIVCHAT_WS_PORT', '9080'));
  const url = `ws://${host}:${wsPort}/`;
  const bob = mgr.config('bob');
  const cacheClient = new PrivchatClient({
    url,
    defaultTimeoutMs: 30_000,
    reconnect: { enabled: false },
    cache: { enabled: true, dbName: `phase12-${Date.now()}` },
  });

  try {
    await cacheClient.connect();
    await cacheClient.authenticate(bob.user_id, bob.token, bob.device_id);
    metrics.rpc_calls += 1;

    await cacheClient.bootstrapChannels();
    metrics.rpc_calls += 2;

    const channelKey = String(channelId);
    const beforeChannel = cacheClient
      .cachedChannels()
      .find((c) => c.channel_id === channelKey);
    if (!beforeChannel) {
      metrics.errors.push(`bob's bootstrap missing alice-bob channel ${channelId}`);
      return finalize(start, metrics, async () => cacheClient.disconnect());
    }

    // 1. Warm the cache (so observers later see real updates) +
    //    populate the message buffer.
    const opened = await cacheClient.openConversation(channelKey, DIRECT_SYNC_CHANNEL_TYPE);
    metrics.rpc_calls += 1;
    if (opened.length === 0) {
      metrics.errors.push('openConversation returned 0 messages on a channel with sent traffic');
      return finalize(start, metrics, async () => cacheClient.disconnect());
    }
    metrics.rpc_successes += 1;

    // 2. Get per-channel current_pts (markRead's wire input is read_pts,
    //    NOT snowflake message_id; history/get doesn't carry pts).
    const ptsResp = await cacheClient.rpcCallTyped<
      GetChannelPtsRequest,
      GetChannelPtsResponse
    >('sync/get_channel_pts', {
      channel_id: channelId,
      channel_type: DIRECT_SYNC_CHANNEL_TYPE,
    });
    metrics.rpc_calls += 1;
    const targetReadPts = String(ptsResp.current_pts);
    if (BigInt(targetReadPts) <= 0n) {
      metrics.errors.push(
        `sync/get_channel_pts returned current_pts=${targetReadPts}, expected > 0`,
      );
      return finalize(start, metrics, async () => cacheClient.disconnect());
    }
    metrics.rpc_successes += 1;

    // 3. markRead → expect server success + local advance.
    let listObservedReadPts: string | null = null;
    cacheClient.observeChannelList((channels) => {
      const ours = channels.find((c) => c.channel_id === channelKey);
      if (ours) listObservedReadPts = ours.read_pts;
    });

    const latestMessage = opened[opened.length - 1]!;
    const result = await cacheClient.markRead(
      channelKey,
      DIRECT_SYNC_CHANNEL_TYPE,
      targetReadPts,
      { lastReadMessageId: latestMessage.server_message_id },
    );
    metrics.rpc_calls += 1;
    if (result.status !== 'success') {
      metrics.errors.push(`markRead.status="${result.status}", expected "success"`);
    }
    const accepted = String(result.accepted_read_pts ?? result.last_read_pts ?? targetReadPts);
    if (BigInt(accepted) <= 0n) {
      metrics.errors.push(`markRead accepted=${accepted}, expected > 0`);
    } else {
      metrics.rpc_successes += 1;
    }

    const afterChannel = cacheClient
      .cachedChannels()
      .find((c) => c.channel_id === channelKey)!;
    if (afterChannel.read_pts === accepted) metrics.rpc_successes += 1;
    else metrics.errors.push(
      `local read_pts=${afterChannel.read_pts}, expected accepted=${accepted}`,
    );
    if (afterChannel.unread_count === 0) metrics.rpc_successes += 1;
    else metrics.errors.push(`local unread_count=${afterChannel.unread_count}, expected 0`);

    if (listObservedReadPts === accepted) metrics.rpc_successes += 1;
    else metrics.errors.push(
      `observeChannelList saw read_pts=${listObservedReadPts}, expected ${accepted}`,
    );

    // 4. Idempotency: smaller pts must NOT regress local cursor.
    const smallerPts = '1';
    const idempResult = await cacheClient.markRead(
      channelKey,
      DIRECT_SYNC_CHANNEL_TYPE,
      smallerPts,
    );
    metrics.rpc_calls += 1;
    if (idempResult.status !== 'success') {
      metrics.errors.push(
        `idempotent markRead(${smallerPts}) returned status=${idempResult.status}`,
      );
    } else {
      metrics.rpc_successes += 1;
    }
    const finalChannel = cacheClient
      .cachedChannels()
      .find((c) => c.channel_id === channelKey)!;
    if (finalChannel.read_pts === accepted) metrics.rpc_successes += 1;
    else metrics.errors.push(
      `read_pts regressed: was ${accepted}, now ${finalChannel.read_pts}`,
    );

    // Brief pause so async IndexedDB writes settle before tear-down.
    await sleep(50);

    return finalize(start, metrics, async () => cacheClient.disconnect());
  } catch (e) {
    metrics.errors.push(`runtime: ${e instanceof Error ? e.message : String(e)}`);
    return finalize(start, metrics, async () => cacheClient.disconnect());
  }
}

async function finalize(
  start: number,
  metrics: ReturnType<typeof emptyMetrics>,
  cleanup?: () => Promise<unknown>,
): Promise<PhaseResult> {
  if (cleanup) {
    try { await cleanup(); } catch { /* */ }
  }
  return {
    phase_name: 'mark-read',
    success: metrics.errors.length === 0,
    duration_ms: Date.now() - start,
    details: 'markRead → local read_seq advance → unread = 0 → smaller seq does not regress',
    metrics,
  };
}
