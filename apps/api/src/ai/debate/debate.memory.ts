import { redis } from '../../cache/redis.js';
import { RedisMemoryStore } from '../memory/redis-memory-store.js';
import type { MemoryStore } from '../interfaces/memory-store.interface.js';
import type { DebateRecord } from './debate.types.js';

const RECORD_KEY_PREFIX = 'debate:record:';
const HISTORY_KEY_PREFIX = 'debate:history:';
const TTL_SECONDS = 60 * 60 * 24 * 7; // 7d, matches every other Phase 25+ store's retention window

// Spec #7 — "Store debate history and consensus history. Reuse existing
// memory infrastructure." Backed by the same injected MemoryStore pattern
// (Redis in production) every other store in this codebase already uses,
// not a new memory tier: get/set for GET /ai/debate/:id, append/getList
// for an asset's own debate history.
export class DebateMemory {
  constructor(private readonly store: MemoryStore) {}

  async save(record: DebateRecord): Promise<void> {
    await this.store.set(`${RECORD_KEY_PREFIX}${record.debateId}`, record, TTL_SECONDS);
    await this.store.append(`${HISTORY_KEY_PREFIX}${record.assetId}`, record.debateId, TTL_SECONDS);
  }

  async get(debateId: string): Promise<DebateRecord | undefined> {
    return this.store.get<DebateRecord>(`${RECORD_KEY_PREFIX}${debateId}`);
  }

  async getHistoryIds(assetId: string): Promise<string[]> {
    return this.store.getList<string>(`${HISTORY_KEY_PREFIX}${assetId}`);
  }

  async getHistory(assetId: string, limit = 20): Promise<DebateRecord[]> {
    const ids = await this.getHistoryIds(assetId);
    const recent = ids.slice(-limit);
    const records = await Promise.all(recent.map((id) => this.get(id)));
    return records.filter((record): record is DebateRecord => record !== undefined).reverse();
  }
}

export const debateMemory = new DebateMemory(new RedisMemoryStore(redis));
