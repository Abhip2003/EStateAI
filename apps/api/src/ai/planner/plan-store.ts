import type { MemoryStore } from '../interfaces/memory-store.interface.js';
import type { ReasoningPlan } from './plan.types.js';

const KEY_PREFIX = 'reasoning:plan:';
const TTL_SECONDS = 60 * 60 * 24 * 7; // 7d — long enough to review a past plan, not forever

// Persists ReasoningPlans (both the initial plan and any revision) for
// GET /ai/planner/:id, backed by the same injected MemoryStore pattern as
// ExecutionHistory/StateManager (Redis in production).
export class PlanStore {
  constructor(private readonly store: MemoryStore) {}

  async save(plan: ReasoningPlan): Promise<void> {
    await this.store.set(`${KEY_PREFIX}${plan.planId}`, plan, TTL_SECONDS);
  }

  async get(planId: string): Promise<ReasoningPlan | undefined> {
    return this.store.get<ReasoningPlan>(`${KEY_PREFIX}${planId}`);
  }
}
