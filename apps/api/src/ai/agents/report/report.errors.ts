import { AIError } from '../../errors/index.js';

export class ReportAgentError extends AIError {
  constructor(message: string) {
    super(message);
    this.name = 'ReportAgentError';
  }
}

// Thrown when neither the input nor the OrchestrationContext supplies an
// assetId — a structural problem resolved before any tool call, never
// worth retrying. Registered in job-executor.ts's isPermanentFailure().
export class MissingReportTargetError extends ReportAgentError {
  constructor() {
    super('the Report Agent requires an assetId, either as input or from the workflow context');
    this.name = 'MissingReportTargetError';
  }
}
