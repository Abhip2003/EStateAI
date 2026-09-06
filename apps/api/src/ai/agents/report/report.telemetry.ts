import { Counter, Histogram } from 'prom-client';
import { metricsRegistry } from '../../../observability/metrics.js';
import { logger } from '../../../observability/logger.js';

// `estateai_ai_report_agent_*` — the fifth per-agent metric family
// (Discovery/Risk/Compliance/Recommendation/Report). `sections_total`
// (labeled by sourceAgent + status) is this agent's equivalent of
// Compliance's `controls_checked_total` — a per-section outcome count
// that doubles as the "failure isolation" signal: a MISSING/FAILED
// section shows up here without the whole run counting as FAILED.
const runsTotal = new Counter({
  name: 'estateai_ai_report_agent_runs_total',
  help: 'Total Report Agent runs, by outcome status',
  labelNames: ['status'] as const,
  registers: [metricsRegistry],
});

const runDurationSeconds = new Histogram({
  name: 'estateai_ai_report_agent_duration_seconds',
  help: 'Report Agent end-to-end run duration in seconds',
  buckets: [0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 120],
  registers: [metricsRegistry],
});

const sectionsTotal = new Counter({
  name: 'estateai_ai_report_agent_sections_total',
  help: 'Total report sections produced, by source agent and status',
  labelNames: ['sourceAgent', 'status'] as const,
  registers: [metricsRegistry],
});

const toolCallsTotal = new Counter({
  name: 'estateai_ai_report_agent_tool_calls_total',
  help: 'Total Report Agent tool calls, by tool name and outcome',
  labelNames: ['tool', 'success'] as const,
  registers: [metricsRegistry],
});

const toolCallDurationSeconds = new Histogram({
  name: 'estateai_ai_report_agent_tool_call_duration_seconds',
  help: 'Report Agent tool call latency in seconds, by tool name',
  labelNames: ['tool'] as const,
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2.5, 5, 10, 30, 60],
  registers: [metricsRegistry],
});

const llmCallDurationSeconds = new Histogram({
  name: 'estateai_ai_report_agent_llm_duration_seconds',
  help: 'Report Agent LLM call latency in seconds',
  buckets: [0.1, 0.5, 1, 2.5, 5, 10, 30, 60],
  registers: [metricsRegistry],
});

const tokenUsageTotal = new Counter({
  name: 'estateai_ai_report_agent_llm_tokens_total',
  help: 'Total LLM tokens consumed by the Report Agent, by kind',
  labelNames: ['kind'] as const,
  registers: [metricsRegistry],
});

const retriesTotal = new Counter({
  name: 'estateai_ai_report_agent_retries_total',
  help: 'Total retry attempts made by the Report Agent before success or exhaustion',
  registers: [metricsRegistry],
});

export class ReportAgentTelemetry {
  recordRun(input: {
    status: string;
    durationMs: number;
    sections: { sourceAgent: string; status: string }[];
  }): void {
    runsTotal.inc({ status: input.status });
    runDurationSeconds.observe(input.durationMs / 1000);
    for (const section of input.sections) {
      sectionsTotal.inc({ sourceAgent: section.sourceAgent, status: section.status });
    }
    logger.info(
      { status: input.status, durationMs: input.durationMs, sectionCount: input.sections.length },
      'report_agent.run',
    );
  }

  recordToolCall(input: { tool: string; success: boolean; durationMs: number }): void {
    toolCallsTotal.inc({ tool: input.tool, success: String(input.success) });
    toolCallDurationSeconds.observe({ tool: input.tool }, input.durationMs / 1000);
    if (!input.success) {
      logger.error(
        { tool: input.tool, durationMs: input.durationMs },
        'report_agent.tool_call_failed',
      );
    }
  }

  recordLLMCall(input: {
    durationMs: number;
    promptTokens?: number;
    completionTokens?: number;
  }): void {
    llmCallDurationSeconds.observe(input.durationMs / 1000);
    if (input.promptTokens) tokenUsageTotal.inc({ kind: 'prompt' }, input.promptTokens);
    if (input.completionTokens) tokenUsageTotal.inc({ kind: 'completion' }, input.completionTokens);
  }

  recordRetry(): void {
    retriesTotal.inc();
  }
}

export const reportAgentTelemetry = new ReportAgentTelemetry();
