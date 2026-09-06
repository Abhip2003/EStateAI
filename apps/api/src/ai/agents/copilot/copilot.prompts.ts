import { PromptTemplate } from '../../prompts/prompt-template.js';
import { answerVariablesSchema } from './copilot.schemas.js';

// Rephrases an already-built CopilotExplanation (summary/reasoning/
// evidence/suggestedAction — all deterministic, built in
// copilot.executor.ts from existing agent data) into one conversational
// answer. The LLM narrates; it never invents a fact not already present
// in the variables it's given. Degrades to a deterministic
// concatenation on any LLM failure (copilot.summary.ts), so a chat
// answer never depends on an LLM provider being configured.
export const copilotAnswerPrompt = new PromptTemplate({
  id: 'copilot-agent.answer',
  version: '1',
  description: 'Composes one conversational answer from an already-built explanation.',
  systemTemplate:
    "You are EstateAI's security copilot, answering one question in a chat. Use only the summary, reasoning, evidence, and suggested action you are given — never invent a fact, score, or finding not present in them. Write 2-4 sentences, conversational but precise, no markdown headings.",
  userTemplate:
    'Question: {{question}}\nSummary: {{summary}}\nReasoning: {{reasoning}}\nEvidence: {{evidence}}\nSuggested action: {{suggestedAction}}\n\nAnswer the question now, in your own words, grounded only in the above.',
  variablesSchema: answerVariablesSchema,
});
