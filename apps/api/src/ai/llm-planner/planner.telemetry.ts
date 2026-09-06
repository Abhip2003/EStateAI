import { Counter, Histogram } from 'prom-client';
import { metricsRegistry } from '../../observability/metrics.js';
import { logger } from '../../observability/logger.js';

// `estateai_ai_llm_planner_*` — mirrors ai/langgraph/graph.telemetry.ts's
// own naming/registration convention. Spec #10: prompt tokens, completion
// tokens, latency, cache hit, iterations, confidence, reasoning length.
const promptTokens = new Histogram({
  name: 'estateai_ai_llm_planner_prompt_tokens',
  help: 'Prompt tokens per LLM Planner call',
  buckets: [50, 100, 250, 500, 1000, 2000, 4000],
  registers: [metricsRegistry],
});

const completionTokens = new Histogram({
  name: 'estateai_ai_llm_planner_completion_tokens',
  help: 'Completion tokens per LLM Planner call',
  buckets: [50, 100, 250, 500, 1000, 2000, 4000],
  registers: [metricsRegistry],
});

const latencySeconds = new Histogram({
  name: 'estateai_ai_llm_planner_latency_seconds',
  help: 'End-to-end latency of one LLM Planner planning call',
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [metricsRegistry],
});

const cacheHitsTotal = new Counter({
  name: 'estateai_ai_llm_planner_cache_hits_total',
  help: 'Total LLM Planner calls served from cache vs generated fresh',
  labelNames: ['hit'] as const,
  registers: [metricsRegistry],
});

const iterationsHistogram = new Histogram({
  name: 'estateai_ai_llm_planner_iterations',
  help: 'Planning iterations used per run (reflection-driven revisions), 1-3',
  buckets: [1, 2, 3],
  registers: [metricsRegistry],
});

const confidenceHistogram = new Histogram({
  name: 'estateai_ai_llm_planner_confidence',
  help: 'overallConfidence of the accepted plan',
  buckets: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1],
  registers: [metricsRegistry],
});

const reasoningLengthHistogram = new Histogram({
  name: 'estateai_ai_llm_planner_reasoning_length_chars',
  help: "Character length of the plan's reasoning field",
  buckets: [50, 100, 250, 500, 1000, 2000],
  registers: [metricsRegistry],
});

export class PlannerTelemetry {
  recordPlan(input: {
    source: string;
    cacheHit: boolean;
    iterations: number;
    promptTokens: number;
    completionTokens: number;
    latencyMs: number;
    confidence: number;
    reasoningLength: number;
  }): void {
    promptTokens.observe(input.promptTokens);
    completionTokens.observe(input.completionTokens);
    latencySeconds.observe(input.latencyMs / 1000);
    cacheHitsTotal.inc({ hit: String(input.cacheHit) });
    iterationsHistogram.observe(input.iterations);
    confidenceHistogram.observe(input.confidence);
    reasoningLengthHistogram.observe(input.reasoningLength);
    logger.info(
      {
        source: input.source,
        cacheHit: input.cacheHit,
        iterations: input.iterations,
        confidence: input.confidence,
      },
      'llm-planner.plan',
    );
  }
}

export const plannerTelemetry = new PlannerTelemetry();
