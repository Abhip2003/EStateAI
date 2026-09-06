import { Counter, Histogram } from 'prom-client';
import { metricsRegistry } from '../../observability/metrics.js';

// `estateai_ai_retrieval_*` — read-path metrics, separate from the
// write-path `estateai_ai_knowledge_*` family in knowledge.telemetry.ts.
const searchesTotal = new Counter({
  name: 'estateai_ai_retrieval_searches_total',
  help: 'Total semantic retrieval searches performed',
  registers: [metricsRegistry],
});

const searchDurationSeconds = new Histogram({
  name: 'estateai_ai_retrieval_search_duration_seconds',
  help: 'Semantic retrieval search latency in seconds (embed query + vector search)',
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2.5, 5, 10],
  registers: [metricsRegistry],
});

const documentsReturnedTotal = new Counter({
  name: 'estateai_ai_retrieval_documents_returned_total',
  help: 'Total documents returned across all retrieval searches',
  registers: [metricsRegistry],
});

export class RetrievalTelemetry {
  recordSearch(input: { durationMs: number; documentCount: number }): void {
    searchesTotal.inc();
    searchDurationSeconds.observe(input.durationMs / 1000);
    documentsReturnedTotal.inc(input.documentCount);
  }
}

export const retrievalTelemetry = new RetrievalTelemetry();
