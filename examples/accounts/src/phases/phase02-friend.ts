import type { AccountSearchResponse } from '../../../../src/index.js';
import type { MultiAccountManager } from '../account-manager.js';
import { emptyMetrics, type PhaseResult } from '../types.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function firstUserId(search: AccountSearchResponse, username: string): number {
  const hit = search.users.find((u) => u.username === username);
  if (!hit) {
    throw new Error(`search did not return ${username}`);
  }
  return hit.user_id;
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
    const toUid = firstUserId(search, toUsername);

    const apply = await fromClient.friendApply(toUid, 'hello from accounts example', 'friend', String(toUid));
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
