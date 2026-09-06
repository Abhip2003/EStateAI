// Generic key-value memory backend. ConversationMemory/SessionMemory
// (memory/) build on top of this rather than talking to Redis or an
// in-process Map directly, so the storage backend is swappable.
export interface MemoryStore {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T, ttlSeconds?: number): Promise<void>;
  append<T>(key: string, value: T, ttlSeconds?: number): Promise<void>;
  getList<T>(key: string): Promise<T[]>;
  delete(key: string): Promise<void>;
}

// Cross-session persistent memory (e.g. durable facts about a user or
// asset that should survive beyond a single conversation). Infrastructure
// only for Phase 16 — no implementation ships yet; a future agent phase
// backs this with a real store (Postgres table, vector store, etc.).
export interface LongTermMemory {
  remember(key: string, value: unknown): Promise<void>;
  recall<T>(key: string): Promise<T | undefined>;
  forget(key: string): Promise<void>;
}
