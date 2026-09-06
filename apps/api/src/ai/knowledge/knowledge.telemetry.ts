import { Counter, Histogram } from 'prom-client';
import { metricsRegistry } from '../../observability/metrics.js';
import { logger } from '../../observability/logger.js';

// `estateai_ai_knowledge_*` — indexing-side metrics for the Knowledge
// Store (Phase 23). Retrieval-side metrics live in
// ai/retrieval/retrieval.telemetry.ts — indexing (write path) and
// retrieval (read path) are separate call sites with separate volumes.
const documentsIndexedTotal = new Counter({
  name: 'estateai_ai_knowledge_documents_indexed_total',
  help: 'Total KnowledgeDocument rows indexed (created or updated), by agent and documentType',
  labelNames: ['agent', 'documentType'] as const,
  registers: [metricsRegistry],
});

const indexDurationSeconds = new Histogram({
  name: 'estateai_ai_knowledge_index_duration_seconds',
  help: 'Time to embed + upsert one batch of documents, in seconds',
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2.5, 5, 10],
  registers: [metricsRegistry],
});

const indexFailuresTotal = new Counter({
  name: 'estateai_ai_knowledge_index_failures_total',
  help: 'Total indexing failures, by agent — indexing failures never fail the agent run itself',
  labelNames: ['agent'] as const,
  registers: [metricsRegistry],
});

export class KnowledgeTelemetry {
  recordIndexed(input: {
    agent: string;
    documentType: string;
    count: number;
    durationMs: number;
  }): void {
    documentsIndexedTotal.inc(
      { agent: input.agent, documentType: input.documentType },
      input.count,
    );
    indexDurationSeconds.observe(input.durationMs / 1000);
  }

  recordFailure(agent: string, error: unknown): void {
    indexFailuresTotal.inc({ agent });
    logger.error({ agent, err: error }, 'knowledge.index_failed');
  }
}

export const knowledgeTelemetry = new KnowledgeTelemetry();
