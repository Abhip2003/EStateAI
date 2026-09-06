import type { KnowledgeStore } from '../knowledge/index.js';
import type { Episode } from './episode.types.js';
import { buildEpisodeSummaryText } from './episode.summary.js';

// Episode Indexing (spec #3) — reuses the existing KnowledgeStore
// (embeddings + pgvector storage) rather than standing up a second
// vector database. Episodes are indexed as documentType 'EPISODE'
// (added additively to the KnowledgeDocumentType enum), with
// `sourceId: episode.episodeId` so episode.search.ts can map a retrieved
// KnowledgeDocument back to its full Episode via EpisodeStore.
export class EpisodeIndexer {
  constructor(private readonly knowledge: KnowledgeStore) {}

  async index(episode: Episode): Promise<void> {
    if (!episode.assetId) return;
    await this.knowledge.indexDocument({
      assetId: episode.assetId,
      agent: 'episodic-memory',
      documentType: 'EPISODE',
      text: buildEpisodeSummaryText(episode),
      metadata: {
        episodeId: episode.episodeId,
        goal: episode.goal,
        outcome: episode.outcome,
        confidence: episode.confidence,
      },
      tags: episode.agentsInvolved,
      sourceId: episode.episodeId,
    });
  }
}
