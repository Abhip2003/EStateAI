import type { MemoryStore } from '../interfaces/memory-store.interface.js';
import type { ReflectionReport } from './reflection.types.js';

const KEY_PREFIX = 'reasoning:reflection:';
const TTL_SECONDS = 60 * 60 * 24 * 7; // 7d, matches PlanStore's retention window

// Persists ReflectionReports for GET /ai/reflection/:executionId, backed
// by the same injected MemoryStore pattern as PlanStore/ExecutionHistory.
export class ReflectionStore {
  constructor(private readonly store: MemoryStore) {}

  async save(reflection: ReflectionReport): Promise<void> {
    await this.store.set(`${KEY_PREFIX}${reflection.executionId}`, reflection, TTL_SECONDS);
  }

  async get(executionId: string): Promise<ReflectionReport | undefined> {
    return this.store.get<ReflectionReport>(`${KEY_PREFIX}${executionId}`);
  }
}
