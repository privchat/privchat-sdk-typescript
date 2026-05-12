// presence/typing + presence/status/get smoke. Both are server-rate-limited
// and best-effort, so the phase is loose (verify response shape, not delivery).

import {
  DIRECT_SYNC_CHANNEL_TYPE,
  type MultiAccountManager,
} from '../account-manager.js';
import { emptyMetrics, type PhaseResult } from '../types.js';

export async function phase10_typing_presence(
  mgr: MultiAccountManager,
): Promise<PhaseResult> {
  const start = Date.now();
  const metrics = emptyMetrics();

  const channelId = mgr.cachedDirectChannel('alice', 'bob');
  if (!channelId) {
    metrics.errors.push('alice-bob direct channel missing');
    return finalize(start, metrics);
  }

  // ---------- typing ----------

  // action_type enum is PascalCase per server: Typing | Recording |
  // UploadingPhoto | UploadingVideo | UploadingFile | ChoosingSticker.
  // is_typing=false uses the same variant; the boolean carries start/stop.
  const typingResp = await mgr
    .client('alice')
    .sendTyping(channelId, true, 'Typing', DIRECT_SYNC_CHANNEL_TYPE);
  metrics.rpc_calls += 1;
  if (typeof typingResp.code !== 'number') {
    metrics.errors.push(`typing.code expected number, got ${typeof typingResp.code}`);
  } else if (typingResp.code !== 0) {
    metrics.errors.push(`typing.code=${typingResp.code} (expected 0); message="${typingResp.message}"`);
  } else {
    metrics.rpc_successes += 1;
  }
  if (typeof typingResp.message !== 'string') {
    metrics.errors.push(`typing.message expected string, got ${typeof typingResp.message}`);
  }

  // Server rate-limits typing to 500ms per (user, channel); calling again
  // immediately should still succeed (server returns OK even when suppressed).
  const typingStop = await mgr
    .client('alice')
    .sendTyping(channelId, false, 'Typing', DIRECT_SYNC_CHANNEL_TYPE);
  metrics.rpc_calls += 1;
  if (typingStop.code === 0) metrics.rpc_successes += 1;
  else metrics.errors.push(`typing-stop.code=${typingStop.code}`);

  // ---------- batch presence ----------

  const bobUid = Number(mgr.userId('bob'));
  const charlieUid = Number(mgr.userId('charlie'));
  const presence = await mgr.client('alice').batchGetPresence([bobUid, charlieUid]);
  metrics.rpc_calls += 1;

  if (!Array.isArray(presence.items)) {
    metrics.errors.push('presence.items is not an array');
  } else {
    metrics.rpc_successes += 1;
    for (const item of presence.items) {
      if (typeof item.user_id !== 'number') {
        metrics.errors.push(`presence item.user_id expected number, got ${typeof item.user_id}`);
      }
      if (typeof item.is_online !== 'boolean') {
        metrics.errors.push(`presence item.is_online expected boolean, got ${typeof item.is_online}`);
      }
      if (typeof item.last_seen_at !== 'number') {
        metrics.errors.push(`presence item.last_seen_at expected number, got ${typeof item.last_seen_at}`);
      }
      if (typeof item.device_count !== 'number') {
        metrics.errors.push(`presence item.device_count expected number, got ${typeof item.device_count}`);
      }
    }
  }
  if (!Array.isArray(presence.denied_user_ids)) {
    metrics.errors.push('presence.denied_user_ids is not an array');
  }

  return finalize(start, metrics);
}

function finalize(start: number, metrics: ReturnType<typeof emptyMetrics>): PhaseResult {
  return {
    phase_name: 'typing-presence',
    success: metrics.errors.length === 0,
    duration_ms: Date.now() - start,
    details: 'sendTyping start/stop + batchGetPresence shape verified',
    metrics,
  };
}
