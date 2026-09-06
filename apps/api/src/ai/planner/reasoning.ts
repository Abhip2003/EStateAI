import { redis } from '../../cache/redis.js';
import { RedisMemoryStore } from '../memory/redis-memory-store.js';
import { PlanStore } from './plan-store.js';
import { ReflectionStore } from '../reflection/reflection.store.js';
import { ReasoningOrchestrator } from './reasoning-orchestrator.js';

// Composition root — mirrors ai/orchestrator/orchestrator.ts's
// createOrchestrator(): wires concrete implementations together via
// constructor injection, reusing the same shared `redis` client every
// other MemoryStore-backed store in this codebase wraps.
export interface ReasoningFoundation {
  planStore: PlanStore;
  reflectionStore: ReflectionStore;
  service: ReasoningOrchestrator;
}

export function createReasoningFoundation(): ReasoningFoundation {
  const memoryStore = new RedisMemoryStore(redis);
  const planStore = new PlanStore(memoryStore);
  const reflectionStore = new ReflectionStore(memoryStore);
  const service = new ReasoningOrchestrator(planStore, reflectionStore);
  return { planStore, reflectionStore, service };
}

export const reasoningFoundation = createReasoningFoundation();
