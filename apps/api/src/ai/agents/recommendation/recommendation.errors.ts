import { AIError } from '../../errors/index.js';

export class RecommendationAgentError extends AIError {
  constructor(message: string) {
    super(message);
    this.name = 'RecommendationAgentError';
  }
}

// Thrown when neither the input nor the OrchestrationContext supplies an
// assetId — a structural problem resolved before any tool call, never
// worth retrying. Registered in job-executor.ts's isPermanentFailure()
// alongside MissingRiskTargetError/MissingComplianceTargetError.
export class MissingRecommendationTargetError extends RecommendationAgentError {
  constructor() {
    super(
      'the Recommendation Agent requires an assetId, either as input or from the workflow context',
    );
    this.name = 'MissingRecommendationTargetError';
  }
}
