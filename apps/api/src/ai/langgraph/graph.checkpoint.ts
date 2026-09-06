import type { MemoryStore } from '../interfaces/memory-store.interface.js';
import type { GraphState } from './state.js';

const KEY_PREFIX = 'langgraph:checkpoint:';
const TTL_SECONDS = 60 * 60 * 24 * 7; // 7d, matches PlanStore/PausedExecutionStore

// A durable snapshot of one graph execution's current channel values,
// taken after every invoke()/resume() call. Distinct from LangGraph's own
// `MemorySaver` checkpointer (used as the compiled graph's `checkpointer`
// in graph-builder.ts) — that one is genuinely in-process only and is
// what gives interrupt()/Command-based resume its correctness *within*
// one process lifetime. This store is what survives a process restart:
// GraphExecutor.resume() falls back to it when `compiledGraph.getState()`
// comes back empty (a fresh, restarted process's MemorySaver has nothing
// for that thread_id), replaying `values` back into the graph as a new
// invoke() input on the same thread. Every node is written to be
// idempotent (skip recomputation when its own state field is already
// set — see nodes.ts), which is what makes that replay a correct
// "fast-forward to where it left off" rather than a full re-run.
//
// Deliberately does NOT attempt to serialize LangGraph's own internal
// `Checkpoint` format (channel_versions/versions_seen/pending writes) —
// GraphState is plain, JSON-safe domain data by construction (see
// state.ts's `GraphMessage` comment), so persisting `values` directly
// via the same MemoryStore/JSON.stringify convention every other store
// in this codebase already uses is sufficient and far simpler than
// reimplementing BaseCheckpointSaver's chaining semantics.
export interface PendingGraphApproval {
  approvalId: string;
  stepId: string;
  agentId: string;
  reason: string;
}

export interface GraphCheckpointSnapshot {
  executionId: string;
  graphId: string;
  values: GraphState;
  next: string[];
  // Extracted from the live snapshot's `tasks[].interrupts[].value` at
  // persist time (executor.ts) — a gated node pauses by *throwing*, so
  // this is the only place "what's actually still pending" is knowable
  // without re-invoking the live compiled graph (see executor.ts's
  // getExecution(), which reads only from this durable store).
  pendingApprovals: PendingGraphApproval[];
  updatedAt: string;
}

export class GraphCheckpointStore {
  constructor(private readonly store: MemoryStore) {}

  async save(snapshot: GraphCheckpointSnapshot): Promise<void> {
    await this.store.set(this.key(snapshot.executionId), snapshot, TTL_SECONDS);
  }

  async get(executionId: string): Promise<GraphCheckpointSnapshot | undefined> {
    return this.store.get<GraphCheckpointSnapshot>(this.key(executionId));
  }

  async delete(executionId: string): Promise<void> {
    await this.store.delete(this.key(executionId));
  }

  private key(executionId: string): string {
    return `${KEY_PREFIX}${executionId}`;
  }
}
