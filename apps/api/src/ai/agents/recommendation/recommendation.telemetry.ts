import { Counter, Histogram } from 'prom-client';
import { metricsRegistry } from '../../../observability/metrics.js';
import { logger } from '../../../observability/logger.js';

// Distinct `estateai_ai_recommendation_agent_*` prefix, matching the
// per-agent metric family convention established by discovery/risk/
// compliance (Phases 18-20). Adds a `handoffs_total` counter (labeled by
// source agentId + origin) that the earlier three agents don't need —
// this is the first agent whose whole job is consuming other agents'
// outputs, so provenance of that handoff is itself an observability
// signal (Phase 20 goal #10 — "handoffs").
const runsTotal = new Counter({
  name: 'estateai_ai_recommendation_agent_runs_total',
  help: 'Total Recommendation Agent runs, by outcome status',
  labelNames: ['status'] as const,
  registers: [metricsRegistry],
});

const runDurationSeconds = new Histogram({
  name: 'estateai_ai_recommendation_agent_duration_seconds',
  help: 'Recommendation Agent end-to-end run duration in seconds',
  buckets: [0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 120],
  registers: [metricsRegistry],
});

const recommendationsTotal = new Counter({
  name: 'estateai_ai_recommendation_agent_recommendations_total',
  help: 'Total recommendations surfaced across all Recommendation Agent runs',
  registers: [metricsRegistry],
});

const handoffsTotal = new Counter({
  name: 'estateai_ai_recommendation_agent_handoffs_total',
  help: 'Total cross-agent handoffs consumed by the Recommendation Agent, by source agent and origin',
  labelNames: ['agentId', 'origin'] as const,
  registers: [metricsRegistry],
});

const toolCallsTotal = new Counter({
  name: 'estateai_ai_recommendation_agent_tool_calls_total',
  help: 'Total Recommendation Agent tool calls, by tool name and outcome',
  labelNames: ['tool', 'success'] as const,
  registers: [metricsRegistry],
});

const toolCallDurationSeconds = new Histogram({
  name: 'estateai_ai_recommendation_agent_tool_call_duration_seconds',
  help: 'Recommendation Agent tool call latency in seconds, by tool name',
  labelNames: ['tool'] as const,
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2.5, 5, 10, 30, 60],
  registers: [metricsRegistry],
});

const llmCallDurationSeconds = new Histogram({
  name: 'estateai_ai_recommendation_agent_llm_duration_seconds',
  help: 'Recommendation Agent LLM call latency in seconds',
  buckets: [0.1, 0.5, 1, 2.5, 5, 10, 30, 60],
  registers: [metricsRegistry],
});

const tokenUsageTotal = new Counter({
  name: 'estateai_ai_recommendation_agent_llm_tokens_total',
  help: 'Total LLM tokens consumed by the Recommendation Agent, by kind',
  labelNames: ['kind'] as const,
  registers: [metricsRegistry],
});

const retriesTotal = new Counter({
  name: 'estateai_ai_recommendation_agent_retries_total',
  help: 'Total retry attempts made by the Recommendation Agent before success or exhaustion',
  registers: [metricsRegistry],
});

export class RecommendationAgentTelemetry {
  recordRun(input: { status: string; durationMs: number; recommendationCount: number }): void {
    runsTotal.inc({ status: input.status });
    runDurationSeconds.observe(input.durationMs / 1000);
    recommendationsTotal.inc(input.recommendationCount);
    logger.info(
      { status: input.status, durationMs: input.durationMs, count: input.recommendationCount },
      'recommendation_agent.run',
    );
  }

  recordHandoff(input: { agentId: string; origin: string }): void {
    handoffsTotal.inc({ agentId: input.agentId, origin: input.origin });
  }

  recordToolCall(input: { tool: string; success: boolean; durationMs: number }): void {
    toolCallsTotal.inc({ tool: input.tool, success: String(input.success) });
    toolCallDurationSeconds.observe({ tool: input.tool }, input.durationMs / 1000);
    if (!input.success) {
      logger.error(
        { tool: input.tool, durationMs: input.durationMs },
        'recommendation_agent.tool_call_failed',
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

export const recommendationAgentTelemetry = new RecommendationAgentTelemetry();
