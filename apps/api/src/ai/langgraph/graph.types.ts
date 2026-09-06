import type {
  OrchestrationUser,
  OrchestrationOrganization,
  ConnectedAccountRef,
  AssetRef,
} from '../orchestrator/execution.context.js';
import type { GraphState } from './state.js';

export interface GraphRunInput {
  goal: string;
  user: OrchestrationUser;
  organization?: OrchestrationOrganization;
  connectedAccounts?: ConnectedAccountRef[];
  assets?: AssetRef[];
  conversationId?: string;
  metadata?: Record<string, unknown>;
}

// Distinct from ai/orchestrator/types.ts's WorkflowStatus and
// ai/approval/hitl-orchestrator.ts's own HitlRunStatus — this is
// GraphExecutor's own vocabulary for what a graph-executed run can reach,
// including the extra states LangGraph's native interrupt/resume adds.
export type GraphRunStatus =
  | 'COMPLETED'
  | 'PARTIAL'
  | 'FAILED'
  | 'WAITING_FOR_APPROVAL'
  | 'RESUMED'
  | 'REJECTED'
  | 'CANCELLED';

export interface GraphExecutionResult {
  executionId: string;
  graphId: string;
  workflowId: string;
  status: GraphRunStatus;
  state: GraphState;
  pendingApprovalIds: string[];
  startedAt: string;
  finishedAt: string;
  durationMs: number;
}

// Payload carried by every `interrupt()` call a gated node makes (see
// nodes.ts's withApprovalGate) — available to a caller inspecting
// `compiledGraph.getState(config).tasks[].interrupts[].value` and to
// GraphExecutor.resume() when it re-derives the live decision to resume
// with.
export interface GraphApprovalInterrupt {
  approvalId: string;
  stepId: string;
  agentId: string;
  reason: string;
}

// What GraphExecutor.resume() passes back into a paused `interrupt()`
// call via `new Command({ resume })`. `status: 'PENDING'` means "resume()
// was called before a reviewer actually decided" — the node re-interrupts
// immediately rather than proceeding (see nodes.ts).
export interface GraphApprovalResume {
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  editedOutput?: unknown;
}
