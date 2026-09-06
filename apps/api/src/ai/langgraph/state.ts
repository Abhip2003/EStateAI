import { Annotation } from '@langchain/langgraph';
import type {
  ConnectedAccountRef,
  AssetRef,
  AgentOutputEntry,
  ToolOutputEntry,
} from '../orchestrator/execution.context.js';
import type { ReflectionReport } from '../reflection/reflection.types.js';
import type { ConversationTurn } from '../types/memory.types.js';
import type { KnowledgeDocumentRecord } from '../knowledge/knowledge.types.js';

// Graph state (Phase 27 spec #3) — every field the spec lists, plus
// `metadata` doubling as the plumbing bag (executionId/user/organization/
// planId/workflowId/conversationId) every node needs to build an
// OrchestrationContext, since the orchestrator's own execution.context.ts
// types weren't designed to be graph channels. No hidden globals: nodes
// only ever read/write via this schema, never a module-level variable.
export interface GraphMemoryState {
  conversationTurns: ConversationTurn[];
  session: Record<string, unknown>;
}

// Deliberately plain ConversationTurn objects, not LangChain `BaseMessage`
// instances — every other channel in this state must round-trip through
// JSON untouched (see graph.checkpoint.ts's durable snapshotting), and a
// class instance doesn't. This also means `messages` composes directly
// with ai/memory/conversation-memory.ts's ConversationMemory without any
// adapter.
export type GraphMessage = ConversationTurn;

export interface GraphApprovalState {
  requestIdByStep: Record<string, string>;
  pendingApprovalIds: string[];
  rejectedStepIds: string[];
}

export function emptyApprovalState(): GraphApprovalState {
  return { requestIdByStep: {}, pendingApprovalIds: [], rejectedStepIds: [] };
}

function overwrite<T>(_current: T, update: T): T {
  return update;
}

function append<T>(current: T[] | undefined, update: T[]): T[] {
  return [...(current ?? []), ...update];
}

function mergeMetadata(
  current: Record<string, unknown> | undefined,
  update: Record<string, unknown>,
): Record<string, unknown> {
  return { ...(current ?? {}), ...update };
}

export const GraphStateAnnotation = Annotation.Root({
  goal: Annotation<string>({ reducer: overwrite, default: () => '' }),
  intent: Annotation<string>({ reducer: overwrite, default: () => '' }),
  messages: Annotation<GraphMessage[]>({ reducer: append, default: () => [] }),
  asset: Annotation<AssetRef[]>({ reducer: overwrite, default: () => [] }),
  connectedAccounts: Annotation<ConnectedAccountRef[]>({ reducer: overwrite, default: () => [] }),
  discovery: Annotation<unknown>({ reducer: overwrite, default: () => undefined }),
  risk: Annotation<unknown>({ reducer: overwrite, default: () => undefined }),
  compliance: Annotation<unknown>({ reducer: overwrite, default: () => undefined }),
  recommendations: Annotation<unknown>({ reducer: overwrite, default: () => undefined }),
  report: Annotation<unknown>({ reducer: overwrite, default: () => undefined }),
  knowledge: Annotation<KnowledgeDocumentRecord[]>({ reducer: append, default: () => [] }),
  memory: Annotation<GraphMemoryState>({
    reducer: overwrite,
    default: (): GraphMemoryState => ({ conversationTurns: [], session: {} }),
  }),
  toolResults: Annotation<ToolOutputEntry[]>({ reducer: append, default: () => [] }),
  reflection: Annotation<ReflectionReport | undefined>({
    reducer: overwrite,
    default: () => undefined,
  }),
  // Overwrite, not merge — every node that touches approval reads
  // state.approval itself and returns the full next value (see
  // nodes.ts's withApprovalGate) so that a resolved pendingApprovalIds
  // entry can actually disappear on resume rather than accumulating
  // forever under an append-style reducer.
  approval: Annotation<GraphApprovalState>({ reducer: overwrite, default: emptyApprovalState }),
  executionTrace: Annotation<AgentOutputEntry[]>({ reducer: append, default: () => [] }),
  metadata: Annotation<Record<string, unknown>>({ reducer: mergeMetadata, default: () => ({}) }),
});

export type GraphState = typeof GraphStateAnnotation.State;
export type GraphStateUpdate = typeof GraphStateAnnotation.Update;
