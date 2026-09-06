// Shared, plain data types for the Report Agent — the terminal step of
// the collaboration DAG (Discovery -> Risk/Compliance -> Recommendation
// -> Report). This agent never re-evaluates anything; it only aggregates
// what the four upstream agents already produced.

export type ReportRunStatus = 'SUCCESS' | 'PARTIAL' | 'FAILED';

export type ReportSourceAgentId =
  'discovery-agent' | 'risk-agent' | 'compliance-agent' | 'recommendation-agent';

export type ReportSectionStatus = 'INCLUDED' | 'MISSING' | 'FAILED';

// One upstream agent's contribution to the final report.
// `origin` records whether the content came from this workflow's own
// live handoff (OrchestrationContext.agentOutputs), a memory fallback
// (that agent's own last recorded run, for a standalone report call), or
// wasn't available at all — the same provenance concept
// RecommendationAgent introduced for its own handoff sources (Phase 20
// goal #8 — Failure Isolation: a MISSING/FAILED section degrades the
// report, it never fails the whole run).
export interface ReportSection {
  id: ReportSourceAgentId;
  title: string;
  status: ReportSectionStatus;
  origin: 'context' | 'memory' | 'unavailable';
  content: string;
  confidence?: number;
}

export interface ReportTopRecommendation {
  title: string;
  priority: string;
}

export interface ReportExecutiveSummary {
  overallRiskScore: number | null;
  complianceScore: number | null;
  openFindingsCount: number | null;
  recommendationCount: number | null;
  topRecommendations: ReportTopRecommendation[];
}

export interface ReportSummaryRecord {
  assetId: string;
  status: ReportRunStatus;
  sectionCount: number;
  includedSectionCount: number;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  confidenceScore: number;
  warnings: string[];
  errors: string[];
}

export interface ReportFailureRecord {
  assetId: string;
  message: string;
  timestamp: string;
}
