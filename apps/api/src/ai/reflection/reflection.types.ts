export interface ReflectionReport {
  executionId: string;
  planId: string;
  finalPlanId: string;
  succeededSteps: string[];
  failedSteps: string[];
  skippedSteps: string[];
  missingEvidence: string[];
  weakRecommendations: string[];
  incompleteReports: string[];
  criticScore: number;
  overallConfidence: number;
  // Explainability (Phase 25 spec #8) — a short, human-readable trail of
  // why the run ended up where it did (workflow chosen, steps that
  // failed/were skipped, whether the plan was revised).
  notes: string[];
  createdAt: string;
  // Phase 29 (Multi-Agent Debate & Consensus) additions — optional and
  // populated only by ai/debate/debate.engine.ts, never by
  // ReflectionEngine itself (mirrors Phase 26's own `approvalRequired?`
  // addition to ReasoningPlan, avoiding a reflection -> debate import
  // cycle: the shape lives here, ai/debate imports it, not the reverse).
  // Absent on any reflection produced by a run that never went through
  // the debate layer.
  debateSummary?: string;
  disagreements?: string[];
  consensusConfidence?: number;
}

// Optional input to ReflectionEngine.reflect() (Phase 29) — populates the
// three debate-related fields above. Declared here, not in
// ai/debate/debate.types.ts, so ai/reflection has zero dependency on
// ai/debate; ai/debate depends on ai/reflection instead, the same
// direction every later phase already depends on earlier foundational
// modules.
export interface DebateReflectionSummary {
  debateSummary: string;
  disagreements: string[];
  consensusConfidence: number;
}
