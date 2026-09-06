import type { OrchestratorAgent } from './agent.interface.js';

// Placeholder interface only — see discovery-agent.interface.ts's comment.
// A future concrete implementation delegates to the existing
// complianceService (see apps/api/src/services/policy/compliance.service.ts).
export interface ComplianceAgent extends OrchestratorAgent<
  { assetId: string },
  { complianceScore: number; policyFailures: unknown[] }
> {
  readonly id: 'compliance-agent';
}
