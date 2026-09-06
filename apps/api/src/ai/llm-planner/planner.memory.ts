import { redis } from '../../cache/redis.js';
import { RedisMemoryStore } from '../memory/redis-memory-store.js';
import { ConversationMemory } from '../memory/conversation-memory.js';
import { SessionMemory } from '../memory/session-memory.js';
import { knowledgeStore } from '../knowledge/index.js';
import { reasoningFoundation } from '../planner/reasoning.js';
import { episodeSearch } from '../episodic-memory/index.js';
import type { PlannerContextSummary, PlannerRunInput } from './planner.types.js';

const CONVERSATION_TURN_LIMIT = 6;

// Reuses Phase 16's ConversationMemory/SessionMemory (same store, same
// class) and Phase 23's KnowledgeStore — spec #7 ("must read
// ConversationMemory, SessionMemory, KnowledgeStore, ReflectionStore
// before generating the plan"), no duplicate memory implementation. A new
// instance rather than importing ai/langgraph/graph.memory.ts's
// singletons: this module has no dependency on ai/langgraph (the LLM
// Planner is independent of, and precedes, whichever executor eventually
// runs its plan), but both point at the same underlying Redis-backed
// store/keyspace, so a conversation seen by one is visible to the other.
const memoryStore = new RedisMemoryStore(redis);
export const plannerConversationMemory = new ConversationMemory(memoryStore);
export const plannerSessionMemory = new SessionMemory(memoryStore);

function summarizeConversation(turns: { role: string; content: string }[]): string {
  if (turns.length === 0) return 'no prior conversation';
  return turns
    .slice(-CONVERSATION_TURN_LIMIT)
    .map((turn) => `${turn.role}: ${turn.content}`)
    .join(' | ');
}

function summarizeSession(session: Record<string, unknown> | undefined): string {
  if (!session || Object.keys(session).length === 0) return 'no session state';
  return Object.entries(session)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(', ');
}

// ReflectionStore only supports get-by-executionId (ai/reflection/reflection.store.ts
// has no scan/query-by-goal), so "read ReflectionStore before planning"
// (spec #7) is honored for the one case that actually has an executionId
// to look up: a revision or a follow-up run naming the prior run via
// `metadata.previousExecutionId`. A first-time plan for a brand new goal
// has nothing to look up yet — this returns a neutral summary rather than
// failing.
async function summarizeReflection(previousExecutionId: string | undefined): Promise<string> {
  if (!previousExecutionId) return 'no prior execution referenced';
  const reflection = await reasoningFoundation.reflectionStore.get(previousExecutionId);
  if (!reflection) return `no reflection found for execution "${previousExecutionId}"`;
  return `execution ${previousExecutionId} finished with confidence ${reflection.overallConfidence.toFixed(2)}, critic score ${reflection.criticScore.toFixed(2)}; notes: ${reflection.notes.join('; ')}`;
}

// Best-effort — a missing/never-indexed asset yields an empty summary
// rather than failing the whole planning call (matches
// ai/langgraph/graph.memory.ts's retrieveKnowledge design).
async function summarizeKnowledge(assetId: string | undefined): Promise<{
  summary: string;
  version: string;
}> {
  if (!assetId) return { summary: 'no asset in scope', version: 'none' };
  try {
    const docs = await knowledgeStore.getHistory(assetId);
    if (docs.length === 0)
      return { summary: `no indexed knowledge for asset ${assetId}`, version: '0' };
    const latest = docs.reduce(
      (max, doc) => (doc.updatedAt > max ? doc.updatedAt : max),
      docs[0].updatedAt,
    );
    return {
      summary: `${docs.length} indexed document(s) for asset ${assetId}, most recent type ${docs[0].documentType}`,
      // A cheap, deterministic proxy for "has the asset's knowledge
      // changed" — count + latest update timestamp — not a real content
      // hash. Good enough for planner.cache.ts's cache-key purpose
      // (invalidate once new knowledge lands), documented as a heuristic
      // the same way ai/planner/goal-planner.ts's own estimates are.
      version: `${docs.length}:${latest.toISOString()}`,
    };
  } catch {
    return { summary: 'knowledge lookup failed', version: 'unknown' };
  }
}

// Best-effort, mirrors summarizeKnowledge — a retrieval failure (or a
// goal with no similar past episodes) yields a neutral summary rather
// than failing the whole planning call. Reuses EpisodeSearch
// (episodic-memory/episode.search.ts), never a second retrieval path.
async function summarizeEpisodes(goal: string, assetId: string | undefined): Promise<string> {
  try {
    const matches = await episodeSearch.search({ goal, assetId, topK: 3 });
    if (matches.length === 0) return 'no similar past episodes found';
    return matches
      .map(({ episode, score }) => {
        const lesson = episode.lessons.lessonsLearned[0] ?? episode.lessons.futureSuggestions[0];
        return `"${episode.goal}" -> ${episode.outcome} (similarity ${score.toFixed(2)})${lesson ? `; lesson: ${lesson}` : ''}`;
      })
      .join(' | ');
  } catch {
    return 'episode lookup failed';
  }
}

export async function gatherPlannerContext(input: PlannerRunInput): Promise<PlannerContextSummary> {
  const assetId = input.assets?.[0]?.id;
  const previousExecutionId =
    typeof input.metadata?.previousExecutionId === 'string'
      ? input.metadata.previousExecutionId
      : undefined;

  const [turns, session, knowledge, reflectionSummary, episodeSummary] = await Promise.all([
    input.conversationId
      ? plannerConversationMemory.getTurns(input.conversationId)
      : Promise.resolve([]),
    input.conversationId
      ? plannerSessionMemory.get<Record<string, unknown>>(input.conversationId, 'planner')
      : Promise.resolve(undefined),
    summarizeKnowledge(assetId),
    summarizeReflection(previousExecutionId),
    summarizeEpisodes(input.goal, assetId),
  ]);

  return {
    conversationSummary: summarizeConversation(turns),
    sessionSummary: summarizeSession(session),
    knowledgeSummary: knowledge.summary,
    reflectionSummary,
    knowledgeVersion: knowledge.version,
    episodeSummary,
  };
}
