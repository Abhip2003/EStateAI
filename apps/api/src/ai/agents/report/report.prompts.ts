import { PromptTemplate } from '../../prompts/prompt-template.js';
import { reportSummaryVariablesSchema } from './report.schemas.js';

// Composes an executive narrative out of the already-generated
// per-section summaries (each upstream agent's own `.summary` string) —
// never re-derives a score or re-evaluates anything, only narrates.
// Degrades to a deterministic join of those section summaries when no
// LLM provider is configured, same pattern as every other agent's
// summary module.
export const reportSummaryPrompt = new PromptTemplate({
  id: 'report-agent.summary',
  version: '1',
  description:
    'Composes a short executive narrative from the already-generated Discovery/Risk/Compliance/Recommendation section summaries.',
  systemTemplate:
    'You are a concise security report writer. Write a 2-4 sentence executive narrative from the section summaries you are given. Do not invent facts or figures beyond what is stated in the summaries.',
  userTemplate:
    'Asset report with {{includedSectionCount}} of {{totalSectionCount}} sections available. Section summaries:\n{{sectionSummaries}}\n\nWrite a short executive narrative for a security dashboard, noting if the report is partial.',
  variablesSchema: reportSummaryVariablesSchema,
});
