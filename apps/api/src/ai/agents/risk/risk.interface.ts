import type { AIContext } from '../../types/context.types.js';
import type { OrchestrationContext } from '../../orchestrator/execution.context.js';
import type {
  RiskFindingView,
  RiskSeverityCounts,
  RiskSummaryRecord,
  RiskFailureRecord,
  RiskScoreSnapshot,
  RiskRunStatus,
  BusinessImpact,
} from './risk.types.js';

export interface RiskExecutorInput {
  assetId: string;
}

// Full structured result the Risk Agent returns — a strict superset of
// the Phase 17 placeholder `RiskAgent` interface's fixed
// `{overallScore, findings}` output, so `RiskAgentImpl` remains assignable
// to that contract while carrying everything the Phase 19 spec's "OUTPUT"
// section asks for (critical/high/medium/low findings, business impact,
// reasoning, evidence, confidence score, summary).
export interface RiskAgentOutput {
  status: RiskRunStatus;
  assetId: string;
  overallScore: number;
  businessImpact: BusinessImpact;
  counts: RiskSeverityCounts;
  findings: RiskFindingView[];
  criticalFindings: RiskFindingView[];
  highFindings: RiskFindingView[];
  mediumFindings: RiskFindingView[];
  lowFindings: RiskFindingView[];
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

export interface IRiskExecutor {
  run(
    input: RiskExecutorInput,
    aiContext: AIContext,
    orchestrationContext: OrchestrationContext,
  ): Promise<RiskAgentOutput>;
}

export interface IRiskMemory {
  recordRun(record: RiskSummaryRecord): Promise<void>;
  getLastRun(assetId: string): Promise<RiskSummaryRecord | undefined>;
  getHistory(assetId: string, limit?: number): Promise<RiskSummaryRecord[]>;
  recordFailure(record: RiskFailureRecord): Promise<void>;
  getFailures(assetId: string, limit?: number): Promise<RiskFailureRecord[]>;
  recordScoreSnapshot(assetId: string, snapshot: RiskScoreSnapshot): Promise<void>;
  getScoreHistory(assetId: string, limit?: number): Promise<RiskScoreSnapshot[]>;
  rememberSeenRuleCodes(assetId: string, ruleCodes: string[]): Promise<void>;
  getSeenRuleCodes(assetId: string): Promise<string[]>;
  acknowledgeFinding(assetId: string, findingId: string): Promise<void>;
  getAcknowledgedFindingIds(assetId: string): Promise<string[]>;
}
