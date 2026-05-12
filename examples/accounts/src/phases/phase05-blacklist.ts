import type { MultiAccountManager } from '../account-manager.js';
import { emptyMetrics, type PhaseResult } from '../types.js';

export async function phase05_blacklist(
  mgr: MultiAccountManager,
): Promise<PhaseResult> {
  const start = Date.now();
  const metrics = emptyMetrics();

  const alice = mgr.client('alice');
  const aliceUid = Number(mgr.userId('alice'));
  const bobUid = Number(mgr.userId('bob'));

  // 1. add bob to alice's blacklist
  const addOk = await alice.blacklistAdd(aliceUid, bobUid);
  metrics.rpc_calls += 1;
  if (addOk) metrics.rpc_successes += 1;
  else metrics.errors.push('alice failed to add bob to blacklist');

  // 2. check blocked
  const check = await alice.blacklistCheck(aliceUid, bobUid);
  metrics.rpc_calls += 1;
  if (check.blocked) metrics.rpc_successes += 1;
  else metrics.errors.push('blacklist check did not see bob after add');

  // 3. list — bob should appear
  const list = await alice.blacklistList(aliceUid);
  metrics.rpc_calls += 1;
  if (list.users.some((u) => u.blocked_user_id === bobUid)) {
    metrics.rpc_successes += 1;
  } else {
    metrics.errors.push('bob missing from blacklist list');
  }

  // 4. remove
  const removed = await alice.blacklistRemove(aliceUid, bobUid);
  metrics.rpc_calls += 1;
  if (removed) metrics.rpc_successes += 1;
  else metrics.errors.push('blacklist remove returned false');

  // 5. check again — should be cleared
  const recheck = await alice.blacklistCheck(aliceUid, bobUid);
  metrics.rpc_calls += 1;
  if (!recheck.blocked) metrics.rpc_successes += 1;
  else metrics.errors.push('blacklist check still sees bob after remove');

  return {
    phase_name: 'blacklist',
    success: metrics.errors.length === 0,
    duration_ms: Date.now() - start,
    details: 'add → check → list → remove → recheck for alice/bob',
    metrics,
  };
}
