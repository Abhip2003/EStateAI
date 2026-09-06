import { Counter, Histogram } from 'prom-client';
import { metricsRegistry } from '../../../observability/metrics.js';
import { logger } from '../../../observability/logger.js';

// Distinct `estateai_ai_risk_agent_*` prefix — separate from the
// pre-existing `estateai_ai_discovery_agent_*` (Phase 18) and
// `estateai_ai_orchestrator_*` (Phase 17, which also records a generic
// step duration/outcome whenever this agent runs as an orchestrator
// step). This family measures the Risk Agent layer specifically: run
// duration, findings by severity, tool-call latency, LLM latency/token
// usage, and retries.
const runsTotal = new Counter({
  name: 'estateai_ai_risk_agent_runs_total',
  help: 'Total Risk Agent runs, by outcome status',
  labelNames: ['status'] as const,
  registers: [metricsRegistry],
});

const runDurationSeconds = new Histogram({
  name: 'estateai_ai_risk_agent_duration_seconds',
  help: 'Risk Agent end-to-end run duration in seconds',
  buckets: [0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 120],
  registers: [metricsRegistry],
});

const findingsGeneratedTotal = new Counter({
  name: 'estateai_ai_risk_agent_findings_total',
  help: 'Total findings surfaced across all Risk Agent runs, by severity',
  labelNames: ['severity'] as const,
  registers: [metricsRegistry],
});

const toolCallsTotal = new Counter({
  name: 'estateai_ai_risk_agent_tool_calls_total',
  help: 'Total Risk Agent tool calls, by tool name and outcome',
  labelNames: ['tool', 'success'] as const,
  registers: [metricsRegistry],
});

const toolCallDurationSeconds = new Histogram({
  name: 'estateai_ai_risk_agent_tool_call_duration_seconds',
  help: 'Risk Agent tool call latency in seconds, by tool name',
  labelNames: ['tool'] as const,
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2.5, 5, 10, 30, 60],
  registers: [metricsRegistry],
});

const llmCallDurationSeconds = new Histogram({
  name: 'estateai_ai_risk_agent_llm_duration_seconds',
  help: 'Risk Agent LLM call latency in seconds (summary and finding-explanation calls)',
  buckets: [0.1, 0.5, 1, 2.5, 5, 10, 30, 60],
  registers: [metricsRegistry],
});

const tokenUsageTotal = new Counter({
  name: 'estateai_ai_risk_agent_llm_tokens_total',
  help: 'Total LLM tokens consumed by the Risk Agent, by kind',
  labelNames: ['kind'] as const,
  registers: [metricsRegistry],
});

const retriesTotal = new Counter({
  name: 'estateai_ai_risk_agent_retries_total',
  help: 'Total retry attempts made by the Risk Agent before success or exhaustion',
  registers: [metricsRegistry],
});

export class RiskAgentTelemetry {
  recordRun(input: {
    status: string;
    durationMs: number;
    counts: { critical: number; high: number; medium: number; low: number; informational: number };
  }): void {
    runsTotal.inc({ status: input.status });
    runDurationSeconds.observe(input.durationMs / 1000);
    findingsGeneratedTotal.inc({ severity: 'CRITICAL' }, input.counts.critical);
    findingsGeneratedTotal.inc({ severity: 'HIGH' }, input.counts.high);
    findingsGeneratedTotal.inc({ severity: 'MEDIUM' }, input.counts.medium);
    findingsGeneratedTotal.inc({ severity: 'LOW' }, input.counts.low);
    findingsGeneratedTotal.inc({ severity: 'INFORMATIONAL' }, input.counts.informational);
    logger.info(
      { status: input.status, durationMs: input.durationMs, counts: input.counts },
      'risk_agent.run',
    );
  }

  recordToolCall(input: { tool: string; success: boolean; durationMs: number }): void {
    toolCallsTotal.inc({ tool: input.tool, success: String(input.success) });
    toolCallDurationSeconds.observe({ tool: input.tool }, input.durationMs / 1000);
    if (!input.success) {
      logger.error(
        { tool: input.tool, durationMs: input.durationMs },
        'risk_agent.tool_call_failed',
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

export const riskAgentTelemetry = new RiskAgentTelemetry();
