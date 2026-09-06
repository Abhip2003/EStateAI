import { OrchestratorError } from './orchestrator-error.js';

export class TaskExecutionError extends OrchestratorError {
  readonly stepId: string;

  constructor(stepId: string, message: string) {
    super(`[${stepId}] ${message}`);
    this.name = 'TaskExecutionError';
    this.stepId = stepId;
  }
}
