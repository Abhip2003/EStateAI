import type { ExecutionPlan } from './dto/execution-plan.js';
import type { AgentResult } from './dto/agent-result.js';

export type PlanOutcomeStatus = 'SUCCESS' | 'PARTIAL' | 'FAILED';

export interface TaskSummary {
  taskId: string;
  agentId: string;
  status: string;
  startedAt: string;
  durationMs: number;
  attempts: number;
  error?: string;
}

// What AgentOrchestrator.execute() returns, and what gets persisted as
// AgentPlanExecution.summary. `tasks` preserves per-task provenance
// (which agent, when, how long, how many attempts) separately from
// `data`, which is the merged, report-ready payload keyed by agentId.
export interface AggregatedPlanResult {
  planId: string;
  requestType: string;
  assetId: string;
  status: PlanOutcomeStatus;
  durationMs: number;
  tasks: TaskSummary[];
  data: Record<string, unknown>;
}

class ResultAggregatorService {
  aggregate(
    plan: ExecutionPlan,
    results: AgentResult[],
    startedAtMs: number,
  ): AggregatedPlanResult {
    const data: Record<string, unknown> = {};
    let successCount = 0;
    let failedCount = 0;

    for (const result of results) {
      if (result.status === 'SUCCESS') {
        if (result.data) {
          data[result.agentId] = result.data;
        }
        successCount += 1;
      } else if (result.status === 'FAILED') {
        failedCount += 1;
      }
    }

    const status: PlanOutcomeStatus =
      failedCount === 0 ? 'SUCCESS' : successCount === 0 ? 'FAILED' : 'PARTIAL';

    return {
      planId: plan.id,
      requestType: plan.requestType,
      assetId: plan.assetId,
      status,
      durationMs: Date.now() - startedAtMs,
      tasks: results.map((result) => ({
        taskId: result.taskId,
        agentId: result.agentId,
        status: result.status,
        startedAt: result.startedAt.toISOString(),
        durationMs: result.durationMs,
        attempts: result.attempts,
        error: result.error,
      })),
      data,
    };
  }
}

export const resultAggregatorService = new ResultAggregatorService();
