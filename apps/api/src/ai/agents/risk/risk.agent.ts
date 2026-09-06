import type { RiskAgent as RiskAgentContract } from '../../orchestrator/agents/risk-agent.interface.js';
import type { OrchestrationContext } from '../../orchestrator/execution.context.js';
import { buildRiskAIContext } from './risk.context.js';
import type { IRiskExecutor, RiskAgentOutput } from './risk.interface.js';

// Implements the Phase 17 placeholder `RiskAgent` interface for real.
// `RiskAgentOutput` is a strict superset of that interface's fixed
// `{overallScore, findings}` output, so this class satisfies the contract
// while returning everything the Phase 19 spec's "OUTPUT" section asks
// for. Registered under orchestratorAgentRegistry with id 'risk-agent'
// (see index.ts) — the pre-seeded workflows in
// ai/orchestrator/workflow.registry.ts (full-security-analysis, risk-only)
// become runnable one step further the moment this registration happens,
// with zero changes to that file.
//
// This agent never performs discovery, compliance evaluation,
// recommendations, or reporting, and it never calls another
// OrchestratorAgent directly — its only job is to run RiskExecutor over
// data another agent (Discovery) already produced, and return the result.
export class RiskAgentImpl implements RiskAgentContract {
  readonly id = 'risk-agent' as const;
  readonly description =
    'Analyzes discovered resources for security risk by calling the existing RiskService/FindingService through registered tools — explains, prioritizes, and summarizes findings, but never recalculates a risk score or a finding itself. Risk analysis only — no discovery, compliance, recommendation, or reporting logic.';

  constructor(private readonly executor: IRiskExecutor) {}

  canHandle(taskType: string): boolean {
    return /risk/i.test(taskType);
  }

  // The workflow engine may invoke this step with an empty `{}` input
  // (the pre-seeded workflows in workflow.registry.ts don't configure a
  // static `input` for the risk step) — falling back to the first asset
  // in the OrchestrationContext lets `risk-only`/`full-security-analysis`
  // run end-to-end without every caller needing to pass assetId
  // explicitly, while direct callers (routes/risk-agent.ts) still work by
  // passing it directly.
  async execute(
    input: { assetId?: string },
    context: OrchestrationContext,
  ): Promise<RiskAgentOutput> {
    const aiContext = buildRiskAIContext(context);
    const assetId = input.assetId ?? context.assets[0]?.id ?? '';
    return this.executor.run({ assetId }, aiContext, context);
  }
}
