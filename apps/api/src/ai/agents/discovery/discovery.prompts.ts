import { PromptTemplate } from '../../prompts/prompt-template.js';
import { discoverySummaryVariablesSchema } from './discovery.schemas.js';
import type { DiscoveryIntent } from './discovery.types.js';

// Maps a free-form discovery request (e.g. "Discover all GitHub
// repositories" / "Analyze connected GitHub account" / "Refresh
// repository inventory" / "Discover new repositories") to a structured
// DiscoveryIntent via keyword matching — not an LLM call, mirroring the
// Phase 17 Planner's own intent-matching approach (deliberately kept
// simple and deterministic there too). This is informational only in
// this phase: DiscoveryAgent.execute()'s actual input is always the
// structured `{accountId}` the Phase 17 DiscoveryAgent interface fixes,
// so this classifier is used for request-logging/summary wording (see
// routes/discovery.ts), not as a control-flow branch. A future phase can
// swap this for an aiFoundation.llmClient call without changing anything
// downstream, since DiscoveryIntent's shape doesn't change either way.
const REFRESH_PATTERN = /refresh|re-?scan|re-?discover|update inventory/i;

export function classifyDiscoveryIntent(text: string): DiscoveryIntent {
  const action = REFRESH_PATTERN.test(text) ? 'REFRESH' : 'DISCOVER';
  const provider = /github/i.test(text) ? 'github' : undefined;
  return { action, provider, confidence: provider ? 0.9 : 0.6 };
}

// Best-effort natural-language summary of a completed discovery run,
// rendered via the Phase 16 PromptTemplate + PromptRegistry machinery and
// (optionally) aiFoundation.llmClient — see discovery.executor.ts's
// generateSummary() for the graceful-degradation fallback used when no
// LLM provider is configured (e.g. no OPENAI_API_KEY set), so this agent
// never depends on an API key being present to produce a result.
export const discoverySummaryPrompt = new PromptTemplate({
  id: 'discovery-agent.summary',
  version: '1',
  description: 'Summarizes a completed Discovery Agent run in a few sentences.',
  systemTemplate:
    'You are a concise security asset-inventory assistant. Summarize discovery results in 2-3 sentences, no markdown.',
  userTemplate:
    'Provider: {{provider}}. Discovered {{resourceCount}} resources ({{repositoryCount}} repositories, {{organizationCount}} organizations). Warnings: {{warningCount}}. Errors: {{errorCount}}. Write a short summary of this discovery run for a security dashboard.',
  variablesSchema: discoverySummaryVariablesSchema,
});
