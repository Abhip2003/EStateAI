import { Counter, Gauge, Histogram } from 'prom-client';
import { metricsRegistry } from '../../observability/metrics.js';
import { logger } from '../../observability/logger.js';

// Distinct `estateai_ai_langgraph_*` prefix — mirrors
// ai/orchestrator/telemetry.ts's own naming convention, registered into
// the same shared metricsRegistry. Spec #11: graph id, visited nodes,
// parallel branches, execution duration, checkpoint count, retry count,
// memory usage.
const graphRunsTotal = new Counter({
  name: 'estateai_ai_langgraph_runs_total',
  help: 'Total LangGraph executions, by graph id and final status',
  labelNames: ['graphId', 'status'] as const,
  registers: [metricsRegistry],
});

const graphDurationSeconds = new Histogram({
  name: 'estateai_ai_langgraph_duration_seconds',
  help: 'End-to-end LangGraph execution duration in seconds',
  labelNames: ['graphId'] as const,
  buckets: [0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300],
  registers: [metricsRegistry],
});

const nodesVisitedTotal = new Counter({
  name: 'estateai_ai_langgraph_nodes_visited_total',
  help: 'Total graph nodes visited (agent steps actually run), by graph id',
  labelNames: ['graphId'] as const,
  registers: [metricsRegistry],
});

// A structural metric — the widest dependency "wave" the graph's
// definition contains (see graph-builder.ts's countMaxParallelBranches),
// not a live per-run trace of which nodes overlapped in wall-clock time.
// Recorded once per run alongside the graph it ran, so /metrics can
// answer "how parallel is graph X" without instrumenting LangGraph's
// internal Pregel scheduler.
const parallelBranchesGauge = new Gauge({
  name: 'estateai_ai_langgraph_parallel_branches',
  help: 'Widest parallel branch (dependency wave) in the graph definition, by graph id',
  labelNames: ['graphId'] as const,
  registers: [metricsRegistry],
});

const checkpointsTotal = new Counter({
  name: 'estateai_ai_langgraph_checkpoints_total',
  help: 'Total durable checkpoints persisted, by graph id',
  labelNames: ['graphId'] as const,
  registers: [metricsRegistry],
});

const retriesTotal = new Counter({
  name: 'estateai_ai_langgraph_retries_total',
  help: 'Total node retry attempts (LangGraph RetryPolicy.retryOn), by graph id and agent id',
  labelNames: ['graphId', 'agentId'] as const,
  registers: [metricsRegistry],
});

const memoryUsageBytesGauge = new Gauge({
  name: 'estateai_ai_langgraph_memory_usage_bytes',
  help: 'process.memoryUsage().heapUsed sampled at the end of the most recent graph run',
  registers: [metricsRegistry],
});

export class GraphTelemetry {
  recordGraphRun(input: {
    graphId: string;
    status: string;
    durationMs: number;
    visitedNodes: number;
    maxParallelBranches: number;
  }): void {
    graphRunsTotal.inc({ graphId: input.graphId, status: input.status });
    graphDurationSeconds.observe({ graphId: input.graphId }, input.durationMs / 1000);
    nodesVisitedTotal.inc({ graphId: input.graphId }, input.visitedNodes);
    parallelBranchesGauge.set({ graphId: input.graphId }, input.maxParallelBranches);
    memoryUsageBytesGauge.set(process.memoryUsage().heapUsed);
    logger.info(
      {
        graphId: input.graphId,
        status: input.status,
        durationMs: input.durationMs,
        visitedNodes: input.visitedNodes,
        maxParallelBranches: input.maxParallelBranches,
      },
      'langgraph.run',
    );
  }

  recordCheckpoint(graphId: string): void {
    checkpointsTotal.inc({ graphId });
  }

  recordRetry(graphId: string, agentId: string): void {
    retriesTotal.inc({ graphId, agentId });
  }
}

export const graphTelemetry = new GraphTelemetry();
