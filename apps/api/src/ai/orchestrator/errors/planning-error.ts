import { OrchestratorError } from './orchestrator-error.js';

export class PlanningError extends OrchestratorError {
  readonly intent?: string;

  constructor(message: string, intent?: string) {
    super(message);
    this.name = 'PlanningError';
    this.intent = intent;
  }
}
