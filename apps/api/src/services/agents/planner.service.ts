import { randomUUID } from 'node:crypto';
import { agentRegistry } from './agent-registry.js';
import type { AgentContext } from './agent-context.js';
import type { AgentTask } from './dto/agent-task.js';
import type { ExecutionPlan } from './dto/execution-plan.js';
import { UnsupportedRequestTypeError } from './agent-errors.js';

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_ATTEMPTS = 2;

// Turns "request → execution plan" (per the spec's architecture diagram).
// Deliberately knows nothing about providers, or which concrete agents
// exist beyond what agentRegistry reports — it only knows request types,
// matching the spec's "Planner must not know providers" constraint. Every
// agent that opts into a request type (via supports()) becomes a task;
// each task's dependencies come from that same agent's plan() hint, not
// from any hardcoded pipeline here.
class PlannerService {
  createPlan(requestType: string, assetId: string, context: AgentContext): ExecutionPlan {
    const agents = agentRegistry.agentsFor(requestType);
    if (agents.length === 0) {
      throw new UnsupportedRequestTypeError(requestType);
    }

    const tasks: AgentTask[] = agents.map((agent) => {
      const hint = agent.plan(context);
      return {
        id: agent.id(),
        agentId: agent.id(),
        dependsOn: hint.dependsOn,
        timeoutMs: hint.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxAttempts: hint.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      };
    });

    // An agent may declare a dependency on another agent that isn't part
    // of THIS plan (e.g. ReportAgent always declares all four deps, but
    // only SECURITY_REPORT ever includes ReportAgent in the first place —
    // still, guard generically rather than assuming today's catalog).
    // Leaving it in would stall the task graph waiting on a task that will
    // never run, so it's dropped here instead.
    const taskIds = new Set(tasks.map((task) => task.id));
    for (const task of tasks) {
      task.dependsOn = task.dependsOn.filter((dep) => taskIds.has(dep));
    }

    return {
      id: randomUUID(),
      requestType,
      assetId,
      tasks,
    };
  }
}

export const plannerService = new PlannerService();
