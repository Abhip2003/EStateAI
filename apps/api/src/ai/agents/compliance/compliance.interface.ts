import type { AIContext } from '../../types/context.types.js';
import type { OrchestrationContext } from '../../orchestrator/execution.context.js';
import type {
  ComplianceFrameworkResult,
  ComplianceRunStatus,
  ComplianceSummaryRecord,
  ComplianceFailureRecord,
  ComplianceScoreSnapshot,
  PolicyOutcomeView,
} from './compliance.types.js';

export interface ComplianceExecutorInput {
  assetId: string;
}

// Full structured result the Compliance Agent returns — a strict superset
// of the Phase 17 placeholder `ComplianceAgent` interface's fixed
// `{complianceScore, policyFailures}` output, so `ComplianceAgentImpl`
// remains assignable to that contract while carrying everything the
// Phase 20 spec's "OUTPUT" section asks for (per-framework passed/
// failed/missing controls, evidence, reasoning, priority, confidence,
// summary).
export interface ComplianceAgentOutput {
  status: ComplianceRunStatus;
  assetId: string;
  complianceScore: number;
  passCount: number;
  failCount: number;
  warningCount: number;
  notApplicableCount: number;
  policyFailures: PolicyOutcomeView[];
  policyPasses: PolicyOutcomeView[];
  frameworks: ComplianceFrameworkResult[];
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

export interface IComplianceExecutor {
  run(
    input: ComplianceExecutorInput,
    aiContext: AIContext,
    orchestrationContext: OrchestrationContext,
  ): Promise<ComplianceAgentOutput>;
}

export interface IComplianceMemory {
  recordRun(record: ComplianceSummaryRecord): Promise<void>;
  getLastRun(assetId: string): Promise<ComplianceSummaryRecord | undefined>;
  getHistory(assetId: string, limit?: number): Promise<ComplianceSummaryRecord[]>;
  recordFailure(record: ComplianceFailureRecord): Promise<void>;
  getFailures(assetId: string, limit?: number): Promise<ComplianceFailureRecord[]>;
  recordScoreSnapshot(assetId: string, snapshot: ComplianceScoreSnapshot): Promise<void>;
  getScoreHistory(assetId: string, limit?: number): Promise<ComplianceScoreSnapshot[]>;
  rememberSeenViolations(assetId: string, policyCodes: string[]): Promise<void>;
  getSeenViolations(assetId: string): Promise<string[]>;
}
