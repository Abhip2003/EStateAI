import { Counter, Histogram } from 'prom-client';
import { metricsRegistry } from '../../../observability/metrics.js';
import { logger } from '../../../observability/logger.js';

// Distinct `estateai_ai_compliance_agent_*` prefix — separate from
// `estateai_ai_risk_agent_*` (Phase 19), `estateai_ai_discovery_agent_*`
// (Phase 18), and `estateai_ai_orchestrator_*` (Phase 17, which also
// records a generic step duration/outcome whenever this agent runs as an
// orchestrator step). This family measures the Compliance Agent layer
// specifically: run duration, frameworks evaluated, controls checked,
// violations, tool-call latency, LLM latency/token usage, and retries.
const runsTotal = new Counter({
  name: 'estateai_ai_compliance_agent_runs_total',
  help: 'Total Compliance Agent runs, by outcome status',
  labelNames: ['status'] as const,
  registers: [metricsRegistry],
});

const runDurationSeconds = new Histogram({
  name: 'estateai_ai_compliance_agent_duration_seconds',
  help: 'Compliance Agent end-to-end run duration in seconds',
  buckets: [0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 120],
  registers: [metricsRegistry],
});

const frameworksEvaluatedTotal = new Counter({
  name: 'estateai_ai_compliance_agent_frameworks_evaluated_total',
  help: 'Total framework evaluations performed across all Compliance Agent runs',
  labelNames: ['framework'] as const,
  registers: [metricsRegistry],
});

const controlsCheckedTotal = new Counter({
  name: 'estateai_ai_compliance_agent_controls_checked_total',
  help: 'Total controls checked across all Compliance Agent runs, by status',
  labelNames: ['status'] as const,
  registers: [metricsRegistry],
});

const violationsTotal = new Counter({
  name: 'estateai_ai_compliance_agent_violations_total',
  help: 'Total failed-control violations surfaced across all Compliance Agent runs',
  registers: [metricsRegistry],
});

const toolCallsTotal = new Counter({
  name: 'estateai_ai_compliance_agent_tool_calls_total',
  help: 'Total Compliance Agent tool calls, by tool name and outcome',
  labelNames: ['tool', 'success'] as const,
  registers: [metricsRegistry],
});

const toolCallDurationSeconds = new Histogram({
  name: 'estateai_ai_compliance_agent_tool_call_duration_seconds',
  help: 'Compliance Agent tool call latency in seconds, by tool name',
  labelNames: ['tool'] as const,
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2.5, 5, 10, 30, 60],
  registers: [metricsRegistry],
});

const llmCallDurationSeconds = new Histogram({
  name: 'estateai_ai_compliance_agent_llm_duration_seconds',
  help: 'Compliance Agent LLM call latency in seconds (summary and gap-explanation calls)',
  buckets: [0.1, 0.5, 1, 2.5, 5, 10, 30, 60],
  registers: [metricsRegistry],
});

const tokenUsageTotal = new Counter({
  name: 'estateai_ai_compliance_agent_llm_tokens_total',
  help: 'Total LLM tokens consumed by the Compliance Agent, by kind',
  labelNames: ['kind'] as const,
  registers: [metricsRegistry],
});

const retriesTotal = new Counter({
  name: 'estateai_ai_compliance_agent_retries_total',
  help: 'Total retry attempts made by the Compliance Agent before success or exhaustion',
  registers: [metricsRegistry],
});

export class ComplianceAgentTelemetry {
  recordRun(input: {
    status: string;
    durationMs: number;
    frameworks: { framework: string; passed: number; failed: number; missing: number }[];
  }): void {
    runsTotal.inc({ status: input.status });
    runDurationSeconds.observe(input.durationMs / 1000);
    for (const framework of input.frameworks) {
      frameworksEvaluatedTotal.inc({ framework: framework.framework });
      controlsCheckedTotal.inc({ status: 'PASS' }, framework.passed);
      controlsCheckedTotal.inc({ status: 'FAIL' }, framework.failed);
      controlsCheckedTotal.inc({ status: 'MISSING' }, framework.missing);
      violationsTotal.inc(framework.failed);
    }
    logger.info(
      {
        status: input.status,
        durationMs: input.durationMs,
        frameworkCount: input.frameworks.length,
      },
      'compliance_agent.run',
    );
  }

  recordToolCall(input: { tool: string; success: boolean; durationMs: number }): void {
    toolCallsTotal.inc({ tool: input.tool, success: String(input.success) });
    toolCallDurationSeconds.observe({ tool: input.tool }, input.durationMs / 1000);
    if (!input.success) {
      logger.error(
        { tool: input.tool, durationMs: input.durationMs },
        'compliance_agent.tool_call_failed',
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

export const complianceAgentTelemetry = new ComplianceAgentTelemetry();
