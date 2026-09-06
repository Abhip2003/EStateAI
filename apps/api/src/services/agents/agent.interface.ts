import type { AgentContext } from './agent-context.js';

// What agent.plan() declares about itself for a given plan run: which
// other agents (by id) must complete first. PlannerService turns this
// into AgentTask.dependsOn; TaskService turns dependsOn into wave order.
export interface AgentPlanHint {
  dependsOn: string[];
  timeoutMs?: number;
  maxAttempts?: number;
}

// Every agent is a thin, stateless adapter over one or more existing
// services — it must never duplicate business logic (rule evaluation,
// risk scoring, compliance computation, etc. all still live in their own
// services). id()/supports() are pure and synchronous; plan() may read
// from AgentContext (e.g. to decide whether a dependency is even relevant)
// but must not perform the actual work execute() does.
export interface Agent {
  id(): string;
  supports(requestType: string): boolean;
  plan(context: AgentContext): AgentPlanHint;
  execute(context: AgentContext): Promise<Record<string, unknown>>;
}
