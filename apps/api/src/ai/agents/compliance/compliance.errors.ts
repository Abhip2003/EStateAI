import { AIError } from '../../errors/index.js';

// Base of the Compliance Agent's own error hierarchy — extends the Phase
// 16 AIError base, same flat `extends Error` + `this.name` convention
// used throughout this codebase.
export class ComplianceAgentError extends AIError {
  constructor(message: string) {
    super(message);
    this.name = 'ComplianceAgentError';
  }
}

// Thrown when neither the input nor the OrchestrationContext supplies an
// assetId to assess — a structural problem resolved before any tool
// call, never worth retrying. Registered in job-executor.ts's
// isPermanentFailure() alongside MissingRiskTargetError so the enclosing
// AI_COMPLIANCE job fails immediately instead of retrying.
export class MissingComplianceTargetError extends ComplianceAgentError {
  constructor() {
    super('the Compliance Agent requires an assetId, either as input or from the workflow context');
    this.name = 'MissingComplianceTargetError';
  }
}
