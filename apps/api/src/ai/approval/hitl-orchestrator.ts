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
import type { AgentTaskResult } from '../orchestrator/execution.result.js';
import type { WorkflowStatus } from '../orchestrator/types.js';
import { goalPlanner } from '../planner/goal-planner.js';
import type { ReasoningPlan } from '../planner/plan.types.js';
import type { PlanStore } from '../planner/plan-store.js';
import { approvalPolicy } from './approval-policy.js';
import type { ApprovalEngine } from './approval-engine.js';
import type { ApprovalRequest } from './approval.types.js';
import { PausedExecutionStore } from './paused-execution.store.js';
import { ApprovalError } from './approval-error.js';

// Distinct from ai/orchestrator/types.ts's plain WorkflowStatus — the
// three new values a Human-in-the-Loop run can reach that a plain
// WorkflowEngine.run() never returns on its own. WorkflowEngine itself
// is untouched; these are HitlOrchestrator's own vocabulary for what its
// callers observe.
export type HitlRunStatus = WorkflowStatus | 'WAITING_FOR_APPROVAL' | 'RESUMED' | 'REJECTED';

export interface HitlExecutionResult {
  executionId: string;
  workflowId: string;
  planId: string;
  status: HitlRunStatus;
  steps: AgentTaskResult[];
  data: Record<string, unknown>;
  pendingApprovalIds: string[];
  startedAt: string;
  finishedAt: string;
  durationMs: number;
}

export interface HitlRunInput {
  goal: string;
  user: OrchestrationUser;
  organization?: OrchestrationOrganization;
  connectedAccounts?: ConnectedAccountRef[];
  assets?: AssetRef[];
  conversationId?: string;
  metadata?: Record<string, unknown>;
}

