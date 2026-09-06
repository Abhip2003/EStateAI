import { OrchestratorError } from './orchestrator-error.js';

export class WorkflowCancelledError extends OrchestratorError {
  readonly stepId?: string;

  constructor(stepId?: string) {
    super(stepId ? `step "${stepId}" was cancelled` : 'workflow execution was cancelled');
    this.name = 'WorkflowCancelledError';
    this.stepId = stepId;
  }
}
