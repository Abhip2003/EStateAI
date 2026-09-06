import { OrchestratorError } from './orchestrator-error.js';

export class WorkflowError extends OrchestratorError {
  readonly workflowId?: string;

  constructor(message: string, workflowId?: string) {
    super(message);
    this.name = 'WorkflowError';
    this.workflowId = workflowId;
  }
}
