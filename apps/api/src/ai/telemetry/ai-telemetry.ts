import { Counter, Histogram } from 'prom-client';
import { metricsRegistry } from '../../observability/metrics.js';
import { logger } from '../../observability/logger.js';
import type {
  AITelemetryRecorder,
  LLMCallTelemetry,
  ToolExecutionTelemetry,
} from '../interfaces/telemetry.interface.js';

// Registers into the same shared `metricsRegistry` GET /metrics already
// serializes (observability/metrics.ts) — so these show up on the
// existing endpoint for free — but under a distinct `estateai_ai_foundation_`
// prefix so they never collide with the pre-existing `estateai_ai_*`
// metrics services/ai/ai.service.ts already registers (ai_requests_total,
// ai_request_duration_seconds, ai_tokens_total, ai_failures_total).
const llmCallsTotal = new Counter({
  name: 'estateai_ai_foundation_llm_calls_total',
  help: 'Total LLM calls made through src/ai/llm/LLMClient, by provider/model/outcome',
  labelNames: ['provider', 'model', 'success'] as const,
  registers: [metricsRegistry],
});

const llmCallDurationSeconds = new Histogram({
  name: 'estateai_ai_foundation_llm_call_duration_seconds',
  help: 'LLM call latency in seconds, as measured by src/ai/llm/LLMClient',
  labelNames: ['provider', 'model'] as const,
  buckets: [0.1, 0.5, 1, 2.5, 5, 10, 20, 30, 60],
  registers: [metricsRegistry],
});

const llmTokensTotal = new Counter({
  name: 'estateai_ai_foundation_llm_tokens_total',
  help: 'Total prompt/completion tokens consumed through LLMClient',
  labelNames: ['provider', 'model', 'kind'] as const,
  registers: [metricsRegistry],
});

const llmRetriesTotal = new Counter({
  name: 'estateai_ai_foundation_llm_retries_total',
  help: 'Total retry attempts made by LLMClient before success or exhaustion',
  labelNames: ['provider', 'model'] as const,
  registers: [metricsRegistry],
});

const toolExecutionsTotal = new Counter({
  name: 'estateai_ai_foundation_tool_executions_total',
  help: 'Total tool executions through src/ai/tools/ToolRegistry, by outcome',
  labelNames: ['tool', 'success'] as const,
  registers: [metricsRegistry],
});

const toolExecutionDurationSeconds = new Histogram({
  name: 'estateai_ai_foundation_tool_execution_duration_seconds',
  help: 'Tool execution latency in seconds',
  labelNames: ['tool'] as const,
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2.5, 5, 10],
  registers: [metricsRegistry],
});

// The concrete AITelemetryRecorder used in production: Prometheus
// counters/histograms for dashboards/alerts, plus structured pino logs
// (via the same shared `logger` every other non-request-scoped module
// uses) for per-call debugging. A test double implementing the same
// interface can replace this in unit tests without touching LLMClient/
// ToolRegistry.
export class AITelemetry implements AITelemetryRecorder {
  recordLLMCall(telemetry: LLMCallTelemetry): void {
    const successLabel = telemetry.success ? 'true' : 'false';
    llmCallsTotal.inc({
      provider: telemetry.provider,
      model: telemetry.model,
      success: successLabel,
    });
    llmCallDurationSeconds.observe(
      { provider: telemetry.provider, model: telemetry.model },
      telemetry.latencyMs / 1000,
    );
    llmTokensTotal.inc(
      { provider: telemetry.provider, model: telemetry.model, kind: 'prompt' },
      telemetry.promptTokens,
    );
    llmTokensTotal.inc(
      { provider: telemetry.provider, model: telemetry.model, kind: 'completion' },
      telemetry.completionTokens,
    );
    if (telemetry.retryCount > 0) {
      llmRetriesTotal.inc(
        { provider: telemetry.provider, model: telemetry.model },
        telemetry.retryCount,
      );
    }

    const logFields = {
      provider: telemetry.provider,
      model: telemetry.model,
      latencyMs: telemetry.latencyMs,
      promptTokens: telemetry.promptTokens,
      completionTokens: telemetry.completionTokens,
      estimatedCostUsd: telemetry.estimatedCostUsd,
      retryCount: telemetry.retryCount,
    };
    if (telemetry.success) {
      logger.info(logFields, 'ai.llm_call');
    } else {
      logger.error({ ...logFields, errorType: telemetry.errorType }, 'ai.llm_call_failed');
    }
  }

  recordToolExecution(telemetry: ToolExecutionTelemetry): void {
    const successLabel = telemetry.success ? 'true' : 'false';
    toolExecutionsTotal.inc({ tool: telemetry.toolName, success: successLabel });
    toolExecutionDurationSeconds.observe({ tool: telemetry.toolName }, telemetry.durationMs / 1000);

    if (telemetry.success) {
      logger.info(
        { tool: telemetry.toolName, durationMs: telemetry.durationMs },
        'ai.tool_execution',
      );
    } else {
      logger.error(
        {
          tool: telemetry.toolName,
          durationMs: telemetry.durationMs,
          errorType: telemetry.errorType,
        },
        'ai.tool_execution_failed',
      );
    }
  }
}

export const aiTelemetry = new AITelemetry();
