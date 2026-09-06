import { executiveSummaryPrompt } from './executive-summary.prompt.js';
import { riskSummaryPrompt } from './risk-summary.prompt.js';
import type { PromptTemplate, StructuredReportSnapshot } from '../dto/ai-report.js';

// The FULL_REPORT template composes the summary + risk templates'
// instructions rather than duplicating them, then adds the three sections
// only a full report needs. All five headings are fixed and required so
// ReportAgent's response parser can split the single AI response back
// into structured fields.
const SYSTEM_PROMPT = [
  executiveSummaryPrompt.systemPrompt,
  riskSummaryPrompt.systemPrompt,
  'Additionally write a "## Recommendation Summary" section prioritizing the ' +
    'open recommendations in plain language, a "## Key Observations" section ' +
    'as a bullet list of the most notable facts from the data, and a ' +
    '"## Limitations" section as a bullet list noting what this report cannot ' +
    'see (e.g. data it was not given, sampling limits).',
  'Always use exactly these five headings, in this order: "## Executive ' +
    'Summary", "## Risk Narrative", "## Recommendation Summary", "## Key ' +
    'Observations", "## Limitations".',
].join(' ');

function buildUserPrompt(report: StructuredReportSnapshot): string {
  const technical = report.technical as { recommendations?: unknown };
  return [
    executiveSummaryPrompt.buildUserPrompt(report),
    '',
    riskSummaryPrompt.buildUserPrompt(report),
    '',
    'Recommendation data:',
    JSON.stringify(technical.recommendations ?? null, null, 2),
    '',
    'Write the full report now, using all five headings.',
  ].join('\n');
}

export const securityReportPrompt: PromptTemplate = {
  id: 'security-report',
  systemPrompt: SYSTEM_PROMPT,
  buildUserPrompt,
};
