import { workflowRegistry } from './workflow.registry.js';
import { PlanningError } from './errors/index.js';
import { orchestratorTelemetry } from './telemetry.js';

export interface PlanningRequest {
  // Either a known workflow id (e.g. 'full-security-analysis') or a
  // free-form user request the planner maps to one via keyword matching.
  intent: string;
  metadata?: Record<string, unknown>;
}

export interface PlannedStep {
  stepId: string;
  agentId: string;
  dependsOn: string[];
}

export interface ExecutionPlan {
  planId: string;
  workflowId: string;
  intent: string;
  steps: PlannedStep[];
  createdAt: string;
}

// Maps a free-form intent to a registered workflow id via simple keyword
// matching — not an LLM call. The planner's only job is to understand
// intent well enough to *select and describe* a plan; it must never
// execute discovery/risk/compliance/reporting logic itself. A future phase
// can swap this matching step for an LLM-driven planner built on
// aiFoundation.llmClient without changing ExecutionPlan's shape or any
// downstream consumer (Executor only ever reads `.steps`).
const INTENT_WORKFLOW_MAP: Array<{ pattern: RegExp; workflowId: string }> = [
  {
    pattern: /github|organization|org\b|full|complete|everything/i,
    workflowId: 'full-security-analysis',
  },
  { pattern: /risk/i, workflowId: 'risk-only' },
  { pattern: /complian/i, workflowId: 'compliance-only' },
];

export class Planner {
  createPlan(request: PlanningRequest): ExecutionPlan {
    const startedAtMs = Date.now();
    const workflowId = this.resolveWorkflowId(request);
    const definition = workflowRegistry.get(workflowId);

    const plan: ExecutionPlan = {
      planId: `plan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      workflowId: definition.id,
      intent: request.intent,
      steps: definition.steps.map((step) => ({
        stepId: step.stepId,
        agentId: step.agentId,
        dependsOn: step.dependsOn ?? [],
      })),
      createdAt: new Date().toISOString(),
    };

    orchestratorTelemetry.recordPlanningLatency(Date.now() - startedAtMs);
    return plan;
  }

  private resolveWorkflowId(request: PlanningRequest): string {
    if (workflowRegistry.has(request.intent)) {
      return request.intent;
    }
    const match = INTENT_WORKFLOW_MAP.find((entry) => entry.pattern.test(request.intent));
    if (!match) {
      throw new PlanningError(
        `could not determine a workflow for intent "${request.intent}"`,
        request.intent,
      );
    }
    return match.workflowId;
  }
}

export const planner = new Planner();
