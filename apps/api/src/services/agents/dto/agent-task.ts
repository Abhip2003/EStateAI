// One node in an ExecutionPlan's task graph. `id` and `agentId` are
// deliberately the same value today — a request type includes any given
// agent at most once per plan, so the agent id doubles as a stable task
// id. `dependsOn` holds other tasks' ids (i.e. other agents' ids) in this
// same plan; TaskService drops any id here that isn't part of the plan
// (see PlannerService) rather than leaving a dangling dependency.
export interface AgentTask {
  id: string;
  agentId: string;
  dependsOn: string[];
  timeoutMs: number;
  maxAttempts: number;
}
