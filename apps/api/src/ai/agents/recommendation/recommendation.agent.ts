import type { RecommendationAgent as RecommendationAgentContract } from '../../orchestrator/agents/recommendation-agent.interface.js';
import type { OrchestrationContext } from '../../orchestrator/execution.context.js';
import { buildRecommendationAIContext } from './recommendation.context.js';
import type {
  IRecommendationExecutor,
  RecommendationAgentOutput,
} from './recommendation.interface.js';

// Implements the Phase 17 placeholder `RecommendationAgent` interface.
// `RecommendationAgentOutput` is a strict superset of that interface's
// fixed `{recommendations: unknown[]}` output. Registered under
// orchestratorAgentRegistry with id 'recommendation-agent' (see index.ts)
// — the pre-seeded `full-security-analysis` workflow
// (ai/orchestrator/workflow.registry.ts) becomes runnable one step
// further the moment this registration happens, with zero changes to
// that file.
//
// This agent never performs discovery, risk scoring, or compliance
// evaluation, and it never calls another OrchestratorAgent directly — it
// only reads Risk/Compliance Agent output already recorded on
// OrchestrationContext (or, absent that, existing persisted data via its
// own tools) and merges it with the existing Recommendation store.
export class RecommendationAgentImpl implements RecommendationAgentContract {
  readonly id = 'recommendation-agent' as const;
  readonly description =
    'Aggregates Risk Agent findings and Compliance Agent policy failures (read from the shared OrchestrationContext handoff, or re-derived from the existing FindingService when run standalone) against the existing, persisted Recommendation store — cross-references, prioritizes, and confidence-scores recommendations, but never generates a new recommendation itself. Aggregation only — no discovery, risk scoring, compliance evaluation, or reporting logic.';

  constructor(private readonly executor: IRecommendationExecutor) {}

  canHandle(taskType: string): boolean {
    return /recommend/i.test(taskType);
  }

  // Same OrchestrationContext.assets[0]?.id fallback pattern
  // Risk/Compliance Agents established (Phases 19-20) — the pre-seeded
  // workflows don't configure a static `input` for this step.
  async execute(
    input: { assetId?: string },
    context: OrchestrationContext,
  ): Promise<RecommendationAgentOutput> {
    const aiContext = buildRecommendationAIContext(context);
    const assetId = input.assetId ?? context.assets[0]?.id ?? '';
    return this.executor.run({ assetId }, aiContext, context);
  }
}
