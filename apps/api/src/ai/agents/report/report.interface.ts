import type { AIContext } from '../../types/context.types.js';
import type { OrchestrationContext } from '../../orchestrator/execution.context.js';
import type {
  ReportSection,
  ReportExecutiveSummary,
  ReportRunStatus,
  ReportSummaryRecord,
  ReportFailureRecord,
} from './report.types.js';

export interface ReportExecutorInput {
  assetId: string;
}

// Superset of the Phase 17 placeholder `ReportAgent` interface's fixed
// `{summary: string; sections: unknown[]}` output.
export interface ReportAgentOutput {
  status: ReportRunStatus;
  assetId: string;
  summary: string;
  sections: ReportSection[];
  executive: ReportExecutiveSummary;
  metadata: {
    startedAt: string;
    finishedAt: string;
    durationMs: number;
  };
  confidenceScore: number;
  warnings: string[];
  errors: string[];
}

export interface IReportExecutor {
  run(
    input: ReportExecutorInput,
    aiContext: AIContext,
    orchestrationContext: OrchestrationContext,
  ): Promise<ReportAgentOutput>;
}

export interface IReportMemory {
  recordRun(record: ReportSummaryRecord): Promise<void>;
  getLastRun(assetId: string): Promise<ReportSummaryRecord | undefined>;
  getHistory(assetId: string, limit?: number): Promise<ReportSummaryRecord[]>;
  recordFailure(record: ReportFailureRecord): Promise<void>;
  getFailures(assetId: string, limit?: number): Promise<ReportFailureRecord[]>;
}
