// Phase 5D-1e: read cursor event consumption E2E.
//
// Two paths verified end-to-end:
//   1. Self path (markRead RPC echo). alice.markRead() → alice's own
//      `read_cursor_updated` listener fires with the new pts +
//      previous pts. This locks the SDK-internal emit, NOT the
//      server self-push fan-out (we'd need a second alice session
//      with the same uid to trigger that — out of scope here).
//   2. Peer path (server fan-out → wire push → SDK L1). bob.markRead()
//      via the manager client → alice receives a
//      `peer_read_cursor_updated` event over the wire. Locks the
//      full path: server `peer_read_pts_updated` push → JSON decode →
//      `maybeConsumeReadCursorPush` → `bus.emit`.
//
// Phase 5D unit tests cover the merge / suppress / channel-type
// guard logic; this phase locks the wire-to-event handoff.

import {
  PrivchatClient,
  type PeerReadCursorUpdatedEvent,
  type ReadCursorUpdatedEvent,
} from '../../../../src/index.js';
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

export async function phase15_read_cursor_events(
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

  // bob's manager client may still be cycling reconnect from phase12's
  // eviction; wait for it.
  if (!(await waitForState(mgr.client('bob'), 'authenticated', 3_000))) {
    metrics.errors.push("bob's manager client did not re-authenticate within 3s");
    return finalize(start, metrics);
  }

  // alice's manager client was disconnected by phase13. We can take over
  // alice's session uncontested with a fresh cache-enabled client.
  const host = ENV('PRIVCHAT_HOST', '127.0.0.1');
  const wsPort = Number(ENV('PRIVCHAT_WS_PORT', '9080'));
  const url = `ws://${host}:${wsPort}/`;
  const alice = new PrivchatClient({
    url,
    defaultTimeoutMs: 30_000,
    reconnect: { enabled: false },
    cache: { enabled: true, dbName: `phase15-${Date.now()}` },
  });

  try {
    await alice.connect();
    await alice.authenticate(aliceCfg.user_id, aliceCfg.token, aliceCfg.device_id);
    metrics.rpc_calls += 1;
    metrics.rpc_successes += 1;

    await alice.bootstrapChannels();
    metrics.rpc_calls += 2;

    await alice.subscribeChannel(channelKey, DIRECT_SYNC_CHANNEL_TYPE);
    metrics.rpc_calls += 1;

    await alice.openConversation(channelKey, DIRECT_SYNC_CHANNEL_TYPE);
    metrics.rpc_calls += 1;

    // ----- Test 1: alice markRead → self read_cursor_updated -----

    const aliceCurrentPts = await alice.rpcCallTyped<
      GetChannelPtsRequest,
      GetChannelPtsResponse
    >('sync/get_channel_pts', {
      channel_id: channelId,
      channel_type: DIRECT_SYNC_CHANNEL_TYPE,
    });
    metrics.rpc_calls += 1;
    const aliceTargetPts = String(aliceCurrentPts.current_pts);
    if (BigInt(aliceTargetPts) <= 0n) {
      metrics.errors.push(
        `alice current_pts=${aliceTargetPts}, expected > 0 (channel has prior traffic)`,
      );
      return finalize(start, metrics, async () => alice.disconnect());
    }

    const selfEvents: ReadCursorUpdatedEvent[] = [];
    const offSelf = alice.onReadCursorUpdated((event) => selfEvents.push(event));

    const aliceMarkResp = await alice.markRead(
      channelKey,
      DIRECT_SYNC_CHANNEL_TYPE,
      aliceTargetPts,
    );
    metrics.rpc_calls += 1;
    const aliceAccepted = String(
      aliceMarkResp.accepted_read_pts ?? aliceMarkResp.last_read_pts ?? aliceTargetPts,
    );

    // markRead emits inside its awaited path — the event is already in
    // selfEvents by now.
    if (selfEvents.length !== 1) {
      metrics.errors.push(`self read_cursor_updated count=${selfEvents.length}, expected 1`);
    } else {
      const ev = selfEvents[0]!;
      if (ev.channel_id !== channelKey) {
        metrics.errors.push(`self event channel_id=${ev.channel_id}, expected ${channelKey}`);
      }
      if (ev.channel_type !== DIRECT_SYNC_CHANNEL_TYPE) {
        metrics.errors.push(`self event channel_type=${ev.channel_type}`);
      }
      if (ev.reader_id !== aliceCfg.user_id) {
        metrics.errors.push(
          `self event reader_id=${ev.reader_id}, expected ${aliceCfg.user_id}`,
        );
      }
      if (ev.read_pts !== aliceAccepted) {
        metrics.errors.push(
          `self event read_pts=${ev.read_pts}, expected ${aliceAccepted}`,
        );
      }
      if (ev.previous_read_pts === undefined) {
        metrics.errors.push(
          'self event previous_read_pts undefined — channel was bootstrapped + advanced, expected populated',
        );
      }
      metrics.rpc_successes += 1;
    }
    offSelf();

    // ----- Test 2: bob markRead → alice receives peer_read_cursor_updated -----

    // Make sure bob has fresh ground to advance over: alice sends one
    // more message so current_pts > bob's prior cursor (advanced in
    // phase12, possibly stale by now).
    const trigger = await alice.sendTextMessage({
      channel_id: channelKey,
      channel_type: DIRECT_SYNC_CHANNEL_TYPE,
      from_uid: aliceCfg.user_id,
      content: `phase15 peer trigger @ ${Date.now()}`,
    });
    metrics.messages_sent += 1;
    if (trigger.status !== 'sent') {
      metrics.errors.push(
        `alice trigger send status=${trigger.status}, expected 'sent' (online)`,
      );
      return finalize(start, metrics, async () => alice.disconnect());
    }

    // Pull the post-send pts from bob's vantage point so bob's markRead
    // targets a value we know is past his prior cursor.
    const bobCurrentPts = await mgr.client('bob').rpcCallTyped<
      GetChannelPtsRequest,
      GetChannelPtsResponse
    >('sync/get_channel_pts', {
      channel_id: channelId,
      channel_type: DIRECT_SYNC_CHANNEL_TYPE,
    });
    metrics.rpc_calls += 1;
    const bobTargetPts = String(bobCurrentPts.current_pts);

    // Race-safe: register the peer listener BEFORE bob's markRead so
    // we never miss the push. waitForEvent caps at 5s.
    const peerWait = waitForEvent<PeerReadCursorUpdatedEvent>(
      (cb) => alice.onPeerReadCursorUpdated(cb),
      (e) => e.channel_id === channelKey && e.reader_id === bobCfg.user_id,
      5_000,
    );

    await mgr.client('bob').markRead(
      channelKey,
      DIRECT_SYNC_CHANNEL_TYPE,
      bobTargetPts,
    );
    metrics.rpc_calls += 1;

    const peerEvent = await peerWait;
    if (!peerEvent) {
      metrics.errors.push(
        `peer_read_cursor_updated did not arrive within 5s (bob target=${bobTargetPts})`,
      );
      return finalize(start, metrics, async () => alice.disconnect());
    }
    if (peerEvent.channel_type !== DIRECT_SYNC_CHANNEL_TYPE) {
      metrics.errors.push(
        `peer event channel_type=${peerEvent.channel_type}, expected ${DIRECT_SYNC_CHANNEL_TYPE}`,
      );
    }
    if (peerEvent.reader_id !== bobCfg.user_id) {
      metrics.errors.push(
        `peer event reader_id=${peerEvent.reader_id}, expected ${bobCfg.user_id}`,
      );
    }
    if (BigInt(peerEvent.read_pts) <= 0n) {
      metrics.errors.push(
        `peer event read_pts=${peerEvent.read_pts}, expected > 0`,
      );
    }
    if (BigInt(peerEvent.read_pts) > BigInt(bobTargetPts)) {
      metrics.errors.push(
        `peer event read_pts=${peerEvent.read_pts} exceeds bob target ${bobTargetPts}`,
      );
    }
    metrics.rpc_successes += 1;

    // ----- Test 3: peer cursor advance persists into ChannelRecord.peer_read_pts -----
    //
    // The SDK absorbs `peer_read_pts_updated` by MAX-merging into the
    // local channel record. Read receipts are NOT mutated onto
    // MessageRecord.status — they're a separate dimension exposed via
    // `ChannelRecord.peer_read_pts`, and UI projects "已读" by
    // comparing each self-sent message's pts against this cursor (this
    // mirrors Rust SDK's `channel_extra.peer_read_pts` model).

    // Brief pause so the cache + IDB writes settle.
    await sleep(50);

    const aliceChannels = alice.cachedChannels();
    const channel = aliceChannels.find((c) => c.channel_id === channelKey);
    if (!channel) {
      metrics.errors.push(`alice cache missing channel ${channelKey}`);
    } else if (channel.peer_read_pts === undefined) {
      metrics.errors.push(
        `alice channel ${channelKey} peer_read_pts is undefined; expected ${peerEvent.read_pts}`,
      );
    } else if (BigInt(channel.peer_read_pts) < BigInt(peerEvent.read_pts)) {
      metrics.errors.push(
        `alice channel.peer_read_pts=${channel.peer_read_pts} < peerEvent ${peerEvent.read_pts}`,
      );
    } else {
      metrics.rpc_successes += 1;
    }

    // Negative check: MessageRecord.status must NOT have been mutated
    // to a 'read' value. Read receipts are projected at the UI layer,
    // not persisted on the message row.
    const aliceMessages = alice.getCachedMessages(channelKey, DIRECT_SYNC_CHANNEL_TYPE);
    for (const m of aliceMessages) {
      // 'read' is not a member of MessageStatus anymore; this guards
      // against accidental regression of the projection model.
      if ((m.status as string) === 'read') {
        metrics.errors.push(
          `alice row ${m.server_message_id ?? m.local_message_id} has status='read'; SDK must not mutate message rows for read receipts`,
        );
      }
    }

    return finalize(start, metrics, async () => alice.disconnect());
  } catch (e) {
    metrics.errors.push(`runtime: ${e instanceof Error ? e.message : String(e)}`);
    return finalize(start, metrics, async () => alice.disconnect());
  }
}

/**
 * Subscribe via `register`, resolve with the first matching event or
 * `null` after `timeoutMs`. Always unsubscribes before resolving so
 * stale callbacks don't leak past the test.
 */
function waitForEvent<E>(
  register: (cb: (event: E) => void) => () => void,
  predicate: (event: E) => boolean,
  timeoutMs: number,
): Promise<E | null> {
  return new Promise((resolve) => {
    let settled = false;
    const off = register((event) => {
      if (settled) return;
      if (predicate(event)) {
        settled = true;
        off();
        resolve(event);
      }
    });
    setTimeout(() => {
      if (settled) return;
      settled = true;
      off();
      resolve(null);
    }, timeoutMs);
  });
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
    phase_name: 'read-cursor-events',
    success: metrics.errors.length === 0,
    duration_ms: Date.now() - start,
    details:
      'alice markRead → self event; bob markRead → peer event over wire',
    metrics,
  };
}
