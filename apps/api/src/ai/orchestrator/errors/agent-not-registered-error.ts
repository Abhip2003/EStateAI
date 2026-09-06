import { OrchestratorError } from './orchestrator-error.js';

export class AgentNotRegisteredError extends OrchestratorError {
  readonly agentId: string;

  constructor(agentId: string) {
    super(`no agent registered with id "${agentId}"`);
    this.name = 'AgentNotRegisteredError';
    this.agentId = agentId;
  }
}
