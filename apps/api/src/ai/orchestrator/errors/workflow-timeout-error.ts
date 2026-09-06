import { OrchestratorError } from './orchestrator-error.js';

export class WorkflowTimeoutError extends OrchestratorError {
  readonly stepId: string;
  readonly timeoutMs: number;

  constructor(stepId: string, timeoutMs: number) {
    super(`step "${stepId}" timed out after ${timeoutMs}ms`);
    this.name = 'WorkflowTimeoutError';
    this.stepId = stepId;
    this.timeoutMs = timeoutMs;
  }
}
