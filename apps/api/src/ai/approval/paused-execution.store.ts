import type { MemoryStore } from '../interfaces/memory-store.interface.js';
import type { OrchestrationContext } from '../orchestrator/execution.context.js';
import type { AgentTaskResult } from '../orchestrator/execution.result.js';
import type { ReasoningPlan } from '../planner/plan.types.js';

const KEY_PREFIX = 'approval:paused-execution:';
const TTL_SECONDS = 60 * 60 * 24 * 7; // 7d, matches PlanStore/ReflectionStore

// A snapshot HitlOrchestrator needs to resume an execution without
// restarting it: the plan, the OrchestrationContext (already carrying
// every previously-succeeded step's output in `agentOutputs` — plain
// data, no functions, so it round-trips through JSON exactly), and the
// accumulated AgentTaskResult list across every round run so far (a
// step already recorded here is never re-attempted on resume — see
// hitl-orchestrator.ts's buildResumeDefinition()).
export interface PausedExecutionState {
  executionId: string;
  plan: ReasoningPlan;
  context: OrchestrationContext;
  steps: AgentTaskResult[];
  startedAt: string;
  // Every stepId that ever got an ApprovalRequest (MANUAL or AUTO),
  // captured once at the initial run() and reused unchanged on every
  // resume() — request ids never change over an execution's lifetime,
  // only their `status` mutates in place via ApprovalEngine.decide().
  // Deliberately NOT re-derived from ApprovalStore.listPending() on
  // resume: that only returns still-PENDING requests, so a step whose
  // request was just APPROVED/REJECTED would silently vanish from it —
  // this was a real bug caught during Phase 26's own verification.
  approvalIdByStep: Record<string, string>;
}

export class PausedExecutionStore {
  constructor(private readonly store: MemoryStore) {}

  async save(state: PausedExecutionState): Promise<void> {
    await this.store.set(this.key(state.executionId), state, TTL_SECONDS);
  }

  async get(executionId: string): Promise<PausedExecutionState | undefined> {
    return this.store.get<PausedExecutionState>(this.key(executionId));
  }

  async delete(executionId: string): Promise<void> {
    await this.store.delete(this.key(executionId));
  }

  private key(executionId: string): string {
    return `${KEY_PREFIX}${executionId}`;
  }
}
