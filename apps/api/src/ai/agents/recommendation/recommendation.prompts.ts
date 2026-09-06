import { PromptTemplate } from '../../prompts/prompt-template.js';
import { recommendationSummaryVariablesSchema } from './recommendation.schemas.js';

// Best-effort natural-language narrative of a completed Recommendation
// Agent run. Same graceful-degradation pattern as
// compliance.summary.ts/risk.summary.ts — falls back to a deterministic
// string when no LLM provider is configured, so the agent's structured
// output never depends on an LLM being available.
export const recommendationSummaryPrompt = new PromptTemplate({
  id: 'recommendation-agent.summary',
  version: '1',
  description:
    'Summarizes a completed Recommendation Agent run in a few sentences for a security dashboard.',
  systemTemplate:
    'You are a concise security advisor. Summarize the recommended remediation actions in 2-3 sentences, no markdown. Do not invent recommendations beyond what you are given.',
  userTemplate:
    'Asset: {{assetId}}. {{recommendationCount}} recommendation(s) surfaced. Top items: {{topTitles}}. Write a short summary for a security dashboard prioritizing what to fix first.',
  variablesSchema: recommendationSummaryVariablesSchema,
});
