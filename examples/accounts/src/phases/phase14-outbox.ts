// Phase 5C-1f: end-to-end persistence + cold-restart of the outbox.
//
// Flow (matches the spec test plan exactly):
//   1. alice1: cache-enabled client, dbName captured for the cold restart.
//      connect → authenticate → bootstrap → subscribe → openConversation.
//   2. alice1.disconnect()  — per Decision §5, the outbox survives.
//   3. alice1.sendTextMessage() while offline → expect status='queued',
//      outbox row persisted under the captured local_message_id.
//   4. Cold restart: drop alice1, build alice2 with the SAME dbName.
//      Without re-auth, alice2.outboxEntries() must already see the row
//      (proves persistence — not just in-memory state).
//   5. alice2: connect → authenticate → subscribe → manual flushOutbox().
//   6. Assert: flushResult.sent === 1, remaining === 0; cache row swapped
//      `pending` → `sent` carrying server_message_id; outbox empty;
//      `outbox_drained` event fired exactly once; bob's messageHistory
//      includes the new content.
//
// Phase 5C-1d's auto-flush-on-reconnect is covered by unit tests; this
// phase exclusively validates the cold-restart-and-manual-flush path.

import {
  PrivchatClient,
  type SendTextOperationResult,
  type SdkEvent,
} from '../../../../src/index.js';
import {
  DIRECT_SYNC_CHANNEL_TYPE,
  type MultiAccountManager,
} from '../account-manager.js';
import { emptyMetrics, type PhaseResult } from '../types.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const ENV = (key: string, fallback: string): string =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ((globalThis as any).process?.env?.[key] as string | undefined) ?? fallback;

