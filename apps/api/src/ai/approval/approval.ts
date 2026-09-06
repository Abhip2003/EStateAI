import { redis } from '../../cache/redis.js';
import { RedisMemoryStore } from '../memory/redis-memory-store.js';
import { reasoningFoundation } from '../planner/reasoning.js';
import { ApprovalStore } from './approval-store.js';
import { ApprovalEngine } from './approval-engine.js';
import { PausedExecutionStore } from './paused-execution.store.js';
import { HitlOrchestrator } from './hitl-orchestrator.js';

// Composition root — mirrors ai/planner/reasoning.ts's own
// createReasoningFoundation(): wires concrete implementations via
// constructor injection, reusing the same shared `redis` client every
// other MemoryStore-backed store in this codebase wraps, and reusing
// Phase 25's already-constructed `reasoningFoundation.planStore` rather
// than standing up a second one.
export interface ApprovalFoundation {
  approvalStore: ApprovalStore;
  approvalEngine: ApprovalEngine;
  pausedExecutionStore: PausedExecutionStore;
  service: HitlOrchestrator;
}

export function createApprovalFoundation(): ApprovalFoundation {
  const memoryStore = new RedisMemoryStore(redis);
  const approvalStore = new ApprovalStore(memoryStore);
  const approvalEngine = new ApprovalEngine(approvalStore);
  const pausedExecutionStore = new PausedExecutionStore(memoryStore);
  const service = new HitlOrchestrator(
    reasoningFoundation.planStore,
    approvalEngine,
    pausedExecutionStore,
  );
  return { approvalStore, approvalEngine, pausedExecutionStore, service };
}

export const approvalFoundation = createApprovalFoundation();
