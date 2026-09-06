import { redis } from '../../cache/redis.js';
import { RedisMemoryStore } from '../memory/redis-memory-store.js';
import { StateManager } from './state.manager.js';
import { ExecutionHistory } from './execution.history.js';
import { planner } from './planner.js';
import { Executor } from './executor.js';
import { OrchestratorService } from './orchestrator.service.js';

export interface OrchestratorFoundation {
  stateManager: StateManager;
  history: ExecutionHistory;
  executor: Executor;
  service: OrchestratorService;
}

// Composition root — mirrors ai/foundation.ts's createAIFoundation():
// wires concrete implementations together via constructor injection,
// reusing the same shared `redis` client Phase 16's RedisMemoryStore
// already wraps (a second lightweight wrapper instance, not a second
// connection).
export function createOrchestrator(): OrchestratorFoundation {
  const memoryStore = new RedisMemoryStore(redis);
  const stateManager = new StateManager(memoryStore);
  const history = new ExecutionHistory(memoryStore);
  const executor = new Executor(stateManager, history);
  const service = new OrchestratorService(planner, executor, stateManager, history);

  return { stateManager, history, executor, service };
}

export const orchestratorFoundation = createOrchestrator();
