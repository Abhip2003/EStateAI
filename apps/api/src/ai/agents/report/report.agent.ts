import type { ReportAgent as ReportAgentContract } from '../../orchestrator/agents/report-agent.interface.js';
import type { OrchestrationContext } from '../../orchestrator/execution.context.js';
import { buildReportAIContext } from './report.context.js';
import type { IReportExecutor, ReportAgentOutput } from './report.interface.js';

// Implements the Phase 17 placeholder `ReportAgent` interface.
// `ReportAgentOutput` is a strict superset of that interface's fixed
// `{summary: string; sections: unknown[]}` output. Registered under
// orchestratorAgentRegistry with id 'report-agent' (see index.ts) — the
// pre-seeded `full-security-analysis` workflow
// (ai/orchestrator/workflow.registry.ts) becomes fully runnable
// end-to-end (Discovery -> Risk/Compliance -> Recommendation -> Report)
// the moment this registration happens, with zero changes to that file.
//
// This is the terminal step of the collaboration DAG — it never performs
// discovery, risk scoring, compliance evaluation, or recommendation
// generation, and it never calls another OrchestratorAgent directly. It
// only aggregates what the other four already produced.
export class ReportAgentImpl implements ReportAgentContract {
  readonly id = 'report-agent' as const;
  readonly description =
    "Aggregates Discovery/Risk/Compliance/Recommendation Agent output (read from the shared OrchestrationContext handoff, or each agent's own memory when run standalone) into one final report with an executive summary — never re-evaluates or re-scores anything itself. A missing or failed upstream agent degrades this report to PARTIAL rather than failing the run. Aggregation only.";

  constructor(private readonly executor: IReportExecutor) {}

  canHandle(taskType: string): boolean {
    return /report/i.test(taskType);
  }

  async execute(
    input: { assetId?: string },
    context: OrchestrationContext,
  ): Promise<ReportAgentOutput> {
    const aiContext = buildReportAIContext(context);
    const assetId = input.assetId ?? context.assets[0]?.id ?? '';
    return this.executor.run({ assetId }, aiContext, context);
  }
}
