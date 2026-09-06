import type { Planner } from './planner.js';
import type { Executor } from './executor.js';
import type { StateManager, WorkflowExecutionState } from './state.manager.js';
import type { ExecutionHistory, ExecutionHistoryEntry } from './execution.history.js';
import { workflowRegistry } from './workflow.registry.js';
import { buildOrchestrationContext } from './execution.context.js';
import type { ExecutionResult } from './execution.result.js';
import type { WorkflowDefinition } from './workflow.engine.js';
import type { Orchestrator, OrchestratorExecuteInput } from './orchestrator.interface.js';
import { WorkflowError } from './errors/index.js';

function generateExecutionId(): string {
  return `exec-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

// The orchestrator's public entry point — "the brain of EstateAI" per the
// Phase 17 spec, but only in the coordination sense: it understands
// intent (Planner), decides execution order (the resolved
// WorkflowDefinition's dependency graph), runs it (Executor/WorkflowEngine),
// tracks state (StateManager), and returns the aggregated result. It never
// performs discovery/risk/compliance/reporting itself — those only exist
// as placeholder interfaces (agents/*.interface.ts) this phase explicitly
// does not implement.
export class OrchestratorService implements Orchestrator {
  private readonly controllers = new Map<string, AbortController>();

  constructor(
    private readonly plannerRef: Planner,
    private readonly executorRef: Executor,
    private readonly stateManagerRef: StateManager,
    private readonly historyRef: ExecutionHistory,
  ) {}

  async execute(input: OrchestratorExecuteInput): Promise<ExecutionResult> {
    const executionId = generateExecutionId();
    const plan = this.plannerRef.createPlan({ intent: input.intent, metadata: input.metadata });

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

    const controller = new AbortController();
    this.controllers.set(executionId, controller);
    try {
      return await this.executorRef.run(plan, context, { signal: controller.signal });
    } finally {
      this.controllers.delete(executionId);
    }
  }

  cancel(executionId: string): void {
    const controller = this.controllers.get(executionId);
    if (!controller) {
      throw new WorkflowError(`no in-flight execution "${executionId}" to cancel`, executionId);
    }
    controller.abort();
  }

  async getStatus(executionId: string): Promise<WorkflowExecutionState | undefined> {
    return this.stateManagerRef.get(executionId);
  }

  listWorkflows(): WorkflowDefinition[] {
    return workflowRegistry.list();
  }

  getWorkflow(workflowId: string): WorkflowDefinition {
    return workflowRegistry.get(workflowId);
  }

  async getHistory(limit?: number): Promise<ExecutionHistoryEntry[]> {
    return this.historyRef.list(limit);
  }
}
