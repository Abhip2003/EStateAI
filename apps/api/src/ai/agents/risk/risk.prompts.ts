import { PromptTemplate } from '../../prompts/prompt-template.js';
import {
  riskSummaryVariablesSchema,
  riskFindingExplanationVariablesSchema,
} from './risk.schemas.js';

// Best-effort natural-language narrative of a completed Risk Agent run —
// rendered via the Phase 16 PromptTemplate machinery and (optionally)
// aiFoundation.llmClient. See risk.summary.ts's generateRiskSummary() for
// the graceful-degradation fallback used when no LLM provider is
// configured, so this agent never depends on an API key being present to
// produce a structured result — the score/counts/findings are already
// complete without it.
export const riskSummaryPrompt = new PromptTemplate({
  id: 'risk-agent.summary',
  version: '1',
  description: 'Summarizes a completed Risk Agent run in a few sentences for a security dashboard.',
  systemTemplate:
    'You are a concise security risk analyst. Summarize the risk posture in 2-3 sentences, no markdown. Do not invent a risk score — only narrate the score and counts you are given.',
  userTemplate:
    'Asset: {{assetId}}. Overall risk score: {{overallScore}} (business impact: {{businessImpact}}). Findings: {{findingCount}} total ({{criticalCount}} critical, {{highCount}} high, {{mediumCount}} medium, {{lowCount}} low/informational). Write a short risk summary for a security dashboard.',
  variablesSchema: riskSummaryVariablesSchema,
});

// Rephrases one finding's deterministic reasoning (see risk.finding.ts)
// in prose. The LLM explains and contextualizes; it never assigns or
// changes the severity/priority it is given.
export const riskFindingExplanationPrompt = new PromptTemplate({
  id: 'risk-agent.finding-explanation',
  version: '1',
  description: 'Explains one security finding in plain language, without changing its severity.',
  systemTemplate:
    'You are a concise security analyst. Explain the given finding in 1-2 sentences for a non-technical stakeholder. Do not change or restate the severity as a number — explain what it means in practice.',
  userTemplate:
    'Finding: {{title}} (rule: {{ruleCode}}, severity: {{severity}}, resource: {{resourceId}}). Default technical explanation: {{defaultReasoning}}. Rewrite this as a short, plain-language explanation of why it matters.',
  variablesSchema: riskFindingExplanationVariablesSchema,
});
