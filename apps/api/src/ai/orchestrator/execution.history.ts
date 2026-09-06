import type { MemoryStore } from '../interfaces/memory-store.interface.js';
import type { ExecutionResult } from './execution.result.js';
import type { WorkflowStatus } from './types.js';

const HISTORY_KEY = 'orchestrator:history';
const DEFAULT_LIMIT = 100;

export interface ExecutionHistoryEntry {
  executionId: string;
  workflowId: string;
  status: WorkflowStatus;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
}

// Append-only log of completed orchestrator executions, backed by the
// injected MemoryStore (Redis in production via RedisMemoryStore, so
// history survives process restarts) — a lightweight summary per run, not
// the full ExecutionResult, since GET /ai/orchestrator/history is meant
// for a run list, not per-run detail (use StateManager.get() for that).
export class ExecutionHistory {
  constructor(private readonly store: MemoryStore) {}

  async record(result: ExecutionResult): Promise<void> {
    const entry: ExecutionHistoryEntry = {
      executionId: result.executionId,
      workflowId: result.workflowId,
      status: result.status,
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
      durationMs: result.durationMs,
    };
    await this.store.append(HISTORY_KEY, entry);
  }

  async list(limit: number = DEFAULT_LIMIT): Promise<ExecutionHistoryEntry[]> {
    const all = await this.store.getList<ExecutionHistoryEntry>(HISTORY_KEY);
    return all.slice(-limit).reverse();
  }
}
