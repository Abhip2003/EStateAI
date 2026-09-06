import {
  buildOrchestrationContext,
  recordAgentOutput,
  type OrchestrationContext,
  type OrchestrationUser,
  type OrchestrationOrganization,
  type ConnectedAccountRef,
  type AssetRef,
} from '../orchestrator/execution.context.js';
import {
  workflowEngine,
  type WorkflowDefinition,
  type WorkflowStepDefinition,
} from '../orchestrator/workflow.engine.js';
import { workflowRegistry } from '../orchestrator/workflow.registry.js';
import type { AgentTaskResult, ExecutionResult } from '../orchestrator/execution.result.js';
import { goalPlanner } from './goal-planner.js';
import type { ReasoningPlan } from './plan.types.js';
import type { PlanStore } from './plan-store.js';
import { critic } from '../critic/critic.js';
import type { CriticReport } from '../critic/critic.types.js';
import { reflectionEngine } from '../reflection/reflection.engine.js';
import type { ReflectionReport } from '../reflection/reflection.types.js';
import type { ReflectionStore } from '../reflection/reflection.store.js';
import { captureEpisodeSafely } from '../episodic-memory/index.js';

function generateExecutionId(): string {
  return `rexec-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

// Mirrors Executor's own readConfidence() (ai/orchestrator/executor.ts) —
// every concrete agent exposes an optional top-level `confidenceScore` on
// its output; duplicated here (rather than imported) since that helper
// isn't exported and this module must not reach into Executor's
// internals.
function readConfidence(output: unknown): number | undefined {
  if (output && typeof output === 'object' && 'confidenceScore' in output) {
    const value = (output as Record<string, unknown>).confidenceScore;
    return typeof value === 'number' ? value : undefined;
  }
  return undefined;
}

// Builds an "adaptive" WorkflowDefinition from the registered workflow
// GoalPlanner selected: every step with at least one dependency gets a
// `condition` that additionally requires all of its dependencies to have
// *succeeded* in context.agentOutputs so far (on top of any condition the
// base definition already declared). This is what makes Plan Revision
// (Phase 25 spec #6 — "Discovery failed -> skip Risk -> run Compliance ->
// generate partial report") happen live, inside one workflowEngine.run()
// call, using only WorkflowEngine's existing condition mechanism —
// WorkflowEngine itself is not modified.
function buildAdaptiveDefinition(base: WorkflowDefinition): WorkflowDefinition {
  const steps: WorkflowStepDefinition[] = base.steps.map((step) => {
    const dependsOn = step.dependsOn ?? [];
    if (dependsOn.length === 0) return step;
    const baseCondition = step.condition;
    return {
      ...step,
      condition: (context: OrchestrationContext) => {
        if (baseCondition && !baseCondition(context)) return false;
        return dependsOn.every(
          (dep) => context.agentOutputs.find((entry) => entry.stepId === dep)?.status === 'SUCCESS',
        );
      },
    };
  });
  return { ...base, steps };
}

export interface ReasoningRunInput {
  goal: string;
  user: OrchestrationUser;
  organization?: OrchestrationOrganization;
  connectedAccounts?: ConnectedAccountRef[];
  assets?: AssetRef[];
  conversationId?: string;
  metadata?: Record<string, unknown>;
}

export interface ReasoningRunOutput {
  plan: ReasoningPlan;
  finalPlan: ReasoningPlan;
  result: ExecutionResult;
  critic: CriticReport;
  reflection: ReflectionReport;
}

// Coordinates the reasoning-first flow this phase adds on top of the
// Phase 17 orchestrator: plan (GoalPlanner) -> execute (WorkflowEngine,
// wrapped in an adaptive definition) -> critique (Critic) -> revise
// (GoalPlanner.revisePlan, for explainability) -> reflect
// (ReflectionEngine) -> persist (PlanStore/ReflectionStore). Deliberately
// does not go through OrchestratorService/Executor — those remain the
// plain, non-adaptive entry point behind POST /ai/orchestrator/execute;
// this is a parallel, additive entry point behind POST /ai/planner/plan.
export class ReasoningOrchestrator {
  constructor(
    private readonly planStore: PlanStore,
    private readonly reflectionStore: ReflectionStore,
  ) {}

  async run(input: ReasoningRunInput): Promise<ReasoningRunOutput> {
    const plan = goalPlanner.createPlan(input.goal, input.metadata);
    await this.planStore.save(plan);

    const executionId = generateExecutionId();
    const context = buildOrchestrationContext({
      executionId,
      user: input.user,
      organization: input.organization,
      connectedAccounts: input.connectedAccounts,
      assets: input.assets,
      workflowId: plan.workflowId,
      conversationId: input.conversationId,
      metadata: input.metadata,
    });

    const adaptiveDefinition = buildAdaptiveDefinition(workflowRegistry.get(plan.workflowId));
    const startedAt = new Date().toISOString();
    const startedAtMs = Date.now();

    const runResult = await workflowEngine.run(adaptiveDefinition, context, {
      onStepComplete: (stepResult: AgentTaskResult) => {
        recordAgentOutput(context, {
          stepId: stepResult.stepId,
          agentId: stepResult.agentId,
          status:
            stepResult.status === 'SUCCESS'
              ? 'SUCCESS'
              : stepResult.status === 'SKIPPED'
                ? 'SKIPPED'
                : 'FAILED',
          output: stepResult.output,
          durationMs: stepResult.durationMs,
          confidence: readConfidence(stepResult.output),
        });
      },
    });

    const finishedAt = new Date().toISOString();
    const data: Record<string, unknown> = {};
    for (const step of runResult.steps) {
      if (step.status === 'SUCCESS') data[step.agentId] = step.output;
    }

    const result: ExecutionResult = {
      executionId,
      workflowId: plan.workflowId,
      status: runResult.status,
      startedAt,
      finishedAt,
      durationMs: Date.now() - startedAtMs,
      steps: runResult.steps,
      data,
      error: runResult.steps.find((step) => step.error)?.error,
    };

    const criticReport = critic.evaluateExecution(result, plan);
    const finalPlan =
      result.status === 'PARTIAL' || result.status === 'FAILED'
        ? goalPlanner.revisePlan(plan, result)
        : plan;
    if (finalPlan.planId !== plan.planId) {
      await this.planStore.save(finalPlan);
    }

    const reflection = reflectionEngine.reflect(result, plan, finalPlan, criticReport, context);
    await this.reflectionStore.save(reflection);

    captureEpisodeSafely({
      executionId,
      goal: input.goal,
      assetId: input.assets?.[0]?.id,
      plan: finalPlan,
      result,
      criticReport,
      reflection,
    });

    return { plan, finalPlan, result, critic: criticReport, reflection };
  }
}
