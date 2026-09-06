import type { WorkflowDefinition } from './workflow.engine.js';
import type { ExecutionResult } from './execution.result.js';
import type { ExecutionHistoryEntry } from './execution.history.js';
import type { WorkflowExecutionState } from './state.manager.js';
import type {
  OrchestrationUser,
  OrchestrationOrganization,
  ConnectedAccountRef,
  AssetRef,
} from './execution.context.js';

export interface OrchestratorExecuteInput {
  intent: string;
  user: OrchestrationUser;
  organization?: OrchestrationOrganization;
  connectedAccounts?: ConnectedAccountRef[];
  assets?: AssetRef[];
  conversationId?: string;
  metadata?: Record<string, unknown>;
}

// Public contract for the orchestrator: understand intent (via Planner),
// execute the resulting plan (via Executor/WorkflowEngine), track and
// expose state, and never perform discovery/risk/compliance/reporting
// itself — see OrchestratorService for the implementation.
export interface Orchestrator {
  execute(input: OrchestratorExecuteInput): Promise<ExecutionResult>;
  cancel(executionId: string): void;
  getStatus(executionId: string): Promise<WorkflowExecutionState | undefined>;
  listWorkflows(): WorkflowDefinition[];
  getWorkflow(workflowId: string): WorkflowDefinition;
  getHistory(limit?: number): Promise<ExecutionHistoryEntry[]>;
}
