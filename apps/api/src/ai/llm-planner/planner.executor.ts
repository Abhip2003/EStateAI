import { redis } from '../../cache/redis.js';
import { RedisMemoryStore } from '../memory/redis-memory-store.js';
import { AIError } from '../errors/index.js';
import {
  buildDynamicGraph,
  GraphCheckpointStore,
  emptyApprovalState,
  loadMemory,
  persistMemory,
  type GraphState,
  type GraphRunStatus,
  type GraphCheckpointSnapshot,
} from '../langgraph/index.js';
import { llmPlanner } from './planner.js';
import type {
  LLMPlan,
  LLMPlanRecord,
  LLMPlanStep,
  PlannerAgentId,
  PlannerRunInput,
} from './planner.types.js';
import type { GraphStepLike } from '../langgraph/graph-builder.js';

const DEFAULT_CONFIDENCE_THRESHOLD = 0.6;
const DEFAULT_MAX_ITERATIONS = 3;

export class PlannerGraphInputError extends AIError {
  constructor(message: string) {
    super(message);
    this.name = 'PlannerGraphInputError';
  }
}

function generateExecutionId(): string {
  return `lgpexec-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export interface LLMPlannerRunResult {
  planId: string;
  planRecords: LLMPlanRecord[];
  executionId: string;
  graphId: string;
  status: GraphRunStatus;
  state: GraphState;
  iterations: number;
}

interface SingleRunResult {
  executionId: string;
  graphId: string;
  status: GraphRunStatus;
  state: GraphState;
}

// Same extraction ai/langgraph/executor.ts's own extractPendingApprovals
// performs — every agent this phase's planner can place into a plan
// defaults to ApprovalPolicy's NEVER/AUTO decisions (see
// ai/approval/approval-policy.ts), so a dynamically generated plan never
// actually pauses today; this still checks for it (rather than assuming
// it can't happen) so a future MANUAL-gated agent is reported as
// WAITING_FOR_APPROVAL instead of silently miscomputed as COMPLETED.
function extractPendingApprovals(snapshot: {
  tasks: Array<{ interrupts?: Array<{ value?: unknown }> }>;
}): GraphCheckpointSnapshot['pendingApprovals'] {
  return snapshot.tasks
    .flatMap((task) => task.interrupts ?? [])
    .map(
      (interrupt) =>
        interrupt.value as GraphCheckpointSnapshot['pendingApprovals'][number] | undefined,
    )
    .filter(
      (value): value is GraphCheckpointSnapshot['pendingApprovals'][number] => value !== undefined,
    );
}

// ai/langgraph/nodes.ts's pre-built per-agent nodes (discoveryNode,
// riskNode, ...) each bake their own stepId into every executionTrace
// entry they write (e.g. discoveryNode always records stepId
// "discovery") — that's fine for a registered WorkflowDefinition, whose
// own step ids are always chosen to match by convention, but an
// LLM-generated plan's step ids are arbitrary ("step-1", "find-repos",
// ...). Rather than build a fresh node per arbitrary id, every dynamic
// step is mapped onto the one canonical stepId its agent's node already
// uses, and `dependsOn` is translated the same way — so
// withDependencyGate's `entry.stepId === dep` check (graph-builder.ts)
// keeps working unmodified. If a plan names the same agent twice, only
// the first instance actually runs — nodes.ts's own idempotency guard
// (`alreadyAttempted`) treats the second as already attempted, the same
// safe behavior a restart-recovery replay already relies on.
const CANONICAL_STEP_ID: Record<PlannerAgentId, string> = {
  'discovery-agent': 'discovery',
  'risk-agent': 'risk',
  'compliance-agent': 'compliance',
  'recommendation-agent': 'recommendation',
  'report-agent': 'report',
  'copilot-agent': 'copilot',
};

function toGraphSteps(steps: LLMPlanStep[]): GraphStepLike[] {
  const canonicalById = new Map(steps.map((step) => [step.id, CANONICAL_STEP_ID[step.agent]]));
  const seen = new Set<string>();
  const result: GraphStepLike[] = [];
  for (const step of steps) {
    const stepId = canonicalById.get(step.id);
    if (!stepId || seen.has(stepId)) continue;
    seen.add(stepId);
    const dependsOn = [
      ...new Set(
        step.dependsOn
          .map((dep) => canonicalById.get(dep))
          .filter((dep): dep is string => dep !== undefined && dep !== stepId),
      ),
    ];
    result.push({ stepId, agentId: step.agent, dependsOn });
  }
  return result;
}

function computeStatus(state: GraphState, pendingCount: number): GraphRunStatus {
  if (pendingCount > 0) return 'WAITING_FOR_APPROVAL';
  const hasFailure = state.executionTrace.some((entry) => entry.status === 'FAILED');
  const hasSuccess = state.executionTrace.some((entry) => entry.status === 'SUCCESS');
  if (hasFailure) return hasSuccess ? 'PARTIAL' : 'FAILED';
  return 'COMPLETED';
}

function buildFeedback(state: GraphState, plan: LLMPlan): string {
  const reflection = state.reflection;
  if (!reflection) {
    return `no reflection report was produced for overallConfidence ${plan.overallConfidence.toFixed(2)}`;
  }
  return [
    `overallConfidence ${reflection.overallConfidence.toFixed(2)} was below the acceptance threshold`,
    `failed steps: ${reflection.failedSteps.join(', ') || 'none'}`,
    `missing evidence: ${reflection.missingEvidence.join(', ') || 'none'}`,
    `critic score: ${reflection.criticScore.toFixed(2)}`,
  ].join('; ');
}

// Spec #6 + #8: turns a validated LLMPlan directly into a running
// LangGraph execution ("no predefined workflow id required" —
// buildDynamicGraph, unlike ai/langgraph/graph.ts's graphRegistry, never
// looks a graph id up in workflowRegistry), then loops the Reflection
// Loop (plan -> run -> reflect -> [confidence too low? revise & rerun] ->
// accept), capped at spec #8's "Maximum 3 iterations." Every actual
// agent invocation still goes through ai/langgraph/nodes.ts's
// makeAgentNode -> orchestratorAgentRegistry, identical to Phase 27's
// GraphExecutor — this class only owns *which* graph gets built and
// *when* to ask for a revision, never re-executing agent logic itself.
export class LLMPlannerExecutor {
  constructor(
    private readonly checkpointStore: GraphCheckpointStore,
    private readonly confidenceThreshold: number = DEFAULT_CONFIDENCE_THRESHOLD,
    private readonly maxIterations: number = DEFAULT_MAX_ITERATIONS,
  ) {}

  async execute(input: PlannerRunInput): Promise<LLMPlannerRunResult> {
    const planRecords: LLMPlanRecord[] = [];
    let record = await llmPlanner.plan(input);
    planRecords.push(record);

    let iteration = 1;
    let run = await this.runOnce(input, record, iteration);

    while (
      run.status !== 'WAITING_FOR_APPROVAL' &&
      this.confidenceOf(run.state, record.plan) < this.confidenceThreshold &&
      iteration < this.maxIterations
    ) {
      iteration += 1;
      const feedback = buildFeedback(run.state, record.plan);
      record = await llmPlanner.revise(input, record.plan, feedback, iteration);
      planRecords.push(record);
      run = await this.runOnce(input, record, iteration);
    }

    return {
      planId: record.planId,
      planRecords,
      executionId: run.executionId,
      graphId: run.graphId,
      status: run.status,
      state: run.state,
      iterations: iteration,
    };
  }

  private confidenceOf(state: GraphState, plan: LLMPlan): number {
    return state.reflection?.overallConfidence ?? plan.overallConfidence;
  }

  private async runOnce(
    input: PlannerRunInput,
    record: LLMPlanRecord,
    iteration: number,
  ): Promise<SingleRunResult> {
    const executionId = generateExecutionId();
    const graphId = `llm-plan-${record.planId}`;
    const graphSteps = toGraphSteps(record.plan.steps);
    if (graphSteps.length === 0) {
      // Every step's agent failed to map onto a canonical stepId — would
      // otherwise reach buildDynamicGraph with zero nodes and fail with
      // LangGraph's own opaque "reflection-node is not reachable" error.
      // Caught for real during this phase's own verification: an earlier
      // test registered a workflow using agent ids outside
      // PLANNER_AVAILABLE_AGENTS, which validatePlan() would reject for
      // an LLM-authored plan but fallbackPlan() (derived from
      // GoalPlanner, never passed through the validator) did not.
      throw new PlannerGraphInputError(
        `plan "${record.planId}" produced no runnable steps (every step's agent fell outside PLANNER_AVAILABLE_AGENTS)`,
      );
    }
    const compiled = buildDynamicGraph(graphId, graphSteps);
    const memory = await loadMemory(input.conversationId, executionId);

    const initialState: Partial<GraphState> = {
      goal: input.goal,
      intent: graphId,
      asset: input.assets ?? [],
      connectedAccounts: input.connectedAccounts ?? [],
      memory,
      approval: emptyApprovalState(),
      metadata: {
        executionId,
        planId: record.planId,
        workflowId: graphId,
        iteration,
        user: input.user,
        organization: input.organization,
        conversationId: input.conversationId,
        ...(input.metadata ?? {}),
      },
    };

    const config = { configurable: { thread_id: executionId } };
    await compiled.invoke(initialState, config);
    // See ai/langgraph/executor.ts's identical comment: invoke()'s own
    // return value can resolve `undefined` on an all-empty-patch round —
    // getState() is always the authoritative final state.
    const snapshot = await compiled.getState(config);
    const finalValues = snapshot.values;
    const pendingApprovals = extractPendingApprovals(snapshot);

    await this.checkpointStore.save({
      executionId,
      graphId,
      values: finalValues,
      next: snapshot.next,
      pendingApprovals,
      updatedAt: new Date().toISOString(),
    });

    const status = computeStatus(finalValues, pendingApprovals.length);
    if (status !== 'WAITING_FOR_APPROVAL') {
      const conversationId = finalValues.metadata.conversationId as string | undefined;
      await persistMemory(conversationId, executionId, finalValues.memory);
    }

    return { executionId, graphId, status, state: finalValues };
  }
}

export const llmPlannerExecutor = new LLMPlannerExecutor(
  new GraphCheckpointStore(new RedisMemoryStore(redis)),
);
