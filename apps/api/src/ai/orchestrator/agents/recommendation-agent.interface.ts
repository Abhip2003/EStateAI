import type { OrchestratorAgent } from './agent.interface.js';

// Placeholder interface only — see discovery-agent.interface.ts's comment.
// A future concrete implementation delegates to the existing
// recommendationService (see apps/api/src/services/analysis/recommendation.service.ts).
export interface RecommendationAgent extends OrchestratorAgent<
  { assetId: string },
  { recommendations: unknown[] }
> {
  readonly id: 'recommendation-agent';
}
