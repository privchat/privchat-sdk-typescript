// Cache MVP smoke: spin up a 4th client for alice with cache enabled,
// re-authenticate, bootstrap, open the alice-bob direct channel, send
// a text via local echo, observe pending → sent.
//
// Lives separate from the main 3-client manager so the cache-disabled
// accounts E2E (phases 1–10) keeps proving the no-cache path stays clean.

import { PrivchatClient, type ConversationPatch } from '../../../../src/index.js';
import { CacheDB } from '../../../../src/cache-idb.js';
import { type MultiAccountManager, DIRECT_SYNC_CHANNEL_TYPE } from '../account-manager.js';
import { emptyMetrics, type PhaseResult } from '../types.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const ENV = (key: string, fallback: string): string =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ((globalThis as any).process?.env?.[key] as string | undefined) ?? fallback;

export async function phase11_cache_smoke(
  mgr: MultiAccountManager,
): Promise<PhaseResult> {
  const start = Date.now();
  const metrics = emptyMetrics();

  const channelId = mgr.cachedDirectChannel('alice', 'bob');
  if (!channelId) {
    metrics.errors.push('alice-bob direct channel missing — earlier phases must run first');
    return finalize(start, metrics);
  }

  const aliceCfg = mgr.config('alice');
  const host = ENV('PRIVCHAT_HOST', '127.0.0.1');
  const wsPort = Number(ENV('PRIVCHAT_WS_PORT', '9080'));
  // 复用 manager 的 URL(含 /gate listener path);自拼根路径被 404 拒握手。
  const url = mgr.url;

  // Cache-enabled client. Disable auto-reconnect to keep the smoke
  // bounded; we won't need it.
  const cacheClient = new PrivchatClient({
    url,
    defaultTimeoutMs: 30_000,
    reconnect: { enabled: false },
    cache: { enabled: true, db: new CacheDB(`phase11-${Date.now()}`) },
  });

  try {
    await cacheClient.connect();
    metrics.rpc_calls += 1;

    await cacheClient.authenticate(aliceCfg.user_id, aliceCfg.token, aliceCfg.device_id);
    metrics.rpc_calls += 1;
    metrics.rpc_successes += 1;

    // 1. bootstrap — should pull the same 2 direct channels alice has
    const channels = await cacheClient.bootstrapChannels();
    metrics.rpc_calls += 2;
    if (channels.length >= 2) metrics.rpc_successes += 1;
    else metrics.errors.push(`bootstrap returned ${channels.length} channels, expected ≥ 2`);

    const ours = channels.find((c) => c.channel_id === String(channelId));
    if (!ours) {
      metrics.errors.push(`bootstrapped channels missing alice-bob channel ${channelId}`);
      return finalize(start, metrics, async () => cacheClient.disconnect());
    }

    // 2. open conversation — should emit cached (empty) then remote (1+ msgs)
    const seen: Array<{ remote: boolean; count: number }> = [];
    const off = cacheClient.observeConversation(
      String(channelId),
      DIRECT_SYNC_CHANNEL_TYPE,
      (snap) => seen.push({ remote: snap.is_remote, count: snap.messages.length }),
    );

    const remote = await cacheClient.openConversation(
      String(channelId),
      DIRECT_SYNC_CHANNEL_TYPE,
    );
    metrics.rpc_calls += 1;

    if (remote.length === 0) {
      metrics.errors.push('openConversation returned 0 messages on a channel with sent traffic');
    } else {
      metrics.rpc_successes += 1;
    }
    if (seen.length === 0 || seen[seen.length - 1]!.remote !== true) {
      metrics.errors.push(`expected at least one is_remote=true emit, saw ${JSON.stringify(seen)}`);
    } else {
      metrics.rpc_successes += 1;
    }

    // 3. local echo — send a text, observe pending → sent
    const echoPatches: ConversationPatch[] = [];
    cacheClient.observeConversation(
      String(channelId),
      DIRECT_SYNC_CHANNEL_TYPE,
      (_, p) => echoPatches.push(p),
    );

    const sendResp = await cacheClient.sendTextMessage({
      channel_id: String(channelId),
      channel_type: DIRECT_SYNC_CHANNEL_TYPE,
      from_uid: aliceCfg.user_id,
      content: `phase11 echo @ ${Date.now()}`,
    });
    metrics.rpc_calls += 1;
    metrics.messages_sent += 1;

    // Phase 11 is the online happy path; we expect inline ACK, not a
    // queued result. (5C contract: `sendTextMessage` resolves with a
    // discriminated `'sent' | 'queued'` result instead of throwing.)
    if (sendResp.status !== 'sent') {
      metrics.errors.push(
        `local-echo send: status=${sendResp.status}, expected 'sent' (online path)`,
      );
    }

    // First echo patch = pending insert; subsequent = ACK swap.
    if (echoPatches.length < 2) {
      metrics.errors.push(`expected ≥ 2 patches (pending + ack), got ${echoPatches.length}`);
    } else {
      const pending = echoPatches[0]!;
      const ack = echoPatches[echoPatches.length - 1]!;
      if (pending.upserted[0]?.status === 'pending') {
        metrics.rpc_successes += 1;
      } else {
        metrics.errors.push(`first echo patch status=${pending.upserted[0]?.status}, expected pending`);
      }
      if (ack.upserted[0]?.status === 'sent') {
        metrics.rpc_successes += 1;
      } else {
        metrics.errors.push(
          `last echo patch status=${ack.upserted[0]?.status} server_message_id=${ack.upserted[0]?.server_message_id}, expected sent w/ server id`,
        );
      }
      // 三 ID 分权(CODEX-2)后 message.id 稳定:ack 是**原地更新**同一行,
      // 不再 remove+insert。现行契约由 tests/client/local-echo.test.ts:141
      // 钉死(removed=[]);旧断言(期望 removed=[localId])是分权前的产物。
      if (ack.removed.length === 0 && ack.upserted[0]?.id === pending.upserted[0]?.id) {
        metrics.rpc_successes += 1;
      } else {
        metrics.errors.push(
          `ack patch shape drifted: removed=${JSON.stringify(ack.removed)} ` +
            `pendingId=${pending.upserted[0]?.id} ackId=${ack.upserted[0]?.id} ` +
            '(stable-id contract: in-place update, removed=[])',
        );
      }
    }

    // Brief pause so async IndexedDB writes settle before we tear down.
    await sleep(50);
    off();

    return finalize(start, metrics, async () => cacheClient.disconnect());
  } catch (e) {
    const detail = e instanceof Error
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
    try { await cleanup(); } catch { /* */ }
  }
  return {
    phase_name: 'cache-smoke',
    success: metrics.errors.length === 0,
    duration_ms: Date.now() - start,
    details: 'cache-enabled client: bootstrap + openConversation + local echo (pending → sent)',
    metrics,
  };
}
