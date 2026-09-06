import type { OrchestratorAgent } from './agents/agent.interface.js';
import { AgentNotRegisteredError } from './errors/index.js';

// Dynamic registry every future concrete agent (Discovery/Risk/Compliance/
// Recommendation/Report/Copilot) registers itself into. The orchestrator
// (workflow.engine.ts) never constructs an agent directly — it only ever
// resolves one by id through this registry, so adding a new agent never
// requires a change to the orchestrator itself.
//
// Named `OrchestratorAgentRegistry` (not `AgentRegistry`) and exported as
// `orchestratorAgentRegistry` (not `agentRegistry`) to avoid ambiguity with
// the pre-existing `agentRegistry` in services/agents/agent-registry.ts —
// a separate, already-shipped registry for a separate, synchronous agent
// system. See docs/ARCHITECTURE.md for why the two coexist.
export class OrchestratorAgentRegistry {
  private readonly agents = new Map<string, OrchestratorAgent>();

  register(agent: OrchestratorAgent): void {
    this.agents.set(agent.id, agent);
  }

  unregister(agentId: string): void {
    this.agents.delete(agentId);
  }

  get(agentId: string): OrchestratorAgent {
    const agent = this.agents.get(agentId);
    if (!agent) {
      throw new AgentNotRegisteredError(agentId);
    }
    return agent;
  }

  list(): OrchestratorAgent[] {
    return [...this.agents.values()];
  }

  isRegistered(agentId: string): boolean {
    return this.agents.has(agentId);
  }
}

// Empty on purpose — no concrete agent registers here in Phase 17. A
// future phase's agents/index.ts-style side-effect module calls
// `orchestratorAgentRegistry.register(...)` for each concrete agent it adds.
export const orchestratorAgentRegistry = new OrchestratorAgentRegistry();
