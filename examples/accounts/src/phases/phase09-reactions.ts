// Reaction add / list / remove against a real message from phase03's
// direct sends. Wire shape verification matters here because reactions/list
// returns a join-aggregated structure (`{ reactions, total_count, success }`)
// that's easy to model wrong.

import { type MultiAccountManager } from '../account-manager.js';
import { emptyMetrics, type PhaseResult } from '../types.js';

const EMOJI = '👍';

export async function phase09_reactions(
  mgr: MultiAccountManager,
): Promise<PhaseResult> {
  const start = Date.now();
  const metrics = emptyMetrics();

  const channelId = mgr.cachedDirectChannel('alice', 'bob');
  if (!channelId) {
    metrics.errors.push('alice-bob direct channel missing');
    return earlyFail(metrics, start);
  }

  // Need a real server_message_id to react to. Pull the latest from history.
  const history = await mgr.client('alice').messageHistory(channelId, 1);
  metrics.rpc_calls += 1;
  if (history.messages.length === 0) {
    metrics.errors.push('no messages in alice-bob channel to react to');
    return earlyFail(metrics, start);
  }
  const targetMsgId = history.messages[history.messages.length - 1]!.message_id;
  const aliceUid = Number(mgr.userId('alice'));

  // 1. add a reaction
  const added = await mgr.client('alice').messageReactionAdd(targetMsgId, EMOJI);
  metrics.rpc_calls += 1;
  if (added) metrics.rpc_successes += 1;
  else metrics.errors.push('messageReactionAdd returned false');

  // 2. list — wire shape is { success, reactions: { emoji: [user_id, ...] }, total_count }
  const list = await mgr.client('alice').messageReactionList(targetMsgId);
  metrics.rpc_calls += 1;
  if (typeof list.success !== 'boolean') {
    metrics.errors.push(`reactionList.success expected boolean, got ${typeof list.success}`);
  }
  if (typeof list.reactions !== 'object' || list.reactions === null || Array.isArray(list.reactions)) {
    metrics.errors.push(
      `reactionList.reactions expected emoji→user_ids map, got ${Array.isArray(list.reactions) ? 'array' : typeof list.reactions}`,
    );
  } else {
    const users = list.reactions[EMOJI];
    if (!Array.isArray(users)) {
      metrics.errors.push(`reactionList.reactions["${EMOJI}"] missing or not array after add`);
    } else if (!users.includes(aliceUid)) {
      metrics.errors.push(
        `reactionList.reactions["${EMOJI}"] missing alice uid=${aliceUid}; got ${JSON.stringify(users)}`,
      );
    } else {
      metrics.rpc_successes += 1;
    }
  }
  if (typeof list.total_count !== 'number') {
    metrics.errors.push(`reactionList.total_count expected number, got ${typeof list.total_count}`);
  }

  // 3. remove
  const removed = await mgr.client('alice').messageReactionRemove(targetMsgId, EMOJI);
  metrics.rpc_calls += 1;
  if (removed) metrics.rpc_successes += 1;
  else metrics.errors.push('messageReactionRemove returned false');

  // 4. recheck — emoji key should be gone or its user list empty/without alice
  const after = await mgr.client('alice').messageReactionList(targetMsgId);
  metrics.rpc_calls += 1;
  const remainingUsers = after.reactions?.[EMOJI];
  const aliceStillReacted = Array.isArray(remainingUsers) && remainingUsers.includes(aliceUid);
  if (!aliceStillReacted) metrics.rpc_successes += 1;
  else metrics.errors.push(`reaction ${EMOJI} still has alice uid after remove`);

  return {
    phase_name: 'reactions',
    success: metrics.errors.length === 0,
    duration_ms: Date.now() - start,
    details: `add → list → remove → recheck on message ${targetMsgId}`,
    metrics,
  };
}

function earlyFail(metrics: ReturnType<typeof emptyMetrics>, start: number): PhaseResult {
  return {
    phase_name: 'reactions',
    success: false,
    duration_ms: Date.now() - start,
    details: 'aborted on precondition failure',
    metrics,
  };
}
