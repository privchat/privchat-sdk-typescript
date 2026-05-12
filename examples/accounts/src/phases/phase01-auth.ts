import type { MultiAccountManager } from '../account-manager.js';
import { emptyMetrics, type PhaseResult } from '../types.js';

export async function phase01_auth_and_bootstrap(
  mgr: MultiAccountManager,
): Promise<PhaseResult> {
  const start = Date.now();
  const metrics = emptyMetrics();

  for (const key of ['alice', 'bob', 'charlie']) {
    metrics.rpc_calls += 1;
    const cfg = mgr.config(key);
    if (cfg.user_id && cfg.token && cfg.device_id && mgr.client(key).isConnected()) {
      metrics.rpc_successes += 1;
    } else {
      metrics.errors.push(`${key} not fully authenticated`);
    }
  }

  try {
    await mgr.verifyAllConnected();
  } catch (e) {
    metrics.errors.push(`connection verification failed: ${(e as Error).message}`);
  }

  return {
    phase_name: 'auth/bootstrap',
    success: metrics.errors.length === 0,
    duration_ms: Date.now() - start,
    details: 'register + authenticate + connectivity verified for 3 accounts',
    metrics,
  };
}
