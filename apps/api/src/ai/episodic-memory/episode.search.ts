import type { KnowledgeStore } from '../knowledge/index.js';
import type { RetrievalService } from '../retrieval/retrieval.service.js';
import type { EpisodeStore } from './episode.store.js';
import type { EpisodeTelemetry } from './episode.telemetry.js';
import type { EpisodeSearchInput, EpisodeSearchMatch } from './episode.types.js';

const DEFAULT_TOP_K = 5;

// Episode Search (spec #3/#4) — semantic search over indexed episodes via
// the existing RetrievalService (no new search infrastructure). A
// RetrievedDocument only carries the KnowledgeDocument's own id/score, so
// each hit is resolved back to its full Episode via
// KnowledgeStore.getDocument().sourceId (== episode.episodeId, set at
// index time by EpisodeIndexer) -> EpisodeStore.get().
export class EpisodeSearch {
  constructor(
    private readonly retrieval: RetrievalService,
    private readonly knowledge: KnowledgeStore,
    private readonly store: EpisodeStore,
    private readonly telemetry: EpisodeTelemetry,
  ) {}

  async search(input: EpisodeSearchInput): Promise<EpisodeSearchMatch[]> {
    const startedAt = Date.now();
    const result = await this.retrieval.search({
      question: input.goal,
      assetId: input.assetId,
      documentTypes: ['EPISODE'],
      topK: input.topK ?? DEFAULT_TOP_K,
    });

    const matches: EpisodeSearchMatch[] = [];
    for (const doc of result.documents) {
      const record = await this.knowledge.getDocument(doc.id);
      const episodeId = record?.sourceId;
      if (!episodeId) continue;
      const episode = await this.store.get(episodeId);
      if (!episode) continue;
      matches.push({ episode, score: doc.score });
    }

    this.telemetry.recordRetrieval({
      latencyMs: Date.now() - startedAt,
      matchCount: matches.length,
      requested: result.documents.length,
    });

    return matches;
  }
}
