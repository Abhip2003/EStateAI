import type { MemoryStore } from '../../interfaces/memory-store.interface.js';
import type { IRecommendationMemory } from './recommendation.interface.js';
import type {
  RecommendationSummaryRecord,
  RecommendationFailureRecord,
} from './recommendation.types.js';

const HISTORY_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days
const DEFAULT_HISTORY_LIMIT = 50;
const DEFAULT_FAILURE_LIMIT = 50;

export class RecommendationMemory implements IRecommendationMemory {
  constructor(private readonly store: MemoryStore) {}

  private historyKey(assetId: string): string {
    return `recommendation-agent:history:${assetId}`;
  }
  private lastRunKey(assetId: string): string {
    return `recommendation-agent:last-run:${assetId}`;
  }
  private failuresKey(assetId: string): string {
    return `recommendation-agent:failures:${assetId}`;
  }

  async recordRun(record: RecommendationSummaryRecord): Promise<void> {
    await Promise.all([
      this.store.append(this.historyKey(record.assetId), record, HISTORY_TTL_SECONDS),
      this.store.set(this.lastRunKey(record.assetId), record, HISTORY_TTL_SECONDS),
    ]);
  }

  async getLastRun(assetId: string): Promise<RecommendationSummaryRecord | undefined> {
    return this.store.get<RecommendationSummaryRecord>(this.lastRunKey(assetId));
  }

  async getHistory(
    assetId: string,
    limit: number = DEFAULT_HISTORY_LIMIT,
  ): Promise<RecommendationSummaryRecord[]> {
    const all = await this.store.getList<RecommendationSummaryRecord>(this.historyKey(assetId));
    return all.slice(-limit).reverse();
  }

  async recordFailure(record: RecommendationFailureRecord): Promise<void> {
    await this.store.append(this.failuresKey(record.assetId), record, HISTORY_TTL_SECONDS);
  }

  async getFailures(
    assetId: string,
    limit: number = DEFAULT_FAILURE_LIMIT,
  ): Promise<RecommendationFailureRecord[]> {
    const all = await this.store.getList<RecommendationFailureRecord>(this.failuresKey(assetId));
    return all.slice(-limit).reverse();
  }
}
