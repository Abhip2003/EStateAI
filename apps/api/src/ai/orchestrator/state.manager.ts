import type { MemoryStore } from '../interfaces/memory-store.interface.js';
import type { OrchestrationContext } from './execution.context.js';
import type { AgentTaskResult } from './execution.result.js';
import type { WorkflowStatus } from './types.js';
import { WorkflowError } from './errors/index.js';

const STATE_KEY_PREFIX = 'orchestrator:state:';
const STATE_TTL_SECONDS = 60 * 60 * 6; // 6h — long enough to poll a finished run, short enough not to leak forever

export interface WorkflowExecutionState {
  executionId: string;
  workflowId: string;
  status: WorkflowStatus;
  currentStep?: string;
  completedSteps: string[];
  failedSteps: string[];
  retryCount: number;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  durationMs?: number;
  context: OrchestrationContext;
}

// Tracks the live/finished state of one orchestrator execution, persisted
// through the injected MemoryStore (Redis in production) so state survives
// process restarts and is readable from a different process than the one
// running the workflow (e.g. GET /ai/orchestrator/status from an API pod
// while a worker pod runs the steps).
export class StateManager {
  constructor(private readonly store: MemoryStore) {}

  private key(executionId: string): string {
    return `${STATE_KEY_PREFIX}${executionId}`;
  }

  async create(input: {
    executionId: string;
    workflowId: string;
    startedAt: string;
    context: OrchestrationContext;
  }): Promise<WorkflowExecutionState> {
    const state: WorkflowExecutionState = {
      executionId: input.executionId,
      workflowId: input.workflowId,
      status: 'RUNNING',
      completedSteps: [],
      failedSteps: [],
      retryCount: 0,
      startedAt: input.startedAt,
      updatedAt: input.startedAt,
      context: input.context,
    };
    await this.store.set(this.key(state.executionId), state, STATE_TTL_SECONDS);
    return state;
  }

  async get(executionId: string): Promise<WorkflowExecutionState | undefined> {
    return this.store.get<WorkflowExecutionState>(this.key(executionId));
  }

  private async mustGet(executionId: string): Promise<WorkflowExecutionState> {
    const state = await this.get(executionId);
    if (!state) {
      throw new WorkflowError(`no execution state for "${executionId}"`);
    }
    return state;
  }

  // Best-effort "currently running step" indicator for live progress —
  // a single-field overwrite, so concurrent steps within the same
  // parallel wave racing this call is harmless (worst case, the reported
  // current step is momentarily one of its wave-mates instead of itself).
  async touchCurrentStep(executionId: string, stepId: string): Promise<void> {
    const state = await this.get(executionId);
    if (!state) return;
    await this.store.set(
      this.key(executionId),
      { ...state, currentStep: stepId, updatedAt: new Date().toISOString() },
      STATE_TTL_SECONDS,
    );
  }

  // Single, race-free write of the final per-step outcome once a workflow
  // run completes — computed from the full step-result array rather than
  // incrementally during execution, since MemoryStore's get/set pair isn't
  // atomic and parallel-wave steps completing concurrently would otherwise
  // be able to clobber each other's partial updates.
  async finalize(
    executionId: string,
    steps: AgentTaskResult[],
    status: WorkflowStatus,
    finishedAt: string,
    context?: OrchestrationContext,
  ): Promise<WorkflowExecutionState> {
    const state = await this.mustGet(executionId);
    const completedSteps = steps.filter((s) => s.status === 'SUCCESS').map((s) => s.stepId);
    const failedSteps = steps
      .filter((s) => s.status === 'FAILED' || s.status === 'TIMED_OUT')
      .map((s) => s.stepId);
    const retryCount = steps.reduce((sum, s) => sum + Math.max(0, s.attempts - 1), 0);

    // `state.context` is the snapshot create() persisted before the first
    // wave ran — agentOutputs/toolOutputs/previousDecisions are mutated on
    // the live, in-process context object by reference as the workflow
    // runs (see execution.context.ts's recordAgentOutput/recordToolOutput/
    // recordDecision), never written back to Redis until now. Executor.run()
    // passes that same live object back in here so GET
    // /ai/orchestrator/status reflects the full shared-state trace (Phase
    // 20 goal #7) instead of the empty pre-run snapshot. Falls back to the
    // stored snapshot for any caller that doesn't have the live context.
    const updated: WorkflowExecutionState = {
      ...state,
      context: context ?? state.context,
      status,
      completedSteps,
      failedSteps,
      retryCount,
      currentStep: undefined,
      updatedAt: finishedAt,
      finishedAt,
      durationMs: new Date(finishedAt).getTime() - new Date(state.startedAt).getTime(),
    };
    await this.store.set(this.key(executionId), updated, STATE_TTL_SECONDS);
    return updated;
  }

  async delete(executionId: string): Promise<void> {
    await this.store.delete(this.key(executionId));
  }
}