function generateExecutionId(): string {
  return `hexec-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

// Mirrors ai/planner/reasoning-orchestrator.ts's own duplicate of this —
// not exported from executor.ts, so every composition-root-style
// orchestrator that needs it keeps its own copy rather than reaching
// into another orchestrator's internals.
function readConfidence(output: unknown): number | undefined {
  if (output && typeof output === 'object' && 'confidenceScore' in output) {
    const value = (output as Record<string, unknown>).confidenceScore;
    return typeof value === 'number' ? value : undefined;
  }
  return undefined;
}

type Gate = 'RUN' | 'HOLD' | 'BLOCKED';

// One round's per-step gate state, derived fresh from the current
// ApprovalRequest status every time a round runs (initial run or a
// resume) — never cached, so a decision made between rounds is always
// picked up.
function gateFor(request: ApprovalRequest | undefined): Gate {
  if (!request) return 'RUN'; // NEVER-policy step: no request was ever created
  if (request.status === 'APPROVED') return 'RUN';
  if (request.status === 'REJECTED') return 'BLOCKED';
  return 'HOLD';
}

// Builds the WorkflowDefinition one round actually executes against:
// every step already resolved (terminal, from a prior round) is
// permanently skipped; every step currently gated HOLD/BLOCKED is
// skipped this round; a step whose dependency isn't yet a recorded
// success (either from this round's own context.agentOutputs or a
// prior round's terminal set) is skipped, same dependency-success rule
// ai/planner/reasoning-orchestrator.ts's buildAdaptiveDefinition()
// established for Plan Revision. WorkflowEngine itself is not modified —
// this reuses its existing per-step `condition` mechanism to a new end.
function buildGatedDefinition(
  base: WorkflowDefinition,
  terminalStepIds: Set<string>,
  gates: Map<string, Gate>,
): WorkflowDefinition {
  const steps: WorkflowStepDefinition[] = base.steps.map((step) => {
    const baseCondition = step.condition;
    return {
      ...step,
      condition: (context: OrchestrationContext) => {
        if (terminalStepIds.has(step.stepId)) return false;
        if ((gates.get(step.stepId) ?? 'RUN') !== 'RUN') return false;
        if (baseCondition && !baseCondition(context)) return false;
        // A dependency only unblocks a dependent step if it actually
        // *succeeded* — recorded in context.agentOutputs whether that
        // happened this round or a prior one (recordAgentOutput is
        // called for every step, terminal or not). A prior round's
        // FAILED/REJECTED/blocked dependency still blocks, same as a
        // live FAILED status would.
        return (step.dependsOn ?? []).every((dep) =>
          context.agentOutputs.some((o) => o.stepId === dep && o.status === 'SUCCESS'),
        );
      },
    };
  });
  return { ...base, steps };
}

// Coordinates the Human-in-the-Loop flow this phase adds: plan
// (GoalPlanner, unchanged) -> request approval for every step whose
// ApprovalPolicy decision isn't NEVER -> run only the steps currently
// clear to run (an adaptive, gated WorkflowDefinition, same condition
// trick Phase 25's Plan Revision uses) -> if anything is still HOLD,
// stop and report WAITING_FOR_APPROVAL, persisting enough state to
// resume later -> once a reviewer decides, resume() runs only the
// steps that are now clear, merging their outcomes into the same
// accumulated step list rather than re-invoking any agent whose step
// already succeeded. WorkflowEngine/OrchestratorService are never
// modified or replaced.
export class HitlOrchestrator {
  constructor(
    private readonly planStore: PlanStore,
    private readonly approvalEngine: ApprovalEngine,
    private readonly pausedExecutionStore: PausedExecutionStore,
  ) {}

  async run(input: HitlRunInput): Promise<HitlExecutionResult> {
    const plan = goalPlanner.createPlan(input.goal, input.metadata);
    const executionId = generateExecutionId();
    const startedAt = new Date().toISOString();

    const approvalIdByStep = new Map<string, string>();
    let approvalRequired = false;
    for (const step of plan.steps) {
      const decision = approvalPolicy.decideForAgent(step.agentId);
      if (decision === 'NEVER') continue;
      if (decision === 'MANUAL') approvalRequired = true;
      const request = await this.approvalEngine.requestApproval({
        executionId,
        planId: plan.planId,
        workflowId: plan.workflowId,
        stepId: step.stepId,
        agentId: step.agentId,
        decision,
        reason: `${step.agentId} step requires approval per policy (${decision})`,
      });
      approvalIdByStep.set(step.stepId, request.id);
    }
    // Set by this HITL layer, never by GoalPlanner itself (see
    // plan.types.ts's field comment) — a still-outstanding MANUAL
    // request is what "requires approval" means in practice; an AUTO
    // request is already resolved the instant it was created.
    plan.approvalRequired = approvalRequired;
    await this.planStore.save(plan);

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

    const baseDefinition = workflowRegistry.get(plan.workflowId);
    const round = await this.executeRound(baseDefinition, context, new Set(), approvalIdByStep);

    const finishedAt = new Date().toISOString();
    const result = this.toResult(
      executionId,
      plan,
      round.steps,
      round.pendingApprovalIds,
      round.rejectedStepIds,
      startedAt,
      finishedAt,
    );

    await this.pausedExecutionStore.save({
      executionId,
      plan,
      context,
      steps: round.steps,
      startedAt,
      approvalIdByStep: Object.fromEntries(approvalIdByStep),
    });

    return result;
  }

  // Called after a reviewer decides on one (or more) of an execution's
  // pending approvals — re-derives every step's current gate from the
  // (possibly just-updated) ApprovalRequest records and runs whatever is
  // now clear to run. Steps that already succeeded in an earlier round
  // are never re-attempted (their agent's execute() is not called
  // again) — only the newly-unblocked steps and their dependents run.
  async resume(executionId: string): Promise<HitlExecutionResult> {
    const paused = await this.pausedExecutionStore.get(executionId);
    if (!paused) {
      throw new ApprovalError(`no paused execution "${executionId}" to resume`, executionId);
    }

    const terminalStepIds = new Set(
      paused.steps.filter((step) => step.status !== 'SKIPPED').map((step) => step.stepId),
    );
    const approvalIdByStep = new Map(Object.entries(paused.approvalIdByStep));

    const baseDefinition = workflowRegistry.get(paused.plan.workflowId);
    const round = await this.executeRound(
      baseDefinition,
      paused.context,
      terminalStepIds,
      approvalIdByStep,
    );

    const mergedSteps = [
      ...paused.steps.filter((step) => !round.steps.some((s) => s.stepId === step.stepId)),
      ...round.steps,
    ];

    const finishedAt = new Date().toISOString();
    const result = this.toResult(
      executionId,
      paused.plan,
      mergedSteps,
      round.pendingApprovalIds,
      round.rejectedStepIds,
      paused.startedAt,
      finishedAt,
      /* isResume */ true,
    );

    await this.pausedExecutionStore.save({ ...paused, steps: mergedSteps });
    return result;
  }

  // Cancels an in-flight (WAITING_FOR_APPROVAL) execution — every still-
  // PENDING request tied to it is rejected as a side effect (a cancelled
  // execution has nothing left to approve into), and the paused state is
  // dropped so a later resume() call correctly reports "not found"
  // rather than silently reviving a cancelled run.
  async cancel(executionId: string): Promise<HitlExecutionResult> {
    const paused = await this.pausedExecutionStore.get(executionId);
    if (!paused) {
      throw new ApprovalError(`no paused execution "${executionId}" to cancel`, executionId);
    }
    for (const requestId of Object.values(paused.approvalIdByStep)) {
      const request = await this.approvalEngine.get(requestId);
      if (request && request.status === 'PENDING') {
        await this.approvalEngine.decide(request.id, 'REJECTED', {
          reviewerId: 'system',
          reason: 'execution cancelled',
        });
      }
    }
    await this.pausedExecutionStore.delete(executionId);

    const finishedAt = new Date().toISOString();
    const result = this.toResult(
      executionId,
      paused.plan,
      paused.steps,
      [],
      [],
      paused.startedAt,
      finishedAt,
    );
    return { ...result, status: 'CANCELLED' };
  }

  // Runs exactly one wave-respecting pass of the (possibly gated)
  // workflow: for every APPROVED step carrying a reviewer-supplied
  // editedOutput, injects that output directly (the agent is never
  // invoked for it — spec #5's "Edit recommendation"); everything else
  // goes through workflowEngine.run() against a definition built from
  // the current per-step gate.
  private async executeRound(
    baseDefinition: WorkflowDefinition,
    context: OrchestrationContext,
    terminalStepIds: Set<string>,
    approvalIdByStep: Map<string, string>,
  ): Promise<{
    steps: AgentTaskResult[];
    pendingApprovalIds: string[];
    rejectedStepIds: string[];
  }> {
    const gates = new Map<string, Gate>();
    const pendingApprovalIds: string[] = [];
    const rejectedStepIds: string[] = [];
    const injected: AgentTaskResult[] = [];
    const injectedTerminal = new Set<string>(terminalStepIds);

    for (const step of baseDefinition.steps) {
      if (terminalStepIds.has(step.stepId)) continue;
      const requestId = approvalIdByStep.get(step.stepId);
      const request = requestId ? await this.approvalEngine.get(requestId) : undefined;
      const gate = gateFor(request);
      gates.set(step.stepId, gate);

      if (gate === 'HOLD' && requestId) pendingApprovalIds.push(requestId);
      // Recorded here, from the *true* gate — not re-derived from
      // `gates` afterward, since an APPROVED step carrying an
      // editedOutput gets its gate overwritten to BLOCKED below purely
      // to stop the engine from also running it, which must not be
      // confused with an actual reviewer rejection.
      if (gate === 'BLOCKED') rejectedStepIds.push(step.stepId);

      if (gate === 'RUN' && request?.editedOutput !== undefined) {
        // Reviewer-edited output — recorded as a real SUCCESS entry for
        // this step, but the agent itself never runs.
        const now = new Date().toISOString();
        const entry: AgentTaskResult = {
          stepId: step.stepId,
          agentId: step.agentId,
          status: 'SUCCESS',
          startedAt: now,
          finishedAt: now,
          durationMs: 0,
          attempts: 0,
          output: request.editedOutput,
        };
        recordAgentOutput(context, {
          stepId: step.stepId,
          agentId: step.agentId,
          status: 'SUCCESS',
          output: request.editedOutput,
          durationMs: 0,
        });
        injected.push(entry);
        injectedTerminal.add(step.stepId);
        gates.set(step.stepId, 'BLOCKED'); // already resolved; keep the engine from also running it
      }
    }

    const definition = buildGatedDefinition(baseDefinition, injectedTerminal, gates);
    const runResult = await workflowEngine.run(definition, context, {
      onStepComplete: (stepResult) => {
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

    // A step this round left SKIPPED purely because it's gated
    // HOLD/BLOCKED, or because it was already terminal (its condition
    // was forced false just to keep it from re-running), isn't
    // meaningfully "attempted this round" — drop both from the round's
    // own step list so a terminal step's real prior outcome (preserved
    // in the caller's merge step) is never shadowed by a spurious fresh
    // SKIPPED entry, and so a still-gated step is never double-counted
    // against a step that genuinely never ran.
    const gatedStepIds = new Set(
      [...gates.entries()].filter(([, gate]) => gate !== 'RUN').map(([stepId]) => stepId),
    );
    const attempted = runResult.steps.filter(
      (step) => !gatedStepIds.has(step.stepId) && !injectedTerminal.has(step.stepId),
    );

    return { steps: [...injected, ...attempted], pendingApprovalIds, rejectedStepIds };
  }

  private toResult(
    executionId: string,
    plan: ReasoningPlan,
    steps: AgentTaskResult[],
    pendingApprovalIds: string[],
    rejectedStepIds: string[],
    startedAt: string,
    finishedAt: string,
    isResume = false,
  ): HitlExecutionResult {
    const data: Record<string, unknown> = {};
    for (const step of steps) {
      if (step.status === 'SUCCESS') data[step.agentId] = step.output;
    }

    const hasFailure = steps.some(
      (step) => step.status === 'FAILED' || step.status === 'TIMED_OUT',
    );
    const hasSuccess = steps.some((step) => step.status === 'SUCCESS');

    let status: HitlRunStatus;
    if (pendingApprovalIds.length > 0) {
      status = 'WAITING_FOR_APPROVAL';
    } else if (hasFailure) {
      status = hasSuccess ? 'PARTIAL' : 'FAILED';
    } else if (rejectedStepIds.length > 0) {
      status = 'REJECTED';
    } else {
      status = isResume ? 'RESUMED' : 'COMPLETED';
    }

    return {
      executionId,
      workflowId: plan.workflowId,
      planId: plan.planId,
      status,
      steps,
      data,
      pendingApprovalIds,
      startedAt,
      finishedAt,
      durationMs: Date.parse(finishedAt) - Date.parse(startedAt),
    };
  }
}
