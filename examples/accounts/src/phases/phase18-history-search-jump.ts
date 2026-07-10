// MESSAGE_HISTORY spec §4/§5/§6 E2E：云端历史搜索 + jump-to-message 回灌。
//
// bob → alice 频道发一条带唯一标记的中文消息（phase13 已把 alice 主连接
// 显式断开，bob/charlie 仍在线；搜索可见性只看会话成员，自发自搜成立），然后：
//   1. bob GLOBAL 搜索（CJK bigram 索引 + ILIKE recheck）必须命中且带高亮区间；
//   2. bob CHANNEL scope 搜索同样命中；
//   3. bob jumpToMessageContext(anchor) 必须返回 anchor 且回灌本地缓存
//      （contract §6：around 完整消息落库；search snippet 决不落库）；
//   4. 非成员 charlie GLOBAL 搜索同一关键词必须零命中（§4 EXISTS 成员过滤）。

import { PrivchatClient } from '@privchat/sdk';
import { DIRECT_SYNC_CHANNEL_TYPE, type MultiAccountManager } from '../account-manager.js';
import { emptyMetrics, type PhaseResult } from '../types.js';

const ENV = (k: string, d: string): string => process.env[k] ?? d;

export async function phase18_history_search_jump(
  mgr: MultiAccountManager,
): Promise<PhaseResult> {
  const start = Date.now();
  const metrics = emptyMetrics();
  const fail = (details: string): PhaseResult => ({
    phase_name: 'history-search-jump',
    success: false,
    duration_ms: Date.now() - start,
    details,
    metrics,
  });

  const ab = mgr.cachedDirectChannel('alice', 'bob');
  if (!ab) return fail('missing alice-bob channel — phase02 must run first');

  // 唯一标记：进程号+时间片，避免多轮运行互相命中
  const marker = `福寿搜索标记${(Date.now() % 100000).toString()}`;
  const text = `全局搜索验收 ${marker} 完毕`;
  const resp = await mgr.sendText('bob', ab, DIRECT_SYNC_CHANNEL_TYPE, text);
  metrics.rpc_calls += 2;
  metrics.messages_sent += 1;
  if (typeof resp.decision !== 'string' && !('transformed' in resp.decision)) {
    return fail(`send rejected: ${JSON.stringify(resp.decision)}`);
  }
  metrics.rpc_successes += 2;

  // 服务端异步注入/索引给一点余量
  await new Promise((r) => setTimeout(r, 800));

  const bob = mgr.client('bob');

  // 1) GLOBAL 搜索命中 + 高亮区间
  const global = await bob.messageHistorySearch(marker);
  metrics.rpc_calls += 1;
  const hit = global.hits.find((h) => String(h.channel_id) === String(ab));
  if (hit === undefined) {
    return fail(`GLOBAL search missed marker (hits=${global.hits.length})`);
  }
  if (!hit.snippet.includes(marker)) return fail('snippet missing marker text');
  if (hit.highlight_ranges.length === 0) return fail('highlight_ranges empty');
  metrics.rpc_successes += 1;

  // 2) CHANNEL scope 命中（间隔 >300ms 避开 per-user 搜索限频——限频本身
  //    已被这里反向验证：不 sleep 会得到 code=10300）
  await new Promise((r) => setTimeout(r, 350));
  const scoped = await bob.messageHistorySearch(marker, { channelId: ab });
  metrics.rpc_calls += 1;
  if (scoped.hits.length === 0) return fail('CHANNEL search missed marker');
  metrics.rpc_successes += 1;

  // 3) jumpToMessageContext：anchor + 回灌（cache API——起一个 cache-enabled
  //    客户端，等价 Web/H5 的运行形态；主测试 client 未开 cache）
  const bobCfg = mgr.config('bob');
  const url = `ws://${ENV('PRIVCHAT_HOST', '127.0.0.1')}:${ENV('PRIVCHAT_WS_PORT', '9080')}/`;
  const cacheClient = new PrivchatClient({
    url,
    defaultTimeoutMs: 30_000,
    reconnect: { enabled: false },
    cache: { enabled: true, dbName: `phase18-${Date.now()}` },
  });
  try {
    await cacheClient.connect();
    await cacheClient.authenticate(bobCfg.user_id, bobCfg.token, bobCfg.device_id);
    metrics.rpc_calls += 2;
    const jump = await cacheClient.jumpToMessageContext(
      String(ab),
      DIRECT_SYNC_CHANNEL_TYPE,
      String(hit.message_id),
    );
    metrics.rpc_calls += 1;
    if (jump.anchor.server_message_id !== String(hit.message_id)) {
      return fail(
        `jump anchor mismatch: ${jump.anchor.server_message_id} != ${hit.message_id}`,
      );
    }
    if (!jump.anchor.content.includes(marker)) return fail('anchor content mismatch');
    if (jump.anchor.pts === undefined) {
      return fail('anchor pts missing (backfill must carry message_seq)');
    }
    // 回灌断言：本地缓存（内存 buffer）现在必须能读到 anchor——离线可见的基础
    const cached = cacheClient
      .getCachedMessages(String(ab), DIRECT_SYNC_CHANNEL_TYPE)
      .find((m) => m.server_message_id === String(hit.message_id));
    if (cached === undefined) return fail('anchor not backfilled into local cache');
    metrics.rpc_successes += 1;
  } finally {
    await cacheClient.disconnect().catch(() => undefined);
  }

  // 4) 非成员零命中（spec §4 EXISTS participants + left_at IS NULL）
  //    charlie 是独立 user，限频按 user 计——无需 sleep（顺带验证限频粒度）
  const outsider = await mgr.client('charlie').messageHistorySearch(marker);
  metrics.rpc_calls += 1;
  const leaked = outsider.hits.some((h) => String(h.channel_id) === String(ab));
  if (leaked) return fail('SECURITY: non-member search leaked alice-bob message');
  metrics.rpc_successes += 1;

  return {
    phase_name: 'history-search-jump',
    success: true,
    duration_ms: Date.now() - start,
    details:
      'GLOBAL+CHANNEL search hit with highlights; jump anchored with pts backfill; non-member sees nothing',
    metrics,
  };
}
