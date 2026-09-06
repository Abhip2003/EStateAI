import { Command } from '@langchain/langgraph';
import { redis } from '../../cache/redis.js';
import { RedisMemoryStore } from '../memory/redis-memory-store.js';
import { goalPlanner } from '../planner/goal-planner.js';
import { reasoningFoundation } from '../planner/reasoning.js';
import { approvalFoundation } from '../approval/approval.js';
import { GraphCheckpointStore, type PendingGraphApproval } from './graph.checkpoint.js';
import { graphRegistry, resolveGraphId } from './graph.js';
import { loadMemory, persistMemory } from './graph.memory.js';
import { graphTelemetry } from './graph.telemetry.js';
import { GraphError } from './graph-error.js';
import { emptyApprovalState, type GraphState } from './state.js';
import type {
  GraphApprovalResume,
  GraphExecutionResult,
  GraphRunInput,
  GraphRunStatus,
} from './graph.types.js';

function generateExecutionId(): string {
  return `gexec-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

// A gated node (nodes.ts's makeAgentNode) pauses by *throwing*
// (LangGraph's `interrupt()`), so its own `return` — the only place it
// would otherwise record itself into `state.approval` — never runs while
// paused. The live, authoritative list of what's actually still pending
// is therefore LangGraph's own paused-task interrupts, not
// `state.approval.pendingApprovalIds` (which only reflects the *last
// round a node returned normally*) — this reads it straight from the
// snapshot every time, the same way resume() itself does.
function extractPendingApprovals(snapshot: {
  tasks: Array<{ interrupts?: Array<{ value?: unknown }> }>;
}): PendingGraphApproval[] {
  return snapshot.tasks
    .flatMap((task) => task.interrupts ?? [])
    .map((interrupt) => interrupt.value as PendingGraphApproval | undefined)
    .filter((value): value is PendingGraphApproval => value !== undefined);
}

// Mirrors ai/approval/hitl-orchestrator.ts's own toResult() status
// precedence (WAITING_FOR_APPROVAL > FAILED/PARTIAL > REJECTED >
// COMPLETED/RESUMED) — same design decision, reapplied to GraphState's
// own shape rather than shared code, since the two orchestrators' state
// types differ.
function computeStatus(state: GraphState, pendingCount: number, isResume: boolean): GraphRunStatus {
  if (pendingCount > 0) return 'WAITING_FOR_APPROVAL';
  const hasFailure = state.executionTrace.some((entry) => entry.status === 'FAILED');
  const hasSuccess = state.executionTrace.some((entry) => entry.status === 'SUCCESS');
  if (hasFailure) return hasSuccess ? 'PARTIAL' : 'FAILED';
  if ((state.approval?.rejectedStepIds?.length ?? 0) > 0) return 'REJECTED';
  return isResume ? 'RESUMED' : 'COMPLETED';
}

type CompiledGraph = ReturnType<typeof graphRegistry.getOrBuild>;

// Coordinates the LangGraph-executed flow this phase adds: plan
// (GoalPlanner, unchanged) -> resolve which compiled graph to run
// (graph.ts) -> invoke it on a thread keyed by executionId -> persist a
// durable checkpoint (graph.checkpoint.ts) -> report. resume() re-derives
// the live approval decision for whatever the graph is currently
// interrupted on and hands it back via LangGraph's own `Command({resume})`
// — WorkflowEngine/HitlOrchestrator/OrchestratorService are never
// modified or replaced; this is a parallel, additive entry point behind
// POST /ai/langgraph/execute.
export class GraphExecutor {
  constructor(private readonly checkpointStore: GraphCheckpointStore) {}

  async run(input: GraphRunInput): Promise<GraphExecutionResult> {
    const executionId = generateExecutionId();
    const plan = goalPlanner.createPlan(input.goal, input.metadata);
    await reasoningFoundation.planStore.save(plan);

    const graphId = resolveGraphId(input.goal, plan.workflowId);
    const compiled = graphRegistry.getOrBuild(graphId);
    const memory = await loadMemory(input.conversationId, executionId);

    const initialState: Partial<GraphState> = {
      goal: input.goal,
      intent: plan.workflowId,
      asset: input.assets ?? [],
      connectedAccounts: input.connectedAccounts ?? [],
      memory,
      approval: emptyApprovalState(),
      metadata: {
        executionId,
        planId: plan.planId,
        workflowId: plan.workflowId,
        user: input.user,
        organization: input.organization,
        conversationId: input.conversationId,
        ...(input.metadata ?? {}),
      },
    };

    const config = { configurable: { thread_id: executionId } };
    return this.invokeAndPersist(
      compiled,
      graphId,
      plan.workflowId,
      executionId,
      initialState,
      config,
      false,
    );
  }

  async resume(executionId: string): Promise<GraphExecutionResult> {
    const saved = await this.checkpointStore.get(executionId);
    if (!saved) {
      throw new GraphError(`no execution "${executionId}" to resume`, executionId);
    }
    const compiled = graphRegistry.getOrBuild(saved.graphId);
    const config = { configurable: { thread_id: executionId } };
    const workflowId = (saved.values.metadata.workflowId as string | undefined) ?? saved.graphId;

    const snapshot = await compiled.getState(config);
    let input: Partial<GraphState> | InstanceType<typeof Command>;
    if (snapshot && snapshot.next.length > 0) {
      const pending = extractPendingApprovals(snapshot)[0];
      if (pending) {
        const request = await approvalFoundation.approvalEngine.get(pending.approvalId);
        const resume: GraphApprovalResume = {
          status: (request?.status as GraphApprovalResume['status']) ?? 'PENDING',
          editedOutput: request?.editedOutput,
        };
        input = new Command({ resume });
      } else {
        input = new Command({ resume: {} });
      }
    } else {
      // Process restarted (or this process's in-memory MemorySaver never
      // had this thread) — replay the durable snapshot back in as a
      // fresh invoke() input on the same thread; every node is
      // idempotent (skips recomputation once its own state field is
      // set), so this "fast-forwards" straight back to wherever it
      // paused rather than re-running completed work.
      input = saved.values;
    }

    return this.invokeAndPersist(
      compiled,
      saved.graphId,
      workflowId,
      executionId,
      input,
      config,
      true,
    );
  }

  async getExecution(executionId: string): Promise<GraphExecutionResult | undefined> {
    const saved = await this.checkpointStore.get(executionId);
    if (!saved) return undefined;
    const workflowId = (saved.values.metadata.workflowId as string | undefined) ?? saved.graphId;
    const status = computeStatus(saved.values, saved.pendingApprovals.length, false);
    return {
      executionId: saved.executionId,
      graphId: saved.graphId,
      workflowId,
      status,
      state: saved.values,
      pendingApprovalIds: saved.pendingApprovals.map((approval) => approval.approvalId),
      startedAt: saved.updatedAt,
      finishedAt: saved.updatedAt,
      durationMs: 0,
    };
  }

  async getState(executionId: string): Promise<GraphState | undefined> {
    const saved = await this.checkpointStore.get(executionId);
    return saved?.values;
  }

  private async invokeAndPersist(
    compiled: CompiledGraph,
    graphId: string,
    workflowId: string,
    executionId: string,
    input: unknown,
    config: { configurable: { thread_id: string } },
    isResume: boolean,
  ): Promise<GraphExecutionResult> {
    const startedAt = new Date().toISOString();
    const startedAtMs = Date.now();

    await compiled.invoke(input, config);
    // Read the authoritative final state from the checkpointer, not
    // invoke()'s own return value — a round where every node's return is
    // an empty patch (e.g. a full idempotent replay where nothing was
    // left to do) can leave invoke() resolving `undefined`, since it has
    // nothing new to report; getState() always reflects the real,
    // accumulated channel values regardless.
    const stateSnapshot = await compiled.getState(config);
    const finalValues = stateSnapshot.values;
    const pendingApprovals = extractPendingApprovals(stateSnapshot);

    await this.checkpointStore.save({
      executionId,
      graphId,
      values: finalValues,
      next: stateSnapshot.next,
      pendingApprovals,
      updatedAt: new Date().toISOString(),
    });
    graphTelemetry.recordCheckpoint(graphId);

    const status = computeStatus(finalValues, pendingApprovals.length, isResume);
    const finishedAt = new Date().toISOString();
    const durationMs = Date.now() - startedAtMs;

    if (status !== 'WAITING_FOR_APPROVAL') {
      const conversationId = finalValues.metadata.conversationId as string | undefined;
      await persistMemory(conversationId, executionId, finalValues.memory);
    }

    graphTelemetry.recordGraphRun({
      graphId,
      status,
      durationMs,
      visitedNodes: finalValues.executionTrace.length,
      maxParallelBranches: graphRegistry.maxParallelBranches(graphId),
    });

    return {
      executionId,
      graphId,
      workflowId,
      status,
      state: finalValues,
      pendingApprovalIds: pendingApprovals.map((approval) => approval.approvalId),
      startedAt,
      finishedAt,
      durationMs,
    };
  }
}

export const graphExecutor = new GraphExecutor(
  new GraphCheckpointStore(new RedisMemoryStore(redis)),
);
