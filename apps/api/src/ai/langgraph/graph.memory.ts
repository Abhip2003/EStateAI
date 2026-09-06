import { redis } from '../../cache/redis.js';
import { RedisMemoryStore } from '../memory/redis-memory-store.js';
import { ConversationMemory } from '../memory/conversation-memory.js';
import { SessionMemory } from '../memory/session-memory.js';
import { knowledgeStore } from '../knowledge/index.js';
import type { KnowledgeDocumentRecord } from '../knowledge/knowledge.types.js';
import type { GraphMemoryState } from './state.js';

// Wires Phase 16's ConversationMemory/SessionMemory and Phase 23's
// KnowledgeStore into the graph — spec #7 ("reuse ... inside LangGraph,
// no duplicate memory implementation"). Every store here is the exact
// same class the rest of the codebase already uses, just given to
// GraphExecutor/nodes.ts instead of an agent executor.
const memoryStore = new RedisMemoryStore(redis);
export const graphConversationMemory = new ConversationMemory(memoryStore);
export const graphSessionMemory = new SessionMemory(memoryStore);

// Session memory is keyed by executionId (one graph run = one session),
// conversation memory by conversationId (may span multiple runs, e.g.
// Copilot follow-ups) — same distinction ai/agents/copilot already draws
// between the two tiers.
export async function loadMemory(
  conversationId: string | undefined,
  executionId: string,
): Promise<GraphMemoryState> {
  const conversationTurns = conversationId
    ? await graphConversationMemory.getTurns(conversationId)
    : [];
  const session =
    (await graphSessionMemory.get<Record<string, unknown>>(executionId, 'state')) ?? {};
  return { conversationTurns, session };
}

export async function persistMemory(
  conversationId: string | undefined,
  executionId: string,
  memory: GraphMemoryState,
): Promise<void> {
  if (conversationId) {
    for (const turn of memory.conversationTurns) {
      await graphConversationMemory.append(conversationId, turn.role, turn.content);
    }
  }
  await graphSessionMemory.set(executionId, 'state', memory.session);
}

// Best-effort — a missing/never-indexed asset returns an empty list
// rather than failing the node; knowledge retrieval enriches a node's
// context, it never gates whether the node can run (unlike the approval
// gate, which does).
export async function retrieveKnowledge(
  assetId: string | undefined,
): Promise<KnowledgeDocumentRecord[]> {
  if (!assetId) return [];
  try {
    return await knowledgeStore.getHistory(assetId);
  } catch {
    return [];
  }
}
