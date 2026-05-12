// Mirrors Rust `examples/accounts/src/types.rs`. Field names match the
// Rust struct so log output is comparable side-by-side.

export interface AccountConfig {
  key: string;
  username: string;
  password: string;
  user_id: string;
  token: string;
  device_id: string;
}

export interface PhaseMetrics {
  rpc_calls: number;
  rpc_successes: number;
  messages_sent: number;
  errors: string[];
}

export function emptyMetrics(): PhaseMetrics {
  return { rpc_calls: 0, rpc_successes: 0, messages_sent: 0, errors: [] };
}

export interface PhaseResult {
  phase_name: string;
  success: boolean;
  duration_ms: number;
  details: string;
  metrics: PhaseMetrics;
}

export interface TestSummary {
  total: number;
  passed: number;
  failed: number;
  duration_ms: number;
  results: PhaseResult[];
}
