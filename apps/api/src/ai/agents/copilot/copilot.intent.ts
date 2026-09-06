import type { CopilotIntent } from './copilot.types.js';

// Maps a free-form user message to a CopilotIntent via simple keyword
// matching — not an LLM call, same "understand intent well enough to
// select a path, never execute business logic itself" reasoning
// Planner.resolveWorkflowId() already established for workflow intent
// (ai/orchestrator/planner.ts). A future phase could swap this for an
// aiFoundation.llmClient-driven classifier without changing
// CopilotIntent's shape or any downstream consumer.
//
// Order matters: FOLLOW_UP is checked first since its phrases ("why",
// "explain that") are short and would otherwise be swallowed by a
// broader pattern; ANALYZE is checked before the narrower explain-*
// intents since "analyze the risk on this asset" should trigger a fresh
// run, not just narrate old data.
const INTENT_PATTERNS: { pattern: RegExp; intent: CopilotIntent }[] = [
  {
    pattern: /\b(explain that|tell me more|show me more|more detail|why|go on)\b/i,
    intent: 'FOLLOW_UP',
  },
  { pattern: /\b(analy[sz]e|scan|discover|re-?run|refresh)\b/i, intent: 'ANALYZE' },
  { pattern: /\brisk/i, intent: 'EXPLAIN_RISK' },
  { pattern: /complian/i, intent: 'EXPLAIN_COMPLIANCE' },
  { pattern: /recommend/i, intent: 'EXPLAIN_RECOMMENDATION' },
  { pattern: /\breport|summar/i, intent: 'SUMMARIZE_REPORT' },
];

export function classifyIntent(message: string): CopilotIntent {
  const match = INTENT_PATTERNS.find((entry) => entry.pattern.test(message));
  return match?.intent ?? 'GENERAL';
}

// Extracts a 1-based recommendation index from phrasing like "explain
// recommendation 2" / "recommendation #3" — undefined if the message
// doesn't name one, in which case the executor falls back to the
// highest-priority recommendation.
const RECOMMENDATION_INDEX_PATTERN = /recommendation\s*#?\s*(\d+)/i;

export function extractRecommendationIndex(message: string): number | undefined {
  const match = RECOMMENDATION_INDEX_PATTERN.exec(message);
  if (!match) return undefined;
  const index = Number.parseInt(match[1], 10);
  return Number.isFinite(index) && index > 0 ? index : undefined;
}
