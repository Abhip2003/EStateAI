import type { DiscoveryAgent as DiscoveryAgentContract } from '../../orchestrator/agents/discovery-agent.interface.js';
import type { OrchestrationContext } from '../../orchestrator/execution.context.js';
import { buildDiscoveryAIContext } from './discovery.context.js';
import type { IDiscoveryExecutor, DiscoveryAgentOutput } from './discovery.interface.js';

// Implements the Phase 17 placeholder `DiscoveryAgent` interface for
// real. `DiscoveryAgentOutput` is a strict superset of that interface's
// fixed `{resourceCount, resources}` output, so this class satisfies the
// contract while returning everything the Phase 18 spec's "OUTPUT"
// section asks for. Registered under orchestratorAgentRegistry with id
// 'discovery-agent' (see index.ts) — the three workflows already seeded
// in ai/orchestrator/workflow.registry.ts (full-security-analysis,
// risk-only, compliance-only) become runnable for their first step the
// moment this registration happens, with zero changes to that file.
//
// This agent never performs risk analysis, compliance evaluation,
// recommendations, or reporting, and it never calls another
// OrchestratorAgent directly — its only job is to run
// DiscoveryExecutor and return the result.
export class DiscoveryAgentImpl implements DiscoveryAgentContract {
  readonly id = 'discovery-agent' as const;
  readonly description =
    'Discovers digital assets from connected external accounts (GitHub in this phase) by calling the existing DiscoveryService through registered tools. Discovery only — no risk, compliance, recommendation, or reporting logic.';

  constructor(private readonly executor: IDiscoveryExecutor) {}

  canHandle(taskType: string): boolean {
    return /discover/i.test(taskType);
  }

  // Phase 20 — the pre-seeded workflows (full-security-analysis, risk-only,
  // compliance-only) don't configure a static `input` for the discovery
  // step, so the workflow engine invokes this with `{}`. Falling back to
  // the first connected account in the OrchestrationContext mirrors the
  // context.assets[0]?.id fallback Risk/Compliance/Recommendation/Report
  // Agents already use for assetId — without it, discovery could never be
  // the first step of a workflow driven through POST
  // /ai/orchestrator/execute, since that endpoint has no way to configure
  // a per-step input either.
  async execute(
    input: { accountId?: string },
    context: OrchestrationContext,
  ): Promise<DiscoveryAgentOutput> {
    const aiContext = buildDiscoveryAIContext(context);
    const accountId = input.accountId ?? context.connectedAccounts[0]?.id ?? '';
    return this.executor.run({ accountId }, aiContext, context);
  }
}
