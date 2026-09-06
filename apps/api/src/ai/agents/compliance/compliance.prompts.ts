import { PromptTemplate } from '../../prompts/prompt-template.js';
import {
  complianceSummaryVariablesSchema,
  complianceGapExplanationVariablesSchema,
} from './compliance.schemas.js';

// Best-effort natural-language narrative of a completed Compliance Agent
// run — rendered via the Phase 16 PromptTemplate machinery and
// (optionally) aiFoundation.llmClient. See compliance.summary.ts's
// generateComplianceSummary() for the graceful-degradation fallback used
// when no LLM provider is configured, so this agent never depends on an
// API key being present to produce a structured result.
export const complianceSummaryPrompt = new PromptTemplate({
  id: 'compliance-agent.summary',
  version: '1',
  description:
    'Summarizes a completed Compliance Agent run in a few sentences for a security dashboard.',
  systemTemplate:
    'You are a concise compliance analyst. Summarize the compliance posture in 2-3 sentences, no markdown. Do not invent a compliance score — only narrate the score and counts you are given.',
  userTemplate:
    'Asset: {{assetId}}. Compliance score: {{complianceScore}}. Policy results: {{passCount}} passed, {{failCount}} failed, {{warningCount}} warnings, across {{frameworkCount}} frameworks assessed. Write a short compliance summary for a security dashboard.',
  variablesSchema: complianceSummaryVariablesSchema,
});

// Rephrases one control gap's deterministic reasoning in prose. The LLM
// explains and contextualizes; it never changes the control's PASS/FAIL/
// MISSING status it is given.
export const complianceGapExplanationPrompt = new PromptTemplate({
  id: 'compliance-agent.gap-explanation',
  version: '1',
  description:
    'Explains one compliance control gap in plain language, without changing its status.',
  systemTemplate:
    'You are a concise compliance analyst. Explain the given control gap in 1-2 sentences for a non-technical stakeholder — why the control matters and what failing/missing it means in practice. Do not restate the status as a label — explain its impact.',
  userTemplate:
    'Control: {{controlName}} ({{framework}}). Status: {{status}}. Related policy: {{policyName}}. Default technical explanation: {{defaultReasoning}}. Rewrite this as a short, plain-language explanation of why it matters.',
  variablesSchema: complianceGapExplanationVariablesSchema,
});
