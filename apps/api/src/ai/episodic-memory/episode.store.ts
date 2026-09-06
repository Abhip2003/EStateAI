import type { MemoryStore } from '../interfaces/memory-store.interface.js';
import type { Episode } from './episode.types.js';

const RECORD_PREFIX = 'episode:record:';
const HISTORY_PREFIX = 'episode:history:';
const GLOBAL_HISTORY_KEY = 'episode:history:__all__';

// 7d — matches the DebateMemory/ConsensusStore/PlanStore convention
// (src/ai/debate/debate.memory.ts) for non-audit stores in this codebase.
export const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 7;

function historyKey(assetId: string): string {
  return `${HISTORY_PREFIX}${assetId}`;
}

// Same injected-MemoryStore pattern every Phase 25+ store in this
// codebase uses (DebateMemory, ConsensusStore, PlanStore, ReflectionStore
// — src/ai/debate/debate.memory.ts). History lists are kept as a plain
// JSON array under `set` (read-modify-write) rather than MemoryStore's
// `append`/`getList` Redis-list primitives, deliberately — pruning
// (episode.pruner.ts, spec #8) needs to remove arbitrary ids from the
// middle of a history, which `append` gives no way to do; a JSON array
// can be rewritten freely.
export class EpisodeStore {
  constructor(
    private readonly store: MemoryStore,
    private readonly ttlSeconds: number = DEFAULT_TTL_SECONDS,
  ) {}

  async save(episode: Episode): Promise<void> {
    await this.store.set(RECORD_PREFIX + episode.episodeId, episode, this.ttlSeconds);
    if (episode.assetId) {
      await this.appendToHistory(historyKey(episode.assetId), episode.episodeId);
    }
    await this.appendToHistory(GLOBAL_HISTORY_KEY, episode.episodeId);
  }

  async get(episodeId: string): Promise<Episode | undefined> {
    return this.store.get<Episode>(RECORD_PREFIX + episodeId);
  }

  async getHistoryIds(assetId: string): Promise<string[]> {
    return (await this.store.get<string[]>(historyKey(assetId))) ?? [];
  }

  async getHistory(assetId: string, limit: number = 20): Promise<Episode[]> {
    const ids = await this.getHistoryIds(assetId);
    const slice = ids.slice(-limit).reverse();
    const episodes = await Promise.all(slice.map((id) => this.get(id)));
    return episodes.filter((episode): episode is Episode => episode !== undefined);
  }

  async getAllHistoryIds(): Promise<string[]> {
    return (await this.store.get<string[]>(GLOBAL_HISTORY_KEY)) ?? [];
  }

  async setHistoryIds(assetId: string, ids: string[]): Promise<void> {
    await this.store.set(historyKey(assetId), ids, this.ttlSeconds);
  }

  async setGlobalHistoryIds(ids: string[]): Promise<void> {
    await this.store.set(GLOBAL_HISTORY_KEY, ids, this.ttlSeconds);
  }

  async delete(episodeId: string, assetId?: string): Promise<void> {
    await this.store.delete(RECORD_PREFIX + episodeId);
    if (assetId) {
      await this.removeFromHistory(historyKey(assetId), episodeId);
    }
    await this.removeFromHistory(GLOBAL_HISTORY_KEY, episodeId);
  }

  private async appendToHistory(key: string, id: string): Promise<void> {
    const existing = (await this.store.get<string[]>(key)) ?? [];
    existing.push(id);
    await this.store.set(key, existing, this.ttlSeconds);
  }

  private async removeFromHistory(key: string, id: string): Promise<void> {
    const existing = (await this.store.get<string[]>(key)) ?? [];
    await this.store.set(
      key,
      existing.filter((existingId) => existingId !== id),
      this.ttlSeconds,
    );
  }
}
