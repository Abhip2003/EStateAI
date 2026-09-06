import type { WorkflowDefinition } from './workflow.engine.js';
import { WorkflowError } from './errors/index.js';

// Configurable workflow templates — register()/unregister() so future
// phases can add or replace workflows without touching the planner or
// engine. Seeded below with a small set of default templates shaped
// around the six placeholder agent roles.
export class WorkflowRegistry {
  private readonly workflows = new Map<string, WorkflowDefinition>();

  register(definition: WorkflowDefinition): void {
    this.workflows.set(definition.id, definition);
  }

  unregister(id: string): void {
    this.workflows.delete(id);
  }

  has(id: string): boolean {
    return this.workflows.has(id);
  }

  get(id: string): WorkflowDefinition {
    const definition = this.workflows.get(id);
    if (!definition) {
      throw new WorkflowError(`no workflow registered with id "${id}"`, id);
    }
    return definition;
  }

  list(): WorkflowDefinition[] {
    return [...this.workflows.values()];
  }
}

export const workflowRegistry = new WorkflowRegistry();

// Default templates matching the six placeholder agent roles (see
// agents/*.interface.ts). Configuration metadata only — no agent logic
// lives here. Each becomes runnable the moment a future phase registers a
// concrete agent under the matching id in orchestratorAgentRegistry; until
// then, running one fails cleanly per-step with AgentNotRegisteredError
// (surfaced as a FAILED step, not a thrown exception — see
// workflow.engine.ts).
workflowRegistry.register({
  id: 'full-security-analysis',
  name: 'Full Security Analysis',
  description: 'Discovery -> Risk & Compliance (parallel) -> Recommendation -> Report',
  steps: [
    { stepId: 'discovery', agentId: 'discovery-agent' },
    { stepId: 'risk', agentId: 'risk-agent', dependsOn: ['discovery'] },
    { stepId: 'compliance', agentId: 'compliance-agent', dependsOn: ['discovery'] },
    {
      stepId: 'recommendation',
      agentId: 'recommendation-agent',
      dependsOn: ['risk', 'compliance'],
    },
    { stepId: 'report', agentId: 'report-agent', dependsOn: ['recommendation'] },
  ],
  stepMetadata: {
    discovery: { label: 'Discovery', description: 'Enumerate connected accounts and assets' },
    risk: { label: 'Risk Analysis', description: 'Score risk from discovered findings' },
    compliance: { label: 'Compliance Analysis', description: 'Evaluate policy compliance' },
    recommendation: { label: 'Recommendations', description: 'Derive remediation recommendations' },
    report: { label: 'Report', description: 'Aggregate everything into a final report' },
  },
});

workflowRegistry.register({
  id: 'risk-only',
  name: 'Risk Analysis',
  description: 'Discovery -> Risk',
  steps: [
    { stepId: 'discovery', agentId: 'discovery-agent' },
    { stepId: 'risk', agentId: 'risk-agent', dependsOn: ['discovery'] },
  ],
});

workflowRegistry.register({
  id: 'compliance-only',
  name: 'Compliance Analysis',
  description: 'Discovery -> Compliance',
  steps: [
    { stepId: 'discovery', agentId: 'discovery-agent' },
    { stepId: 'compliance', agentId: 'compliance-agent', dependsOn: ['discovery'] },
  ],
});

// Phase 20 — Multi-Agent Collaboration. These two templates demonstrate
// that Recommendation Agent's handoff-consumption logic
// (recommendation.aggregate.ts's resolveHandoffFromContext) works
// against whichever upstream steps actually ran, not just the full DAG:
// "discovery-recommendation" skips Risk/Compliance entirely (Recommendation
// falls back to a direct FindingService read, per recommendation.executor.ts),
// while "risk-recommendation" hands off live Risk Agent output but never
// runs Compliance (compliance cross-references are simply omitted, not a
// failure). Neither requires any change to WorkflowEngine/Executor — the
// same DAG-wave machinery that runs full-security-analysis runs these.
workflowRegistry.register({
  id: 'discovery-recommendation',
  name: 'Discovery-Only Recommendations',
  description: 'Discovery -> Recommendation (no Risk/Compliance handoff)',
  steps: [
    { stepId: 'discovery', agentId: 'discovery-agent' },
    { stepId: 'recommendation', agentId: 'recommendation-agent', dependsOn: ['discovery'] },
  ],
});

workflowRegistry.register({
  id: 'risk-recommendation',
  name: 'Risk-Driven Recommendations',
  description: 'Discovery -> Risk -> Recommendation (no Compliance handoff)',
  steps: [
    { stepId: 'discovery', agentId: 'discovery-agent' },
    { stepId: 'risk', agentId: 'risk-agent', dependsOn: ['discovery'] },
    { stepId: 'recommendation', agentId: 'recommendation-agent', dependsOn: ['risk'] },
  ],
});
