// Shared, plain data types for the Risk Agent — kept separate from
// risk.schemas.ts (the zod schemas that validate these shapes at
// tool/agent boundaries) and risk.interface.ts (the class-level
// contracts), matching the file split the Phase 18 Discovery Agent
// established.

export type RiskRunStatus = 'SUCCESS' | 'PARTIAL' | 'FAILED';

export type RiskSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFORMATIONAL';

// Deterministic business-impact label derived from severity counts (see
// risk.scoring.ts) — never an LLM judgment call, since the spec requires
// existing backend logic (RiskScore's counts) to remain the source of
// truth for anything score-adjacent.
export type BusinessImpact = 'SEVERE' | 'HIGH' | 'MODERATE' | 'LOW' | 'MINIMAL';

// Agent-facing view of one existing Finding row, enriched with a
// human-readable explanation, evidence, and priority — built
// deterministically by risk.finding.ts from the finding's own ruleCode
// and metadata, then optionally rephrased in prose by the LLM (see
// risk.summary.ts). The severity/confidence values themselves are always
// copied verbatim from the persisted Finding — never recalculated here.
export interface RiskFindingView {
  id: string;
  resourceId: string;
  provider: string;
  ruleCode: string;
  severity: RiskSeverity;
  status: 'OPEN' | 'RESOLVED';
  title: string;
  reasoning: string;
  businessImpact: BusinessImpact;
  evidence: string[];
  priority: BusinessImpact;
  confidence: number;
  repeated: boolean;
  createdAt: string;
}

export interface RiskSeverityCounts {
  critical: number;
  high: number;
  medium: number;
  low: number;
  informational: number;
}

// Persisted (via RiskMemory) summary of one agent run — deliberately
// smaller than the full RiskAgentOutput, since memory only needs to
// answer "what happened last time," not replay every finding.
export interface RiskSummaryRecord {
  assetId: string;
  status: RiskRunStatus;
  overallScore: number;
  counts: RiskSeverityCounts;
  findingCount: number;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  confidenceScore: number;
  warnings: string[];
  errors: string[];
}

export interface RiskFailureRecord {
  assetId: string;
  message: string;
  timestamp: string;
}

// One snapshot of overallScore captured on every run — used to answer
// "historical risk scores" (Memory requirement) without re-deriving it
// from RiskSummaryRecord history each time.
export interface RiskScoreSnapshot {
  overallScore: number;
  counts: RiskSeverityCounts;
  timestamp: string;
}
