import {
  planner as workflowPlanner,
  type ExecutionPlan as WorkflowPlan,
} from '../orchestrator/planner.js';
import type { ExecutionResult } from '../orchestrator/execution.result.js';
import { AGENT_TOOL_ACCESS } from '../tools/agent-tool-access.js';
import type { PlanComplexity, ReasoningPlan, ReasoningPlanStep } from './plan.types.js';

function generatePlanId(): string {
  return `rplan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// Documented heuristic, not a measured average — a placeholder an LLM-
// driven or telemetry-driven estimator can replace later without
// changing ReasoningPlan's shape (see docs/TODO.md).
const AVG_STEP_DURATION_MS = 4000;

// Analyzes a free-form goal, breaks it into executable steps, and
// estimates the tools/agents/complexity/duration/confidence needed to run
// it. Delegates workflow *selection* to the existing orchestrator Planner
// (ai/orchestrator/planner.ts) — this class does not reimplement
// intent-to-workflow matching, it decorates the result with the richer
// Phase 25 fields the orchestrator's own ExecutionPlan doesn't carry.
export class GoalPlanner {
  createPlan(goal: string, metadata?: Record<string, unknown>): ReasoningPlan {
    const workflowPlan = workflowPlanner.createPlan({ intent: goal, metadata });
    return this.toReasoningPlan(goal, workflowPlan);
  }

  // Plan Revision (Phase 25 spec #6): given a completed/partial
  // execution, drops every step that failed and every step doomed by a
  // failed dependency (directly or transitively), then recomputes the
  // plan's aggregate fields around the survivors. This does not trigger a
  // second execution — the same skip rule is applied live, during the
  // original run, by the `condition` functions ReasoningOrchestrator
  // attaches per step (see reasoning-orchestrator.ts); this method exists
  // to *explain* that outcome as a plan, for GET /ai/planner/:id and the
  // persisted reflection record.
  revisePlan(plan: ReasoningPlan, result: ExecutionResult): ReasoningPlan {
    const failedStepIds = new Set(
      result.steps
        .filter((step) => step.status === 'FAILED' || step.status === 'TIMED_OUT')
        .map((step) => step.stepId),
    );
    const byId = new Map(plan.steps.map((step) => [step.stepId, step]));
    const isDoomed = (stepId: string, seen: Set<string> = new Set()): boolean => {
      if (seen.has(stepId)) return false;
      seen.add(stepId);
      if (failedStepIds.has(stepId)) return true;
      const step = byId.get(stepId);
      return (step?.dependsOn ?? []).some((dep) => isDoomed(dep, seen));
    };
    const survivors = plan.steps.filter(
      (step) => !failedStepIds.has(step.stepId) && !isDoomed(step.stepId),
    );

    return {
      ...plan,
      planId: generatePlanId(),
      steps: survivors,
      requiredAgents: this.uniqueAgents(survivors),
      requiredTools: this.uniqueTools(survivors),
      estimatedComplexity: this.estimateComplexity(survivors.length),
      estimatedDurationMs: this.estimateDuration(survivors),
      // Not just estimateConfidence(survivors.length, true) — that
      // heuristic rewards *fewer* steps (less that can go wrong), which
      // is backwards here: a revision that keeps zero steps accomplishes
      // nothing and must score low, not high just for being small.
      confidence:
        survivors.length === 0
          ? 0.1
          : this.estimateConfidence(survivors.length, true) *
            (survivors.length / Math.max(plan.steps.length, 1)),
      createdAt: new Date().toISOString(),
      revisionOf: plan.planId,
      revisionReason:
        failedStepIds.size === 0
          ? 'no steps failed'
          : `steps [${[...failedStepIds].join(', ')}] failed; dependent steps skipped`,
    };
  }

  private toReasoningPlan(goal: string, workflowPlan: WorkflowPlan): ReasoningPlan {
    const steps: ReasoningPlanStep[] = workflowPlan.steps.map((step) => ({
      stepId: step.stepId,
      agentId: step.agentId,
      dependsOn: step.dependsOn,
      tools: AGENT_TOOL_ACCESS[step.agentId] ?? [],
    }));

    return {
      planId: generatePlanId(),
      goal,
      workflowId: workflowPlan.workflowId,
      steps,
      requiredAgents: this.uniqueAgents(steps),
      requiredTools: this.uniqueTools(steps),
      estimatedComplexity: this.estimateComplexity(steps.length),
      estimatedDurationMs: this.estimateDuration(steps),
      confidence: this.estimateConfidence(steps.length, false),
      createdAt: new Date().toISOString(),
    };
  }

  private uniqueAgents(steps: ReasoningPlanStep[]): string[] {
    return [...new Set(steps.map((step) => step.agentId))];
  }

  private uniqueTools(steps: ReasoningPlanStep[]): string[] {
    return [...new Set(steps.flatMap((step) => step.tools))];
  }

  private estimateComplexity(stepCount: number): PlanComplexity {
    if (stepCount <= 1) return 'LOW';
    if (stepCount <= 3) return 'MEDIUM';
    return 'HIGH';
  }

  // Steps run in dependency "waves" (WorkflowEngine.buildWaves), so
  // duration is estimated from the longest dependency chain, not
  // steps.length * average — parallel branches don't stack.
  private estimateDuration(steps: ReasoningPlanStep[]): number {
    if (steps.length === 0) return 0;
    const byId = new Map(steps.map((step) => [step.stepId, step]));
    const depthCache = new Map<string, number>();
    const depth = (stepId: string): number => {
      const cached = depthCache.get(stepId);
      if (cached !== undefined) return cached;
      const deps = byId.get(stepId)?.dependsOn ?? [];
      const value = deps.length === 0 ? 1 : 1 + Math.max(...deps.map((dep) => depth(dep)));
      depthCache.set(stepId, value);
      return value;
    };
    const maxDepth = Math.max(...steps.map((step) => depth(step.stepId)));
    return maxDepth * AVG_STEP_DURATION_MS;
  }

  // Heuristic, documented confidence estimate: starts high for small
  // plans, decays with plan size (more steps -> more that can go wrong),
  // and takes a further cut for a revised (already-partial) plan.
  private estimateConfidence(stepCount: number, isRevision: boolean): number {
    const base = 0.9 - Math.min(stepCount, 5) * 0.05;
    return Math.max(0.5, isRevision ? base - 0.15 : base);
  }
}

export const goalPlanner = new GoalPlanner();
