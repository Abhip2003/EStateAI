import { Counter, Histogram } from 'prom-client';
import { metricsRegistry } from '../../observability/metrics.js';
import { logger } from '../../observability/logger.js';

// `estateai_ai_embedding_*` — metrics for the embedding layer shared by
// every indexing/retrieval call site (KnowledgeStore, RetrievalService,
// Copilot grounding), not scoped to a single agent like the
// `*_agent_*` families.
const callsTotal = new Counter({
  name: 'estateai_ai_embedding_calls_total',
  help: 'Total embedding provider calls, by provider and outcome',
  labelNames: ['provider', 'success'] as const,
  registers: [metricsRegistry],
});

const callDurationSeconds = new Histogram({
  name: 'estateai_ai_embedding_call_duration_seconds',
  help: 'Embedding provider call latency in seconds',
  labelNames: ['provider'] as const,
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2.5, 5, 10],
  registers: [metricsRegistry],
});

const textsEmbeddedTotal = new Counter({
  name: 'estateai_ai_embedding_texts_total',
  help: 'Total individual texts embedded, by provider',
  labelNames: ['provider'] as const,
  registers: [metricsRegistry],
});

export class EmbeddingTelemetry {
  recordCall(input: {
    provider: string;
    success: boolean;
    durationMs: number;
    count: number;
  }): void {
    callsTotal.inc({ provider: input.provider, success: String(input.success) });
    callDurationSeconds.observe({ provider: input.provider }, input.durationMs / 1000);
    if (input.success) textsEmbeddedTotal.inc({ provider: input.provider }, input.count);
    if (!input.success) {
      logger.error(
        { provider: input.provider, durationMs: input.durationMs },
        'embedding.call_failed',
      );
    }
  }
}

export const embeddingTelemetry = new EmbeddingTelemetry();
