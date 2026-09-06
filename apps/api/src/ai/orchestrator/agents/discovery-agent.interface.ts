import type { OrchestratorAgent } from './agent.interface.js';

// Placeholder interface only — Phase 17 scope explicitly excludes
// implementing this agent. A future phase provides a concrete class that
// implements this interface and registers itself under
// orchestratorAgentRegistry with id 'discovery-agent', delegating to the
// existing discoveryService (see apps/api/src/services/discovery/) rather
// than duplicating its logic.
export interface DiscoveryAgent extends OrchestratorAgent<
  { accountId: string },
  { resourceCount: number; resources: unknown[] }
> {
  readonly id: 'discovery-agent';
}
