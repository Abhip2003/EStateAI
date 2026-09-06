import type { ToolPermission } from '../types/tool.types.js';

// A step's ApprovalPolicy outcome — NEVER means the step is never gated
// at all (runs exactly like it always has, pre-Phase-26); AUTO means a
// request is created and immediately self-approved (an audit trail
// exists, but nothing blocks); MANUAL means a request is created and the
// step is held until a reviewer decides.
export type ApprovalPolicyDecision = 'AUTO' | 'MANUAL' | 'NEVER';

export type ApprovalDecisionStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

export interface ApprovalRequest {
  id: string;
  executionId: string;
  planId: string;
  workflowId: string;
  stepId: string;
  agentId: string;
  decision: ApprovalPolicyDecision;
  status: ApprovalDecisionStatus;
  reason: string;
  requestedAt: string;
  decidedBy?: string;
  decidedAt?: string;
  decisionReason?: string;
  comment?: string;
  // "Edit recommendation" (spec #5) — a reviewer may substitute the
  // step's output before it's treated as complete, rather than only
  // approving/rejecting the agent's own result. Generic (not
  // recommendation-specific) since any agent's step could in principle
  // be edited; Recommendation Agent is the one that makes this
  // meaningful today.
  editedOutput?: unknown;
}

export interface ApprovalDecisionInput {
  reviewerId: string;
  reason?: string;
  comment?: string;
  editedOutput?: unknown;
}

export interface RequestApprovalInput {
  // Optional — defaults to a random id (ApprovalEngine's pre-Phase-27
  // behavior). Phase 27's LangGraph nodes pass a deterministic id instead
  // (see ai/langgraph/nodes.ts) since a gated node's own re-entrant
  // replay-on-resume can't rely on any GraphState field to know whether
  // it already created a request.
  id?: string;
  executionId: string;
  planId: string;
  workflowId: string;
  stepId: string;
  agentId: string;
  decision: ApprovalPolicyDecision;
  reason: string;
}

// Re-exported so callers of the approval module don't also need to
// reach into ai/types/tool.types.ts just to call
// ApprovalPolicy.decideForToolPermissions().
export type { ToolPermission };
