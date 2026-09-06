import type { MemoryStore } from '../../interfaces/memory-store.interface.js';
import type { ConversationMemory } from '../../memory/conversation-memory.js';
import type { SessionMemory } from '../../memory/session-memory.js';
import type { ConversationTurn } from '../../types/memory.types.js';
import type { ICopilotMemory } from './copilot.interface.js';
import type {
  CopilotSessionState,
  CopilotSummaryRecord,
  CopilotFailureRecord,
} from './copilot.types.js';

const HISTORY_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days — the execution trace, distinct from the 1-day ConversationMemory TTL
const DEFAULT_HISTORY_LIMIT = 50;
const SESSION_STATE_FIELD = 'copilot-state';

// Composes the Phase 16 ConversationMemory (turn log, 1-day TTL) and
// SessionMemory (short-lived key-value scratch, 30-min TTL) — both
// already provisioned on aiFoundation, unused until this phase — into
// one domain-facing memory class, plus its own longer-lived execution
// history (a `MemoryStore` key of its own, matching every other agent's
// *Memory pattern). conversationId doubles as SessionMemory's
// `sessionId` — a stable identifier for "this ongoing chat," which is
// exactly what SessionMemory's own doc comment describes as its
// intended scope.
export class CopilotMemory implements ICopilotMemory {
  constructor(
    private readonly conversationMemory: ConversationMemory,
    private readonly sessionMemory: SessionMemory,
    private readonly store: MemoryStore,
  ) {}

  private historyKey(conversationId: string): string {
    return `copilot-agent:history:${conversationId}`;
  }
  private failuresKey(conversationId: string): string {
    return `copilot-agent:failures:${conversationId}`;
  }

  async appendTurn(
    conversationId: string,
    role: 'user' | 'assistant',
    content: string,
  ): Promise<void> {
    await this.conversationMemory.append(conversationId, role, content);
  }

  async getTurns(conversationId: string): Promise<ConversationTurn[]> {
    return this.conversationMemory.getTurns(conversationId);
  }

  async clearConversation(conversationId: string): Promise<void> {
    await Promise.all([
      this.conversationMemory.clear(conversationId),
      this.sessionMemory.clear(conversationId, SESSION_STATE_FIELD),
      this.store.delete(this.historyKey(conversationId)),
    ]);
  }

  async getSessionState(conversationId: string): Promise<CopilotSessionState | undefined> {
    return this.sessionMemory.get<CopilotSessionState>(conversationId, SESSION_STATE_FIELD);
  }

  async setSessionState(conversationId: string, state: CopilotSessionState): Promise<void> {
    await this.sessionMemory.set(conversationId, SESSION_STATE_FIELD, state);
  }

  async recordRun(record: CopilotSummaryRecord): Promise<void> {
    await this.store.append(this.historyKey(record.conversationId), record, HISTORY_TTL_SECONDS);
  }

  async getHistory(
    conversationId: string,
    limit: number = DEFAULT_HISTORY_LIMIT,
  ): Promise<CopilotSummaryRecord[]> {
    const all = await this.store.getList<CopilotSummaryRecord>(this.historyKey(conversationId));
    return all.slice(-limit).reverse();
  }

  async recordFailure(record: CopilotFailureRecord): Promise<void> {
    await this.store.append(this.failuresKey(record.conversationId), record, HISTORY_TTL_SECONDS);
  }
}
