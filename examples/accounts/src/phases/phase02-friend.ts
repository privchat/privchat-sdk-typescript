import type { AccountSearchResponse } from '../../../../src/index.js';
import type { MultiAccountManager } from '../account-manager.js';
import { emptyMetrics, type PhaseResult } from '../types.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function firstHit(search: AccountSearchResponse, username: string) {
  const hit = search.users.find((u) => u.username === username);
  if (!hit) {
    throw new Error(`search did not return ${username}`);
  }
  return hit;
}

export async function phase02_friend_system(
  mgr: MultiAccountManager,
): Promise<PhaseResult> {
  const start = Date.now();
  const metrics = emptyMetrics();
  const pairs: Array<[string, string]> = [
    ['alice', 'bob'],
    ['alice', 'charlie'],
    ['bob', 'charlie'],
  ];

  for (const [from, to] of pairs) {
    const fromClient = mgr.client(from);
    const toClient = mgr.client(to);
    const toUsername = mgr.username(to);

    const search = await fromClient.accountSearch(toUsername);
    metrics.rpc_calls += 1;
    metrics.rpc_successes += 1;
    const hit = firstHit(search, toUsername);
    const toUid = hit.user_id;

    // 隐私闸(2026-07-21)会校验 source:声明 friend 但双方还不是好友 → 10004。
    // 正确姿势与 Rust harness 一致:search 之后用 source:'search' + 服务端
    // 发回的 search_session_id 作为凭证申请。
    const apply = await fromClient.friendApply(
      toUid,
      'hello from accounts example',
      'search',
      hit.search_session_id,
    );
    metrics.rpc_calls += 1;
    if (apply.user_id > 0) metrics.rpc_successes += 1;
    else metrics.errors.push(`${from}->${to} apply failed`);

    await sleep(150);

    const pending = await toClient.friendPending();
    metrics.rpc_calls += 1;
    const fromUid = Number(mgr.userId(from));
    if (pending.requests.some((p) => p.from_user_id === fromUid)) {
      metrics.rpc_successes += 1;
    } else {
      metrics.errors.push(`${to} pending list missing ${from}`);
    }

    const accepted = await toClient.friendAccept(fromUid, 'accepted');
    metrics.rpc_calls += 1;
    if (accepted > 0) metrics.rpc_successes += 1;
    else metrics.errors.push(`${to} accept ${from} failed`);

    // friend/check is eventually consistent on some server builds — retry up to ~1.6s
    for (let attempt = 0; attempt < 8; attempt++) {
      const a = await fromClient.friendCheck(toUid);
      const b = await toClient.friendCheck(fromUid);
      metrics.rpc_calls += 2;
      if (a.is_friend && b.is_friend) {
        metrics.rpc_successes += 2;
        break;
      }
      await sleep(200);
    }

    const direct = await mgr.getOrCreateDirectChannel(from, to);
    const reverse = await mgr.getOrCreateDirectChannel(to, from);
    metrics.rpc_calls += 2;
    if (direct > 0 && reverse > 0) {
      metrics.rpc_successes += 2;
    } else {
      metrics.errors.push(`${from}<->${to} direct channel missing`);
    }
  }

  return {
    phase_name: 'friend-system',
    success: metrics.errors.length === 0,
    duration_ms: Date.now() - start,
    details: 'mutual friendships + direct channels created for alice/bob/charlie',
    metrics,
  };
}
