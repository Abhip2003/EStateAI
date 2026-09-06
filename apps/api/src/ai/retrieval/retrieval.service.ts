import { prisma } from '../../db/prisma.js';
import type { EmbeddingService } from '../embeddings/embedding.service.js';
import { knowledgeRepository } from '../knowledge/knowledge.repository.js';
import type { RetrievalTelemetry } from './retrieval.telemetry.js';
import type { RetrievalQuery, RetrievalResult } from './retrieval.types.js';

const DEFAULT_TOP_K = 5;

// The Retrieval Service — semantic search over the Knowledge Store.
// Embeds the question, runs pgvector cosine search via
// KnowledgeRepository, and records a RetrievalTrace row (document ids,
// similarity scores, latency, embedding version) for every query, per
// the spec's "Retrieval Trace" requirement (#9). Copilot grounding
// (copilot.executor.ts) and `POST /knowledge/search` are both thin
// callers of this one class.
export class RetrievalService {
  constructor(
    private readonly embeddingService: EmbeddingService,
    private readonly telemetry?: RetrievalTelemetry,
  ) {}

  async search(query: RetrievalQuery): Promise<RetrievalResult> {
    const startedAt = Date.now();
    const topK = query.topK ?? DEFAULT_TOP_K;

    const { embedding, embeddingVersion } = await this.embeddingService.embed(query.question);

    const rows = await knowledgeRepository.search(
      embedding,
      {
        assetId: query.assetId,
        documentTypes: query.documentTypes,
        agent: query.agent,
        tags: query.tags,
      },
      topK,
    );

    const latencyMs = Date.now() - startedAt;
    const documents = rows.map((row) => ({
      id: row.id,
      agent: row.agent,
      documentType: row.documentType,
      text: row.text,
      score: row.score,
      createdAt: row.createdAt,
    }));

    await this.recordTrace(query, documents, embeddingVersion, latencyMs);
    this.telemetry?.recordSearch({ durationMs: latencyMs, documentCount: documents.length });

    return { documents, embeddingVersion, latencyMs };
  }

  private async recordTrace(
    query: RetrievalQuery,
    documents: RetrievalResult['documents'],
    embeddingVersion: string,
    latencyMs: number,
  ): Promise<void> {
    try {
      await prisma.retrievalTrace.create({
        data: {
          conversationId: query.conversationId,
          assetId: query.assetId,
          query: query.question,
          documentIds: documents.map((doc) => doc.id),
          scores: documents.map((doc) => doc.score),
          latencyMs,
          embeddingVersion,
        },
      });
    } catch {
      // Trace persistence is observability, not correctness — a failed
      // trace write must never fail (or even delay) the caller's actual
      // retrieval result, mirroring how AgentExecutionHistory failures
      // don't roll back the orchestrator run elsewhere in this codebase.
    }
  }
}
