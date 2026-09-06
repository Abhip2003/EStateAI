import type { OrchestratorAgent } from './agent.interface.js';

// Placeholder interface only — see discovery-agent.interface.ts's comment.
// A future concrete implementation aggregates the other agents' outputs
// (read from OrchestrationContext.agentOutputs) into a report, optionally
// narrated via aiFoundation.llmClient — mirrors what the existing
// ReportAgent (services/agents/agents/report.agent.ts) does today with the
// legacy AI stack.
export interface ReportAgent extends OrchestratorAgent<
  { assetId: string },
  { summary: string; sections: unknown[] }
> {
  readonly id: 'report-agent';
}
