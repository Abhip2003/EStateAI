// Standardized shape every dispatcher handler must return — mirrors
// SyncResult/DiscoveryResult's success/warnings/errors contract, so
// JobExecutor can interpret any job type's outcome uniformly.
export interface JobExecutionResult {
  success: boolean;
  output?: Record<string, unknown>;
  warnings?: string[];
  error?: string;
}
