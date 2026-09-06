import { Counter, Histogram } from 'prom-client';
import { metricsRegistry } from '../../../observability/metrics.js';
import { logger } from '../../../observability/logger.js';

// `estateai_ai_copilot_agent_*` — the sixth per-agent metric family
// (Discovery/Risk/Compliance/Recommendation/Report/Copilot). Adds an
// `intent` label on runs (which question types are actually being
// asked) and a `workflows_triggered_total` counter (how often
// Intelligent Routing had to run a workflow before it could answer) —
// neither concept exists in any prior agent's telemetry.
const runsTotal = new Counter({
  name: 'estateai_ai_copilot_agent_runs_total',
  help: 'Total Copilot Agent runs, by outcome status and intent',
  labelNames: ['status', 'intent'] as const,
  registers: [metricsRegistry],
});

const runDurationSeconds = new Histogram({
  name: 'estateai_ai_copilot_agent_duration_seconds',
  help: 'Copilot Agent end-to-end run duration in seconds',
  buckets: [0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 120],
  registers: [metricsRegistry],
});

const workflowsTriggeredTotal = new Counter({
  name: 'estateai_ai_copilot_agent_workflows_triggered_total',
  help: 'Total workflows auto-triggered by Copilot Intelligent Routing, by workflowId',
  labelNames: ['workflowId'] as const,
  registers: [metricsRegistry],
});

const toolCallsTotal = new Counter({
  name: 'estateai_ai_copilot_agent_tool_calls_total',
  help: 'Total Copilot Agent tool calls, by tool name and outcome',
  labelNames: ['tool', 'success'] as const,
  registers: [metricsRegistry],
});

const toolCallDurationSeconds = new Histogram({
  name: 'estateai_ai_copilot_agent_tool_call_duration_seconds',
  help: 'Copilot Agent tool call latency in seconds, by tool name',
  labelNames: ['tool'] as const,
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2.5, 5, 10, 30, 60],
  registers: [metricsRegistry],
});

const llmCallDurationSeconds = new Histogram({
  name: 'estateai_ai_copilot_agent_llm_duration_seconds',
  help: 'Copilot Agent LLM call latency in seconds',
  buckets: [0.1, 0.5, 1, 2.5, 5, 10, 30, 60],
  registers: [metricsRegistry],
});

const tokenUsageTotal = new Counter({
  name: 'estateai_ai_copilot_agent_llm_tokens_total',
  help: 'Total LLM tokens consumed by the Copilot Agent, by kind',
  labelNames: ['kind'] as const,
  registers: [metricsRegistry],
});

const retriesTotal = new Counter({
  name: 'estateai_ai_copilot_agent_retries_total',
  help: 'Total retry attempts made by the Copilot Agent before success or exhaustion',
  registers: [metricsRegistry],
});

export class CopilotAgentTelemetry {
  recordRun(input: { status: string; intent: string; durationMs: number }): void {
    runsTotal.inc({ status: input.status, intent: input.intent });
    runDurationSeconds.observe(input.durationMs / 1000);
    logger.info(
      { status: input.status, intent: input.intent, durationMs: input.durationMs },
      'copilot_agent.run',
    );
  }

  recordWorkflowTriggered(workflowId: string): void {
    workflowsTriggeredTotal.inc({ workflowId });
  }

  recordToolCall(input: { tool: string; success: boolean; durationMs: number }): void {
    toolCallsTotal.inc({ tool: input.tool, success: String(input.success) });
    toolCallDurationSeconds.observe({ tool: input.tool }, input.durationMs / 1000);
    if (!input.success) {
      logger.error(
        { tool: input.tool, durationMs: input.durationMs },
        'copilot_agent.tool_call_failed',
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

export const copilotAgentTelemetry = new CopilotAgentTelemetry();
