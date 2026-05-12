import { DIRECT_SYNC_CHANNEL_TYPE, type MultiAccountManager } from '../account-manager.js';
import type { ClientSubmitResponse } from '../rpc-types.js';
import { emptyMetrics, type PhaseResult } from '../types.js';

function submitOk(resp: ClientSubmitResponse): boolean {
  if (resp.decision === 'accepted') return true;
  if (typeof resp.decision === 'object' && 'transformed' in resp.decision) return true;
  return false;
}

export async function phase03_direct_send(
  mgr: MultiAccountManager,
): Promise<PhaseResult> {
  const start = Date.now();
  const metrics = emptyMetrics();

  const ab = mgr.cachedDirectChannel('alice', 'bob');
  const bc = mgr.cachedDirectChannel('bob', 'charlie');
  const ca = mgr.cachedDirectChannel('charlie', 'alice');
  if (!ab || !bc || !ca) {
    metrics.errors.push('missing cached direct channel(s) — phase02 must run first');
    return {
      phase_name: 'direct-hello-send',
      success: false,
      duration_ms: Date.now() - start,
      details: 'precondition failed',
      metrics,
    };
  }

  const sends: Array<[string, number, string]> = [
    ['alice', ab, 'hello friend'],
    ['bob', bc, 'hello friend'],
    ['charlie', ca, 'hello friend'],
  ];

  for (const [from, channelId, text] of sends) {
    const resp = await mgr.sendText(from, channelId, DIRECT_SYNC_CHANNEL_TYPE, text);
    metrics.rpc_calls += 2; // get_pts + submit
    metrics.messages_sent += 1;
    if (submitOk(resp)) {
      metrics.rpc_successes += 2;
    } else {
      metrics.errors.push(`${from} submit rejected: ${JSON.stringify(resp.decision)}`);
    }
  }

  return {
    phase_name: 'direct-hello-send',
    success: metrics.errors.length === 0,
    duration_ms: Date.now() - start,
    details: 'sent "hello friend" on alice-bob, bob-charlie, charlie-alice direct channels',
    metrics,
  };
}
