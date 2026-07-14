// Verify message/history/get wire shape on a channel that already has
// messages from phase03 (direct-hello-send). Phase 4's openConversation
// will rely on this RPC to populate the cached window.

import { DIRECT_SYNC_CHANNEL_TYPE, type MultiAccountManager } from '../account-manager.js';
import { emptyMetrics, type PhaseResult } from '../types.js';

export async function phase08_message_history(
  mgr: MultiAccountManager,
): Promise<PhaseResult> {
  const start = Date.now();
  const metrics = emptyMetrics();

  const channelId = mgr.cachedDirectChannel('alice', 'bob');
  if (!channelId) {
    metrics.errors.push('alice-bob direct channel missing — phase02 must run first');
    return {
      phase_name: 'message-history',
      success: false,
      duration_ms: Date.now() - start,
      details: 'precondition failed',
      metrics,
    };
  }

  // 1. fetch latest 10 messages
  const resp = await mgr.client('alice').messageHistory(channelId, 10);
  metrics.rpc_calls += 1;

  if (!Array.isArray(resp.messages)) {
    metrics.errors.push('messageHistory.messages is not an array');
    return finalize(start, metrics, channelId, 0);
  }
  if (typeof resp.has_more !== 'boolean') {
    metrics.errors.push(`messageHistory.has_more expected boolean, got ${typeof resp.has_more}`);
  }
  if (typeof resp.total !== 'number') {
    metrics.errors.push(`messageHistory.total expected number, got ${typeof resp.total}`);
  }

  // phase03 sent at least 1 message in this channel (alice → bob "hello friend")
  if (resp.messages.length === 0) {
    metrics.errors.push('messageHistory returned 0 messages on a channel with sent traffic');
    return finalize(start, metrics, channelId, 0);
  }
  metrics.rpc_successes += 1;

  // Per-message field shape — Phase 4 maps these into MessageRecord
  for (const m of resp.messages) {
    // server message_id is a u64 (snowflake) — it MUST be a string end to end (a JS number would
    // silently lose precision above 2^53). Runtime correctly returns a string; the SDK api-types
    // declaration (message_id: number) is a latent typing bug tracked separately.
    if (typeof m.message_id !== 'string') {
      metrics.errors.push(`message.message_id expected string (u64), got ${typeof m.message_id}`);
    }
    if (typeof m.channel_id !== 'number') {
      metrics.errors.push(`message.channel_id expected number, got ${typeof m.channel_id}`);
    } else if (m.channel_id !== channelId) {
      metrics.errors.push(`message.channel_id=${m.channel_id} != requested ${channelId}`);
    }
    if (typeof m.sender_id !== 'number') {
      metrics.errors.push(`message.sender_id expected number, got ${typeof m.sender_id}`);
    }
    if (typeof m.timestamp !== 'number') {
      metrics.errors.push(`message.timestamp expected number, got ${typeof m.timestamp}`);
    }
    if (typeof m.message_type !== 'string') {
      metrics.errors.push(`message.message_type expected string ("text"/"image"/...), got ${typeof m.message_type}`);
    }
    if (typeof m.content !== 'string') {
      metrics.errors.push(`message.content expected string, got ${typeof m.content}`);
    }
    // Note: per-channel pts is intentionally NOT carried by message/history/get
    // (Phase 5B-0 confirmed). Clients that need pts call sync/get_channel_pts.
  }
  metrics.rpc_successes += 1;

  // 2. pagination by before_server_message_id (only if we have ≥ 2 messages)
  if (resp.messages.length >= 2) {
    const oldest = resp.messages[0]!;
    const before = await mgr.client('alice').messageHistory(channelId, 10, oldest.message_id);
    metrics.rpc_calls += 1;
    // Pagination contract: every returned message_id < before_server_message_id. Compare as BigInt
    // — message_id is a u64 string, so a plain >= would do a lexicographic (wrong) comparison.
    const violators = before.messages.filter((m) => BigInt(m.message_id) >= BigInt(oldest.message_id));
    if (violators.length === 0) {
      metrics.rpc_successes += 1;
    } else {
      metrics.errors.push(
        `pagination: ${violators.length} message(s) have message_id >= before=${oldest.message_id}`,
      );
    }
  }

  return finalize(start, metrics, channelId, resp.messages.length);
}

function finalize(start: number, metrics: ReturnType<typeof emptyMetrics>, channelId: number, fetched: number): PhaseResult {
  return {
    phase_name: 'message-history',
    success: metrics.errors.length === 0,
    duration_ms: Date.now() - start,
    details: `channel ${channelId}: fetched ${fetched} message(s) + pagination smoke`,
    metrics,
  };
}
