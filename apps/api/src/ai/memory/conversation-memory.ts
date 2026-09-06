import type { MemoryStore } from '../interfaces/memory-store.interface.js';
import type { MessageRole } from '../types/common.js';
import type { ConversationTurn } from '../types/memory.types.js';

const DEFAULT_TTL_SECONDS = 60 * 60 * 24; // 1 day — a conversation not touched in a day is stale

// Append-only turn history for one conversation, backed by any
// MemoryStore (InMemoryStore for tests/dev, RedisMemoryStore for
// anything that must survive a process restart or be shared across
// instances).
export class ConversationMemory {
  constructor(
    private readonly store: MemoryStore,
    private readonly ttlSeconds: number = DEFAULT_TTL_SECONDS,
  ) {}

  private key(conversationId: string): string {
    return `conversation:${conversationId}`;
  }

  async append(conversationId: string, role: MessageRole, content: string): Promise<void> {
    const turn: ConversationTurn = { role, content, timestamp: new Date().toISOString() };
    await this.store.append(this.key(conversationId), turn, this.ttlSeconds);
  }

  async getTurns(conversationId: string): Promise<ConversationTurn[]> {
    return this.store.getList<ConversationTurn>(this.key(conversationId));
  }

  async clear(conversationId: string): Promise<void> {
    await this.store.delete(this.key(conversationId));
  }
}
