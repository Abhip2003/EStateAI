import { Counter, Histogram } from 'prom-client';
import { metricsRegistry } from '../../observability/metrics.js';
import { logger } from '../../observability/logger.js';
import { prisma } from '../../db/prisma.js';

// `estateai_ai_tool_*` — framework-wide tool-call metrics, recorded by
// ToolExecutor for every run() regardless of which agent or which tool.
// Distinct from each agent's own `*_agent_tool_calls_total` metric
// (Copilot's copilot.telemetry.ts, etc.), which only ever sees that
// agent's own calls; this family sees every call through ToolExecutor.
const callsTotal = new Counter({
  name: 'estateai_ai_tool_calls_total',
  help: 'Total tool calls via ToolExecutor, by tool, agent, and outcome',
  labelNames: ['tool', 'agent', 'success'] as const,
  registers: [metricsRegistry],
});

const callDurationSeconds = new Histogram({
  name: 'estateai_ai_tool_call_duration_seconds',
  help: 'Tool call latency in seconds, by tool',
  labelNames: ['tool'] as const,
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2.5, 5, 10, 30],
  registers: [metricsRegistry],
});

export class ToolTelemetry {
  recordCall(input: { tool: string; agent?: string; success: boolean; durationMs: number }): void {
    callsTotal.inc({
      tool: input.tool,
      agent: input.agent ?? 'unknown',
      success: String(input.success),
    });
    callDurationSeconds.observe({ tool: input.tool }, input.durationMs / 1000);
    if (!input.success) {
      logger.warn({ tool: input.tool, agent: input.agent }, 'tool.call_failed');
    }
  }

  // Tool Execution Trace persistence (spec #9) — write-once, best-effort:
  // a trace-persistence failure must never fail the tool call it's
  // recording, same "observability must not affect correctness"
  // precedent RetrievalTrace/ExecutionHistory already set.
  async recordTrace(input: {
    toolName: string;
    agentId?: string;
    arguments: unknown;
    success: boolean;
    error?: string;
    durationMs: number;
  }): Promise<void> {
    try {
      await prisma.toolExecutionTrace.create({
        data: {
          toolName: input.toolName,
          agentId: input.agentId,
          arguments: input.arguments as object,
          success: input.success,
          error: input.error,
          durationMs: input.durationMs,
        },
      });
    } catch (error) {
      logger.error({ err: error, tool: input.toolName }, 'tool.trace_write_failed');
    }
  }
}

export const toolTelemetry = new ToolTelemetry();
