import type { PromptTemplate, StructuredReportSnapshot } from '../dto/ai-report.js';

const SYSTEM_PROMPT =
  'You are a security analyst. Write a short risk narrative under the heading ' +
  '"## Risk Narrative" that explains, in prose, what the asset\'s current risk ' +
  'score and open findings mean in practice — do not just restate the numbers.';

function buildUserPrompt(report: StructuredReportSnapshot): string {
  const technical = report.technical as { risk?: unknown };
  return [
    'Risk data:',
    JSON.stringify(technical.risk ?? null, null, 2),
    '',
    'Write the risk narrative now.',
  ].join('\n');
}

export const riskSummaryPrompt: PromptTemplate = {
  id: 'risk-summary',
  systemPrompt: SYSTEM_PROMPT,
  buildUserPrompt,
};
