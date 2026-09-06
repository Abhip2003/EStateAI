import { createHash } from 'node:crypto';
import type { MemoryStore } from '../interfaces/memory-store.interface.js';
import type { LLMPlanRecord } from './planner.types.js';

const KEY_PREFIX = 'llm-planner:cache:';
const DEFAULT_TTL_SECONDS = 60 * 15; // 15 minutes — configurable per spec #9

export interface PlannerCacheKeyInput {
  goal: string;
  assetId?: string;
  knowledgeVersion: string;
  model: string;
}

// Spec #9: "Cache identical plans using goal, assetId, knowledge version,
// planner model." A short SHA-256 digest rather than the raw concatenated
// string, so the Redis key stays a fixed, predictable length regardless
// of goal length.
export function computeCacheKey(input: PlannerCacheKeyInput): string {
  const raw = `${input.goal.trim().toLowerCase()}|${input.assetId ?? ''}|${input.knowledgeVersion}|${input.model}`;
  return createHash('sha256').update(raw).digest('hex');
}

// Backed by the same injected MemoryStore pattern as every other store in
// this codebase (PlanStore/ReflectionStore/GraphCheckpointStore/...) —
// Redis in production, InMemoryStore in tests, TTL configurable via the
// constructor (spec #9) rather than hardcoded.
export class PlannerCache {
  constructor(
    private readonly store: MemoryStore,
    private readonly ttlSeconds: number = DEFAULT_TTL_SECONDS,
  ) {}

  private key(cacheKey: string): string {
    return `${KEY_PREFIX}${cacheKey}`;
  }

  async get(input: PlannerCacheKeyInput): Promise<LLMPlanRecord | undefined> {
    return this.store.get<LLMPlanRecord>(this.key(computeCacheKey(input)));
  }

  async set(input: PlannerCacheKeyInput, record: LLMPlanRecord): Promise<void> {
    await this.store.set(this.key(computeCacheKey(input)), record, this.ttlSeconds);
  }
}
