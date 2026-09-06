import { redis } from '../../cache/redis.js';
import { RedisMemoryStore } from '../memory/redis-memory-store.js';
import { knowledgeStore } from '../knowledge/index.js';
import { retrievalService } from '../retrieval/index.js';
import { EpisodeStore } from './episode.store.js';
import { EpisodeIndexer } from './episode.indexer.js';
import { EpisodeSearch } from './episode.search.js';
import { EpisodeExtractor } from './episode.extractor.js';
import { EpisodePruner } from './episode.pruner.js';
import { episodeTelemetry } from './episode.telemetry.js';

// Composition root — same "process-wide instance" pattern as
// ai/debate/debate.ts / ai/planner/reasoning.ts. A single Redis-backed
// MemoryStore instance is shared by the record/history store and the
// pruner's archive store (both namespace their own keys, so sharing the
// underlying store is safe and avoids a second connection).
const memoryStore = new RedisMemoryStore(redis);

export const episodeStore = new EpisodeStore(memoryStore);
export const episodeIndexer = new EpisodeIndexer(knowledgeStore);
export const episodeSearch = new EpisodeSearch(
  retrievalService,
  knowledgeStore,
  episodeStore,
  episodeTelemetry,
);
export const episodeExtractor = new EpisodeExtractor(
  episodeStore,
  episodeIndexer,
  episodeTelemetry,
);
export const episodePruner = new EpisodePruner(episodeStore, memoryStore);

export interface EpisodicMemoryFoundation {
  store: EpisodeStore;
  indexer: EpisodeIndexer;
  search: EpisodeSearch;
  extractor: EpisodeExtractor;
  pruner: EpisodePruner;
  telemetry: typeof episodeTelemetry;
}

export const episodicMemoryFoundation: EpisodicMemoryFoundation = {
  store: episodeStore,
  indexer: episodeIndexer,
  search: episodeSearch,
  extractor: episodeExtractor,
  pruner: episodePruner,
  telemetry: episodeTelemetry,
};
