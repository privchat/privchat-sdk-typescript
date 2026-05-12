// Group lifecycle smoke: alice creates a group, adds bob+charlie, queries info,
// lists members, then bob leaves. Validates the full server group surface
// the SDK sugars cover.

import type { MultiAccountManager } from '../account-manager.js';
import { emptyMetrics, type PhaseResult } from '../types.js';

export async function phase07_group_lifecycle(
  mgr: MultiAccountManager,
): Promise<PhaseResult> {
  const start = Date.now();
  const metrics = emptyMetrics();
  const alice = mgr.client('alice');
  const bob = mgr.client('bob');
  const aliceUid = Number(mgr.userId('alice'));
  const bobUid = Number(mgr.userId('bob'));
  const charlieUid = Number(mgr.userId('charlie'));

  // 1. create
  const created = await alice.groupCreate(`group_${mgr.suffix}`, 'phase07 group');
  metrics.rpc_calls += 1;
  if (created.group_id > 0 && created.creator_id === aliceUid) {
    metrics.rpc_successes += 1;
  } else {
    metrics.errors.push(
      `groupCreate returned group_id=${created.group_id} creator_id=${created.creator_id}; expected creator_id=${aliceUid}`,
    );
    return earlyFail(metrics, start);
  }
  const groupId = created.group_id;

  // 2. add bob + charlie
  for (const uid of [bobUid, charlieUid]) {
    const ok = await alice.groupMemberAdd(groupId, uid);
    metrics.rpc_calls += 1;
    if (ok) metrics.rpc_successes += 1;
    else metrics.errors.push(`groupMemberAdd(${uid}) returned false`);
  }

  // 3. group info — verify member_count + nested group_info shape
  const info = await alice.groupInfo(groupId);
  metrics.rpc_calls += 1;
  if (info.status === 'success') metrics.rpc_successes += 1;
  else metrics.errors.push(`groupInfo.status="${info.status}", expected "success"`);

  if (info.group_info?.group_id !== groupId) {
    metrics.errors.push(
      `groupInfo.group_info.group_id=${info.group_info?.group_id}, expected ${groupId}`,
    );
  }
  if (info.group_info?.owner_id !== aliceUid) {
    metrics.errors.push(
      `groupInfo.group_info.owner_id=${info.group_info?.owner_id}, expected alice ${aliceUid}`,
    );
  }
  if ((info.group_info?.member_count ?? 0) < 3) {
    metrics.errors.push(
      `groupInfo.group_info.member_count=${info.group_info?.member_count}, expected ≥ 3 (alice+bob+charlie)`,
    );
  }

  // 4. member list — alice is owner, bob+charlie are present
  const list = await alice.groupMemberList(groupId);
  metrics.rpc_calls += 1;
  const memberIds = list.members.map((m) => m.user_id);
  for (const expected of [aliceUid, bobUid, charlieUid]) {
    if (memberIds.includes(expected)) {
      metrics.rpc_successes += 1;
    } else {
      metrics.errors.push(`groupMemberList missing uid=${expected}`);
    }
  }

  // 5. bob leaves
  const left = await bob.groupMemberLeave(groupId);
  metrics.rpc_calls += 1;
  if (left) metrics.rpc_successes += 1;
  else metrics.errors.push('bob groupMemberLeave returned false');

  // 6. confirm bob is gone (best-effort — server may be eventually consistent)
  const after = await alice.groupMemberList(groupId);
  metrics.rpc_calls += 1;
  if (!after.members.some((m) => m.user_id === bobUid)) {
    metrics.rpc_successes += 1;
  } else {
    metrics.errors.push('bob still in member list after leave');
  }

  return {
    phase_name: 'group-lifecycle',
    success: metrics.errors.length === 0,
    duration_ms: Date.now() - start,
    details: `group ${groupId}: create → add×2 → info → list → leave (bob)`,
    metrics,
  };
}

function earlyFail(metrics: ReturnType<typeof emptyMetrics>, start: number): PhaseResult {
  return {
    phase_name: 'group-lifecycle',
    success: false,
    duration_ms: Date.now() - start,
    details: 'aborted on groupCreate failure',
    metrics,
  };
}
