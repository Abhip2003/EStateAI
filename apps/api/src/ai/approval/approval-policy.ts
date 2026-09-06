import type { ApprovalPolicyDecision } from './approval.types.js';
import type { ToolPermission } from '../types/tool.types.js';

// Deterministic, documented heuristic — same "not an AI call" spirit as
// ai/orchestrator/planner.ts's intent matching and ai/planner/goal-planner.ts's
// complexity/confidence estimates. Read-only agents (Discovery/Risk/
// Compliance/Report/Copilot — none of them mutate anything outside their
// own memory/telemetry) are NEVER gated, exactly matching current
// pre-Phase-26 behavior. Recommendation Agent produces proposals, not
// destructive actions, so it's AUTO — a request (and audit trail) is
// still created, but nothing blocks on it, matching the spec's own
// "Low-risk recommendation -> AUTO" example.
const DEFAULT_AGENT_POLICY: Record<string, ApprovalPolicyDecision> = {
  'discovery-agent': 'NEVER',
  'risk-agent': 'NEVER',
  'compliance-agent': 'NEVER',
  'recommendation-agent': 'AUTO',
  'report-agent': 'NEVER',
  'copilot-agent': 'NEVER',
};

// A mutable registry (mirrors workflowRegistry/orchestratorAgentRegistry's
// own register()-then-read shape) rather than a fixed lookup table — no
// agent ships MANUAL by default today (no destructive action exists yet,
// per Phase 24's "no write-capable tool" scope), so `register()` is what
// lets a future write-capable agent/tool declare itself MANUAL (spec #7)
// without editing this file, and is also what a verify script uses to
// exercise the MANUAL/pause/resume path against a synthetic agent.
export class ApprovalPolicy {
  private readonly policy = new Map<string, ApprovalPolicyDecision>(
    Object.entries(DEFAULT_AGENT_POLICY),
  );

  register(agentId: string, decision: ApprovalPolicyDecision): void {
    this.policy.set(agentId, decision);
  }

  // Applies to a step's own agentId — used by GoalPlanner-produced plans
  // (ai/planner/plan.types.ts's ReasoningPlanStep). An unregistered
  // agentId defaults to NEVER — the safe, backward-compatible default
  // (a new agent that never registers a policy behaves exactly like
  // every pre-Phase-26 agent already does: it just runs).
  decideForAgent(agentId: string): ApprovalPolicyDecision {
    return this.policy.get(agentId) ?? 'NEVER';
  }

  // The Phase 24 spec's own future integration point (spec #7): a
  // write-capable tool must request approval automatically; a read-only
  // one stays automatic. No tool declares 'write' yet (ToolExecutor
  // refuses to run one — see ai/tools/tool-permissions.ts), so this is
  // infrastructure a future write tool would call before executing,
  // not something exercised by any real call today.
  decideForToolPermissions(permissions: ToolPermission[]): ApprovalPolicyDecision {
    return permissions.includes('write') ? 'MANUAL' : 'NEVER';
  }
}

export const approvalPolicy = new ApprovalPolicy();
