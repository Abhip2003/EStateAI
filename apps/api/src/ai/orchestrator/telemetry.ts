import { Counter, Histogram } from 'prom-client';
import { metricsRegistry } from '../../observability/metrics.js';
import { logger } from '../../observability/logger.js';

// Distinct `estateai_ai_orchestrator_*` prefix — separate from both the
// legacy `estateai_ai_*` metrics (services/ai/) and the Phase 16
// `estateai_ai_foundation_*` metrics (ai/telemetry/), registered into the
// same shared metricsRegistry so /metrics serves all three families
// without a name collision.
const workflowRunsTotal = new Counter({
  name: 'estateai_ai_orchestrator_workflow_runs_total',
  help: 'Total orchestrator workflow runs, by workflow id and final status',
  labelNames: ['workflowId', 'status'] as const,
  registers: [metricsRegistry],
});

const workflowDurationSeconds = new Histogram({
  name: 'estateai_ai_orchestrator_workflow_duration_seconds',
  help: 'End-to-end orchestrator workflow duration in seconds',
  labelNames: ['workflowId'] as const,
  buckets: [0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300],
  registers: [metricsRegistry],
});

const planningDurationSeconds = new Histogram({
  name: 'estateai_ai_orchestrator_planning_duration_seconds',
  help: 'Time taken by Planner.createPlan() in seconds',
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1],
  registers: [metricsRegistry],
});

const stepExecutionsTotal = new Counter({
  name: 'estateai_ai_orchestrator_step_executions_total',
  help: 'Total workflow step executions, by agent id and outcome',
  labelNames: ['agentId', 'status'] as const,
  registers: [metricsRegistry],
});

const stepDurationSeconds = new Histogram({
  name: 'estateai_ai_orchestrator_step_duration_seconds',
  help: 'Workflow step latency in seconds, by agent id',
  labelNames: ['agentId'] as const,
  buckets: [0.05, 0.1, 0.5, 1, 2.5, 5, 10, 30, 60],
  registers: [metricsRegistry],
});

export class OrchestratorTelemetry {
  recordWorkflowRun(input: { workflowId: string; status: string; durationMs: number }): void {
    workflowRunsTotal.inc({ workflowId: input.workflowId, status: input.status });
    workflowDurationSeconds.observe({ workflowId: input.workflowId }, input.durationMs / 1000);
    logger.info(
      { workflowId: input.workflowId, status: input.status, durationMs: input.durationMs },
      'orchestrator.workflow_run',
    );
  }

  recordPlanningLatency(durationMs: number): void {
    planningDurationSeconds.observe(durationMs / 1000);
  }

  recordStepExecution(input: {
    agentId: string;
    status: 'SUCCESS' | 'FAILED';
    durationMs: number;
  }): void {
    stepExecutionsTotal.inc({ agentId: input.agentId, status: input.status });
    stepDurationSeconds.observe({ agentId: input.agentId }, input.durationMs / 1000);
    if (input.status === 'SUCCESS') {
      logger.info(
        { agentId: input.agentId, durationMs: input.durationMs },
        'orchestrator.step_execution',
      );
    } else {
      logger.error(
        { agentId: input.agentId, durationMs: input.durationMs },
        'orchestrator.step_execution_failed',
      );
    }
  }
}

export const orchestratorTelemetry = new OrchestratorTelemetry();
