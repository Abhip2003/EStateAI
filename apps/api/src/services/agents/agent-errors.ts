export class AgentNotFoundError extends Error {
  constructor(agentId: string) {
    super(`Agent not found: ${agentId}`);
    this.name = 'AgentNotFoundError';
  }
}

export class UnsupportedRequestTypeError extends Error {
  constructor(requestType: string) {
    super(`No registered agent supports request type: ${requestType}`);
    this.name = 'UnsupportedRequestTypeError';
  }
}

export class PlanExecutionNotFoundError extends Error {
  constructor(id: string) {
    super(`Plan execution not found: ${id}`);
    this.name = 'PlanExecutionNotFoundError';
  }
}
