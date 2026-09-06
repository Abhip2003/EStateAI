import type { ExecutionResult } from '../orchestrator/execution.result.js';
import type { ReasoningPlan } from '../planner/plan.types.js';
import type { CriticReport } from '../critic/critic.types.js';
import type { ReflectionReport } from '../reflection/reflection.types.js';
import type { DebateRecord } from '../debate/debate.types.js';
import type { ConsensusReport } from '../debate/consensus.types.js';

export type EpisodeOutcome = 'COMPLETED' | 'PARTIAL' | 'FAILED';

export interface EpisodeToolUsage {
  toolName: string;
  agentId?: string;
  success: boolean;
  durationMs?: number;
}

export interface EpisodeApprovalEvent {
  stepId: string;
  agentId: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  decision: string;
}

export interface EpisodeLessons {
  whatWorked: string[];
  whatFailed: string[];
  lessonsLearned: string[];
  futureSuggestions: string[];
}

// The persisted record of one completed execution (spec #2) — the unit
// this whole module reads/writes/retrieves. `assetId` is optional because
// not every execution (e.g. a debate run whose asset lookup failed) is
// guaranteed to resolve one; episodes without an assetId are still stored
// and retrievable by id/executionId, just not indexed into KnowledgeStore
// (which requires an assetId) or returned by asset-scoped history/search.
export interface Episode {
  episodeId: string;
  executionId: string;
  assetId?: string;
  goal: string;
  workflowId: string;
  planId?: string;
  agentsInvolved: string[];
  toolUsage: EpisodeToolUsage[];
  debateId?: string;
  consensusId?: string;
  disagreements: string[];
  durationMs: number;
  failedSteps: string[];
  retryCount: number;
  approvalEvents: EpisodeApprovalEvent[];
  outcome: EpisodeOutcome;
  confidence: number;
  lessons: EpisodeLessons;
  createdAt: string;
}

// Input to EpisodeExtractor.capture() — every completed-execution call
// site (reasoning-orchestrator, LangGraph's reflectionNode, DebateEngine,
// the plain orchestrator Executor) already has an ExecutionResult; the
// rest (plan/criticReport/reflection/debate/consensus) is whatever that
// call site additionally has on hand, all optional so a capture is never
// blocked on a field a particular execution path doesn't produce.
export interface EpisodeCaptureInput {
  executionId: string;
  goal: string;
  assetId?: string;
  plan?: ReasoningPlan;
  result: ExecutionResult;
  criticReport?: CriticReport;
  reflection?: ReflectionReport;
  debate?: DebateRecord;
  consensus?: ConsensusReport;
  approvalEvents?: EpisodeApprovalEvent[];
  toolUsage?: EpisodeToolUsage[];
}

export interface EpisodeSearchInput {
  goal: string;
  assetId?: string;
  topK?: number;
}

export interface EpisodeSearchMatch {
  episode: Episode;
  score: number;
}

// Aggregated, per-agent/per-tool track record derived from stored
// episodes (spec #5, #7) — never persisted itself, always recomputed on
// demand from whatever history is currently retained.
export interface AgentReliability {
  agentId: string;
  totalRuns: number;
  successRuns: number;
  successRate: number;
  averageConfidence: number;
}

export interface ToolReliability {
  toolName: string;
  totalRuns: number;
  successRuns: number;
  successRate: number;
  averageLatencyMs: number;
}

export interface ConfidenceCalibrationInput {
  baseConfidence: number;
  historicalSuccessRate?: number;
  similarityScore?: number;
  agentReliability?: number;
  toolReliability?: number;
}
