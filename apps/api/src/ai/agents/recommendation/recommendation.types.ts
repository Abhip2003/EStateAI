// Shared, plain data types for the Recommendation Agent — mirrors the
// compliance.types.ts / risk.types.ts file split (types here, zod schemas
// in recommendation.schemas.ts, class-level contracts in
// recommendation.interface.ts).

export type RecommendationRunStatus = 'SUCCESS' | 'PARTIAL' | 'FAILED';

export type RecommendationPriority = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFORMATIONAL';

// One agent-facing recommendation — always backed by an existing,
// persisted Recommendation row (services/analysis/recommendation.service.ts).
// This agent never invents a recommendation; it enriches the existing
// row with cross-agent references and an optional LLM narrative.
export interface RecommendationView {
  id: string;
  findingId: string;
  title: string;
  description: string;
  estimatedImpact: string;
  priority: RecommendationPriority;
  status: 'OPEN' | 'RESOLVED';
  // Cross-agent references (Phase 20 goal #6): which upstream agent(s)
  // and Finding(s) this recommendation was derived from/related to.
  sourceAgents: string[];
  sourceFindingIds: string[];
  relatedCompliancePolicyCodes: string[];
  confidence: number;
  reasoning: string;
  createdAt: string;
}

// Which upstream agents' outputs were actually available at handoff time
// (from OrchestrationContext.agentOutputs, 'context') vs. had to be
// re-derived by calling the underlying store directly, e.g. FindingService
// ('fallback' — used when Risk Agent didn't run in this workflow, or ran
// but failed) vs. were simply unavailable with no safe fallback
// ('unavailable' — Compliance's policy failures have no equivalent
// standalone re-derivation path here, so a missing/failed compliance step
// just means no compliance cross-references this run, not a failure).
export interface RecommendationHandoffSource {
  agentId: 'risk-agent' | 'compliance-agent';
  used: boolean;
  origin: 'context' | 'fallback' | 'unavailable';
}

export interface RecommendationSummaryRecord {
  assetId: string;
  status: RecommendationRunStatus;
  recommendationCount: number;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  confidenceScore: number;
  warnings: string[];
  errors: string[];
}

export interface RecommendationFailureRecord {
  assetId: string;
  message: string;
  timestamp: string;
}
