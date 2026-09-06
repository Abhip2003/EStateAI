import { AIError } from '../../errors/index.js';

// Base of the Risk Agent's own error hierarchy — extends the Phase 16
// AIError base, same flat `extends Error` + `this.name` convention used
// throughout this codebase.
export class RiskAgentError extends AIError {
  constructor(message: string) {
    super(message);
    this.name = 'RiskAgentError';
  }
}

// Thrown when neither the input nor the OrchestrationContext supplies an
// assetId to analyze — a structural problem resolved before any tool
// call, never worth retrying. Registered in job-executor.ts's
// isPermanentFailure() alongside UnsupportedAgentProviderError so the
// enclosing AI_RISK job fails immediately instead of retrying.
export class MissingRiskTargetError extends RiskAgentError {
  constructor() {
    super('the Risk Agent requires an assetId, either as input or from the workflow context');
    this.name = 'MissingRiskTargetError';
  }
}
