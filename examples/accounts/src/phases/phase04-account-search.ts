import type { MultiAccountManager } from '../account-manager.js';
import { emptyMetrics, type PhaseResult } from '../types.js';

export async function phase04_account_search(
  mgr: MultiAccountManager,
): Promise<PhaseResult> {
  const start = Date.now();
  const metrics = emptyMetrics();

  // Each account searches the other two by username and verifies a hit.
  const probes: Array<[string, string]> = [
    ['alice', 'bob'],
    ['alice', 'charlie'],
    ['bob', 'alice'],
    ['bob', 'charlie'],
    ['charlie', 'alice'],
    ['charlie', 'bob'],
  ];

  for (const [from, to] of probes) {
    const target = mgr.username(to);
    const resp = await mgr.client(from).accountSearch(target);
    metrics.rpc_calls += 1;
    if (resp.users.some((u) => u.username === target)) {
      metrics.rpc_successes += 1;
    } else {
      metrics.errors.push(`${from} search did not find ${target}`);
    }
  }

  return {
    phase_name: 'account-search',
    success: metrics.errors.length === 0,
    duration_ms: Date.now() - start,
    details: '6 account-search queries across all account pairs',
    metrics,
  };
}
