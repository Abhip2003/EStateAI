import type { MemoryStore } from '../interfaces/memory-store.interface.js';

const DEFAULT_TTL_SECONDS = 60 * 30; // 30 minutes of session inactivity

// Short-lived, arbitrary key-value scratch space scoped to one session
// (e.g. "which asset is the user currently focused on", "last tool result
// shown"). Distinct from ConversationMemory (append-only turn log) and
// LongTermMemory (cross-session, no TTL) — this is the "session memory"
// and "short-term memory" tiers from the Phase 16 spec.
export class SessionMemory {
  constructor(
    private readonly store: MemoryStore,
    private readonly ttlSeconds: number = DEFAULT_TTL_SECONDS,
  ) {}

  private key(sessionId: string, field: string): string {
    return `session:${sessionId}:${field}`;
  }

  async set<T>(sessionId: string, field: string, value: T): Promise<void> {
    await this.store.set(this.key(sessionId, field), value, this.ttlSeconds);
  }

  async get<T>(sessionId: string, field: string): Promise<T | undefined> {
    return this.store.get<T>(this.key(sessionId, field));
  }

  async clear(sessionId: string, field: string): Promise<void> {
    await this.store.delete(this.key(sessionId, field));
  }
}
