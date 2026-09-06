import type { OrchestratorAgent } from './agent.interface.js';

// Placeholder interface only — see discovery-agent.interface.ts's comment.
// A future concrete implementation delegates to the existing riskService
// (see apps/api/src/services/analysis/risk.service.ts).
export interface RiskAgent extends OrchestratorAgent<
  { assetId: string },
  { overallScore: number; findings: unknown[] }
> {
  readonly id: 'risk-agent';
}
