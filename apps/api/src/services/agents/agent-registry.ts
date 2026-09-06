import type { Agent } from './agent.interface.js';
import { AgentNotFoundError } from './agent-errors.js';

// Registry pattern, matching ruleRegistry/policyRegistry/discoveryProviderRegistry
// etc. — the orchestrator/planner never branch on which agents exist,
// they only call resolve()/agentsFor() against whatever is registered.
class AgentRegistry {
  private readonly agents = new Map<string, Agent>();

  register(agent: Agent): void {
    this.agents.set(agent.id(), agent);
  }

  resolve(agentId: string): Agent {
    const agent = this.agents.get(agentId);
    if (!agent) {
      throw new AgentNotFoundError(agentId);
    }
    return agent;
  }

  agentsFor(requestType: string): Agent[] {
    return [...this.agents.values()].filter((agent) => agent.supports(requestType));
  }

  list(): Agent[] {
    return [...this.agents.values()];
  }
}

export const agentRegistry = new AgentRegistry();
