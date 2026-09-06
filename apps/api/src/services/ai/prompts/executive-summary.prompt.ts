import type { PromptTemplate, StructuredReportSnapshot } from '../dto/ai-report.js';

const SYSTEM_PROMPT =
  'You are a security analyst writing for an executive audience. Summarize the ' +
  'security posture of this asset in 3-5 plain-language sentences under the ' +
  'heading "## Executive Summary". Avoid jargon and do not merely repeat raw ' +
  'numbers verbatim; interpret what they mean for the business.';

function buildUserPrompt(report: StructuredReportSnapshot): string {
  return [
    'Structured report data (executive section):',
    JSON.stringify(report.executive, null, 2),
    '',
    'Write the executive summary now.',
  ].join('\n');
}

export const executiveSummaryPrompt: PromptTemplate = {
  id: 'executive-summary',
  systemPrompt: SYSTEM_PROMPT,
  buildUserPrompt,
};
