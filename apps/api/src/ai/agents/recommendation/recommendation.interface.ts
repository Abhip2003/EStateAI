import type { AIContext } from '../../types/context.types.js';
import type { OrchestrationContext } from '../../orchestrator/execution.context.js';
import type {
  RecommendationView,
  RecommendationRunStatus,
  RecommendationHandoffSource,
  RecommendationSummaryRecord,
  RecommendationFailureRecord,
} from './recommendation.types.js';

export interface RecommendationExecutorInput {
  assetId: string;
}

// Superset of the Phase 17 placeholder `RecommendationAgent` interface's
// fixed `{recommendations: unknown[]}` output — RecommendationAgentImpl
// remains assignable to that contract while carrying the aggregation,
// cross-reference, and handoff-provenance detail the Phase 20 spec asks
// for.
export interface RecommendationAgentOutput {
  status: RecommendationRunStatus;
  assetId: string;
  recommendations: RecommendationView[];
  // Same list, sorted by priority — separate field so callers that only
  // want "what to do first" don't have to re-sort recommendations.
  prioritized: RecommendationView[];
  handoffSources: RecommendationHandoffSource[];
  metadata: {
    startedAt: string;
    finishedAt: string;
    durationMs: number;
  };
  summary: string;
  confidenceScore: number;
  warnings: string[];
  errors: string[];
}

export interface IRecommendationExecutor {
  run(
    input: RecommendationExecutorInput,
    aiContext: AIContext,
    orchestrationContext: OrchestrationContext,
  ): Promise<RecommendationAgentOutput>;
}

export interface IRecommendationMemory {
  recordRun(record: RecommendationSummaryRecord): Promise<void>;
  getLastRun(assetId: string): Promise<RecommendationSummaryRecord | undefined>;
  getHistory(assetId: string, limit?: number): Promise<RecommendationSummaryRecord[]>;
  recordFailure(record: RecommendationFailureRecord): Promise<void>;
  getFailures(assetId: string, limit?: number): Promise<RecommendationFailureRecord[]>;
}
