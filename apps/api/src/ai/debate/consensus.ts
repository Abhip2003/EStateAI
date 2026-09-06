import { redis } from '../../cache/redis.js';
import { RedisMemoryStore } from '../memory/redis-memory-store.js';
import type { MemoryStore } from '../interfaces/memory-store.interface.js';
import type { ConsensusReport } from './consensus.types.js';

const KEY_PREFIX = 'debate:consensus:';
const TTL_SECONDS = 60 * 60 * 24 * 7; // 7d — matches PlanStore/ReflectionStore's retention window

// Persists ConsensusReports for GET /ai/consensus/:id, backed by the same
// injected MemoryStore pattern every other store in this codebase uses
// (PlanStore/ReflectionStore/GraphCheckpointStore/PlannerCache/...).
export class ConsensusStore {
  constructor(private readonly store: MemoryStore) {}

  async save(report: ConsensusReport): Promise<void> {
    await this.store.set(`${KEY_PREFIX}${report.consensusId}`, report, TTL_SECONDS);
  }

  async get(consensusId: string): Promise<ConsensusReport | undefined> {
    return this.store.get<ConsensusReport>(`${KEY_PREFIX}${consensusId}`);
  }
}

export const consensusStore = new ConsensusStore(new RedisMemoryStore(redis));
