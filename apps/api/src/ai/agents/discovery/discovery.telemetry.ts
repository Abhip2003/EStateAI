import { Counter, Histogram } from 'prom-client';
import { metricsRegistry } from '../../../observability/metrics.js';
import { logger } from '../../../observability/logger.js';

// Distinct `estateai_ai_discovery_agent_*` prefix — separate from the
// pre-existing `estateai_discovery_duration_seconds` (measures
// DiscoveryService.discover()'s own core work) and from
// `estateai_ai_orchestrator_*` (Phase 17's step-level metrics, which also
// records a generic step duration/outcome whenever this agent runs as an
// orchestrator step). This family measures the agent layer specifically:
// resources discovered, tool-call counts/latency, retries — all
// registered into the same shared metricsRegistry.
const runsTotal = new Counter({
  name: 'estateai_ai_discovery_agent_runs_total',
  help: 'Total Discovery Agent runs, by outcome status',
  labelNames: ['status'] as const,
  registers: [metricsRegistry],
});

const runDurationSeconds = new Histogram({
  name: 'estateai_ai_discovery_agent_duration_seconds',
  help: 'Discovery Agent end-to-end run duration in seconds',
  buckets: [0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 120],
  registers: [metricsRegistry],
});

const resourcesDiscoveredTotal = new Counter({
  name: 'estateai_ai_discovery_agent_resources_discovered_total',
  help: 'Total resources discovered across all Discovery Agent runs',
  registers: [metricsRegistry],
});

const toolCallsTotal = new Counter({
  name: 'estateai_ai_discovery_agent_tool_calls_total',
  help: 'Total Discovery Agent tool calls, by tool name and outcome',
  labelNames: ['tool', 'success'] as const,
  registers: [metricsRegistry],
});

const toolCallDurationSeconds = new Histogram({
  name: 'estateai_ai_discovery_agent_tool_call_duration_seconds',
  help: 'Discovery Agent tool call latency in seconds, by tool name',
  labelNames: ['tool'] as const,
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2.5, 5, 10, 30, 60],
  registers: [metricsRegistry],
});

const retriesTotal = new Counter({
  name: 'estateai_ai_discovery_agent_retries_total',
  help: 'Total retry attempts made by the Discovery Agent before success or exhaustion',
  registers: [metricsRegistry],
});

export class DiscoveryAgentTelemetry {
  recordRun(input: { status: string; durationMs: number; resourceCount: number }): void {
    runsTotal.inc({ status: input.status });
    runDurationSeconds.observe(input.durationMs / 1000);
    resourcesDiscoveredTotal.inc(input.resourceCount);
    logger.info(
      { status: input.status, durationMs: input.durationMs, resourceCount: input.resourceCount },
      'discovery_agent.run',
    );
  }

  recordToolCall(input: { tool: string; success: boolean; durationMs: number }): void {
    toolCallsTotal.inc({ tool: input.tool, success: String(input.success) });
    toolCallDurationSeconds.observe({ tool: input.tool }, input.durationMs / 1000);
    if (!input.success) {
      logger.error(
        { tool: input.tool, durationMs: input.durationMs },
        'discovery_agent.tool_call_failed',
      );
    }
  }

  recordRetry(): void {
    retriesTotal.inc();
  }
}

export const discoveryAgentTelemetry = new DiscoveryAgentTelemetry();