export async function phase14_outbox(
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

  const host = ENV('PRIVCHAT_HOST', '127.0.0.1');
  const wsPort = Number(ENV('PRIVCHAT_WS_PORT', '9080'));
  const url = `ws://${host}:${wsPort}/`;

  // Wait for bob's manager to be re-authenticated after phase12's eviction.
  if (!(await waitForState(mgr.client('bob'), 'authenticated', 15_000))) {
    metrics.errors.push("bob's manager client did not re-authenticate within 3s");
    return finalize(start, metrics);
  }

  // alice's manager client was disconnected in phase13, so taking over
  // alice's session here is uncontested.
  const dbName = `phase14-${Date.now()}`;
  const content = `phase14 outbox @ ${Date.now()}`;

  // ----- alice1: enqueue offline -----

  const alice1 = new PrivchatClient({
    url,
    defaultTimeoutMs: 30_000,
    reconnect: { enabled: false },
    cache: { enabled: true, dbName },
  });

  let queued: SendTextOperationResult;
  let localMessageId: string;
  try {
    await alice1.connect();
    await alice1.authenticate(aliceCfg.user_id, aliceCfg.token, aliceCfg.device_id);
    metrics.rpc_calls += 1;
    metrics.rpc_successes += 1;

    await alice1.bootstrapChannels();
    metrics.rpc_calls += 2;

    await alice1.subscribeChannel(channelKey, DIRECT_SYNC_CHANNEL_TYPE);
    metrics.rpc_calls += 1;

    await alice1.openConversation(channelKey, DIRECT_SYNC_CHANNEL_TYPE);
    metrics.rpc_calls += 1;

    // Disconnect — Decision §5: outbox persists across disconnect.
    await alice1.disconnect();

    queued = await alice1.sendTextMessage({
      channel_id: channelKey,
      channel_type: DIRECT_SYNC_CHANNEL_TYPE,
      from_uid: aliceCfg.user_id,
      content,
    });
    metrics.messages_sent += 1;

    if (queued.status !== 'queued') {
      metrics.errors.push(
        `offline send: status=${queued.status}, expected 'queued' (outbox should hold it)`,
      );
      return finalize(start, metrics);
    }
    // 5C invariant: outbox_id aliases local_message_id.
    if (queued.outbox_id !== queued.local_message_id) {
      // 5C invariant: outbox_id is alias for local_message_id.
      metrics.errors.push(
        `outbox_id (${queued.outbox_id}) !== local_message_id (${queued.local_message_id})`,
      );
    }
    localMessageId = queued.local_message_id;
    metrics.rpc_successes += 1;

    const persistedRows = await alice1.outboxEntries();
    if (persistedRows.length !== 1 || persistedRows[0]!.outbox_id !== localMessageId) {
      metrics.errors.push(
        `alice1 outbox snapshot: ${JSON.stringify(persistedRows.map((r) => r.outbox_id))} (expected ['${localMessageId}'])`,
      );
      return finalize(start, metrics);
    }
    metrics.rpc_successes += 1;
  } catch (e) {
    metrics.errors.push(`alice1 phase: ${e instanceof Error ? e.message : String(e)}`);
    return finalize(start, metrics, async () => alice1.disconnect());
  }

  // alice1 is fully done. Pause briefly so any fire-and-forget
  // IndexedDB writes (the cache `pending` MessageRecord) settle before
  // alice2 attaches to the same dbName.
  await sleep(50);

  // ----- alice2: cold restart -----

  const alice2 = new PrivchatClient({
    url,
    defaultTimeoutMs: 30_000,
    reconnect: { enabled: false },
    cache: { enabled: true, dbName },
  });

  try {
    // First persistence proof: alice2 hasn't connected or authenticated
    // yet, but the outbox row from alice1 should already be visible.
    const restored = await alice2.outboxEntries();
    if (restored.length !== 1 || restored[0]!.outbox_id !== localMessageId) {
      metrics.errors.push(
        `cold-restart outbox: expected [${localMessageId}], got [${restored.map((r) => r.outbox_id).join(',')}]`,
      );
      return finalize(start, metrics, async () => alice2.disconnect());
    }
    metrics.rpc_successes += 1;

    // Capture L1 events emitted during the flush. We assert
    // `outbox_drained` count + presence of state transitions.
    const events: SdkEvent[] = [];
    alice2.observeEvents((env) => events.push(env.event));

    await alice2.connect();
    await alice2.authenticate(aliceCfg.user_id, aliceCfg.token, aliceCfg.device_id);
    metrics.rpc_calls += 2;
    metrics.rpc_successes += 1;

    // Subscribe so the server fans out a push for our own message back
    // to alice2's connection — this exercises the cache-push race the
    // local-trumps-self-push merge guards against. Without the guard
    // (pre cache-push fix) this would silently regress the cache row.
    await alice2.subscribeChannel(channelKey, DIRECT_SYNC_CHANNEL_TYPE);
    metrics.rpc_calls += 1;

    const flushResult = await alice2.flushOutbox();
    metrics.rpc_calls += 1;

    if (flushResult.sent !== 1 || flushResult.remaining !== 0) {
      metrics.errors.push(
        `flush result: sent=${flushResult.sent} remaining=${flushResult.remaining} attempted=${flushResult.attempted} failed=${flushResult.failed} (expected sent=1, remaining=0)`,
      );
      return finalize(start, metrics, async () => alice2.disconnect());
    }
    metrics.rpc_successes += 1;

    // Outbox now empty.
    const after = await alice2.outboxEntries();
    if (after.length !== 0) {
      metrics.errors.push(
        `outbox not empty after flush: ${JSON.stringify(after.map((r) => r.outbox_id))}`,
      );
    }

    // Engine completion: `outbox_state_changed { status: 'sent' }`.
    const sentEvents = events.filter(
      (e) =>
        e.type === 'outbox_state_changed' &&
        e.status === 'sent' &&
        e.local_message_id === localMessageId,
    );
    if (sentEvents.length !== 1) {
      metrics.errors.push(
        `outbox_state_changed sent count=${sentEvents.length} for local=${localMessageId}; expected 1`,
      );
    } else {
      const ev = sentEvents[0]!;
      if (ev.type === 'outbox_state_changed' && ev.server_message_id === undefined) {
        metrics.errors.push('sent event missing server_message_id');
      } else {
        metrics.rpc_successes += 1;
      }
    }

    // Cache row reflects the engine's authoritative ACK. The local-
    // trumps-self-push merge ensures the server's own-message push
    // (which lands shortly after the ACK with empty content) cannot
    // regress this row. Wait for any in-flight push absorption to
    // settle before asserting.
    await sleep(120);
    const cached = alice2.getCachedMessages(channelKey, DIRECT_SYNC_CHANNEL_TYPE);
    const ourRow = cached.find((m) => m.local_message_id === localMessageId);
    if (!ourRow) {
      metrics.errors.push(
        `cache: no row matching local_message_id=${localMessageId} (rows=${cached.length})`,
      );
    } else {
      if (ourRow.status !== 'sent') {
        metrics.errors.push(`cache row status=${ourRow.status}, expected 'sent'`);
      }
      if (ourRow.server_message_id === undefined) {
        metrics.errors.push('cache row server_message_id undefined after flush');
      } else {
        metrics.rpc_successes += 1;
      }
      if (ourRow.content !== content) {
        metrics.errors.push(
          `cache row content="${ourRow.content}", expected "${content}"`,
        );
      }
    }

    // Wait briefly for the async snapshot fanout to flush its drained emit.
    await sleep(80);

    const drainCount = events.filter((e) => e.type === 'outbox_drained').length;
    if (drainCount !== 1) {
      metrics.errors.push(
        `outbox_drained count=${drainCount}, expected 1 (state events: ${events.filter((e) => e.type === 'outbox_state_changed').length})`,
      );
    } else {
      metrics.rpc_successes += 1;
    }

    // Server-side verification: bob's messageHistory must now contain
    // a message with our content. This proves the message reached the
    // server (not just locally swapped to 'sent'). Match by content
    // since bob's manager is cache-disabled and follows a different
    // path that doesn't share the outbox row's identity.
    const history = await mgr.client('bob').messageHistory(channelId, 50);
    metrics.rpc_calls += 1;
    const found = history.messages.find((m) => m.content === content);
    if (!found) {
      metrics.errors.push(
        `bob's messageHistory missing phase14 content (count=${history.messages.length})`,
      );
    } else {
      metrics.rpc_successes += 1;
    }

    return finalize(start, metrics, async () => alice2.disconnect());
  } catch (e) {
    metrics.errors.push(`alice2 phase: ${e instanceof Error ? e.message : String(e)}`);
    return finalize(start, metrics, async () => alice2.disconnect());
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
    phase_name: 'outbox-persistence',
    success: metrics.errors.length === 0,
    duration_ms: Date.now() - start,
    details:
      'offline send → cold restart → manual flushOutbox → cache pending → sent → bob sees message',
    metrics,
  };
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
