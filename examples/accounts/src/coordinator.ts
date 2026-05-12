// Mirrors Rust `examples/accounts/src/coordinator.rs`. Runs phase functions
// in order, prints PASS/FAIL with per-phase metrics, and aggregates a final
// summary. Every phase is responsible for catching its own errors; a thrown
// exception from a phase is recorded as FAIL but does not abort the run.

import type { MultiAccountManager } from './account-manager.js';
import type { PhaseResult, TestSummary } from './types.js';

export type PhaseFn = (mgr: MultiAccountManager) => Promise<PhaseResult>;

export class TestCoordinator {
  private results: PhaseResult[] = [];

  async runAll(mgr: MultiAccountManager, phases: PhaseFn[]): Promise<void> {
    for (const phase of phases) {
      let result: PhaseResult;
      try {
        result = await phase(mgr);
      } catch (e) {
        result = {
          phase_name: 'runtime-error',
          success: false,
          duration_ms: 0,
          details: e instanceof Error ? e.message : String(e),
          metrics: { rpc_calls: 0, rpc_successes: 0, messages_sent: 0, errors: [String(e)] },
        };
      }
      this.printResult(result);
      this.results.push(result);
    }
  }

  summary(durationMs: number): TestSummary {
    const total = this.results.length;
    const passed = this.results.filter((r) => r.success).length;
    return {
      total,
      passed,
      failed: total - passed,
      duration_ms: durationMs,
      results: [...this.results],
    };
  }

  private printResult(r: PhaseResult): void {
    const status = r.success ? 'PASS' : 'FAIL';
    const padded = r.phase_name.padEnd(30);
    const ms = r.duration_ms.toString().padStart(5);
    // eslint-disable-next-line no-console
    console.log(`[${status}] ${padded} | ${ms} ms | ${r.details}`);
    for (const err of r.metrics.errors) {
      // eslint-disable-next-line no-console
      console.log(`  - ${err}`);
    }
  }
}
