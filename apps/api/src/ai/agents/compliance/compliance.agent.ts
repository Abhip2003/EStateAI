import type { ComplianceAgent as ComplianceAgentContract } from '../../orchestrator/agents/compliance-agent.interface.js';
import type { OrchestrationContext } from '../../orchestrator/execution.context.js';
import { buildComplianceAIContext } from './compliance.context.js';
import type { IComplianceExecutor, ComplianceAgentOutput } from './compliance.interface.js';

// Implements the Phase 17 placeholder `ComplianceAgent` interface for
// real. `ComplianceAgentOutput` is a strict superset of that interface's
// fixed `{complianceScore, policyFailures}` output, so this class
// satisfies the contract while returning everything the Phase 20 spec's
// "OUTPUT" section asks for. Registered under orchestratorAgentRegistry
// with id 'compliance-agent' (see index.ts) — the pre-seeded workflows in
// ai/orchestrator/workflow.registry.ts (full-security-analysis,
// compliance-only) become runnable one step further the moment this
// registration happens, with zero changes to that file.
//
// This agent never performs discovery, risk scoring, recommendations, or
// reporting, and it never calls another OrchestratorAgent directly
// (specifically, no call to the Recommendation Agent) — its only job is
// to run ComplianceExecutor over data Discovery/Risk Agents already
// produced, and return the result.
export class ComplianceAgentImpl implements ComplianceAgentContract {
  readonly id = 'compliance-agent' as const;
  readonly description =
    'Evaluates discovered assets and security findings against compliance frameworks (NIST CSF, CIS Controls, ISO 27001, SOC2) by calling the existing ComplianceService/PolicyService through registered tools — maps findings to controls, performs gap analysis, and summarizes evidence, but never recalculates a compliance score itself. Compliance evaluation only — no discovery, risk scoring, recommendation, or reporting logic.';

  constructor(private readonly executor: IComplianceExecutor) {}

  canHandle(taskType: string): boolean {
    return /compliance/i.test(taskType);
  }

  // The workflow engine may invoke this step with an empty `{}` input
  // (the pre-seeded workflows in workflow.registry.ts don't configure a
  // static `input` for the compliance step) — falling back to the first
  // asset in the OrchestrationContext lets `compliance-only`/
  // `full-security-analysis` run end-to-end without every caller needing
  // to pass assetId explicitly, mirroring RiskAgentImpl's identical
  // fallback (Phase 19).
  async execute(
    input: { assetId?: string },
    context: OrchestrationContext,
  ): Promise<ComplianceAgentOutput> {
    const aiContext = buildComplianceAIContext(context);
    const assetId = input.assetId ?? context.assets[0]?.id ?? '';
    return this.executor.run({ assetId }, aiContext, context);
  }
}
