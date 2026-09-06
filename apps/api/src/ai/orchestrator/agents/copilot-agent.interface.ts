import type { OrchestratorAgent } from './agent.interface.js';

// Placeholder interface only — see discovery-agent.interface.ts's comment.
// A future concrete implementation delegates to the existing
// copilotService (see apps/api/src/services/copilot/copilot.service.ts).
export interface CopilotAgent extends OrchestratorAgent<
  { assetId: string; message: string },
  { answer: string; citations?: unknown[] }
> {
  readonly id: 'copilot-agent';
}
