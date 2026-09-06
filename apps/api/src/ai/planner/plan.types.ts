// Distinct from ai/orchestrator/planner.ts's `ExecutionPlan` (which only
// carries stepId/agentId/dependsOn — enough for WorkflowEngine to run
// it). `ReasoningPlan` wraps that plain plan with the reasoning-first
// fields Phase 25 adds: required tools, complexity/duration estimates,
// and a confidence score, plus revision provenance once a plan has been
// re-derived from a partial/failed execution.
export type PlanComplexity = 'LOW' | 'MEDIUM' | 'HIGH';

export interface ReasoningPlanStep {
  stepId: string;
  agentId: string;
  dependsOn: string[];
  tools: string[];
}

export interface ReasoningPlan {
  planId: string;
  goal: string;
  workflowId: string;
  steps: ReasoningPlanStep[];
  requiredAgents: string[];
  requiredTools: string[];
  estimatedComplexity: PlanComplexity;
  estimatedDurationMs: number;
  confidence: number;
  createdAt: string;
  // Set only on a plan produced by GoalPlanner.revisePlan() — the planId
  // of the plan it was derived from, and a human-readable reason.
  revisionOf?: string;
  revisionReason?: string;
  // Phase 26 (Human-in-the-Loop) — optional, populated by the approval
  // layer (ai/approval/), never by GoalPlanner itself, to avoid a
  // planner -> approval import cycle (ai/approval already depends on
  // ai/planner's types). True if any step's ApprovalPolicy decision is
  // MANUAL. Absent on a plan that never went through the HITL flow
  // (e.g. one created via POST /ai/planner/plan, Phase 25's plain path).
  approvalRequired?: boolean;
}
