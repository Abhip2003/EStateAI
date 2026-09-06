import { aiFoundation } from '../../foundation.js';
import { aiConfig } from '../../config/index.js';
import { reportSummaryPrompt } from './report.prompts.js';
import type { ReportSection } from './report.types.js';

export async function generateReportSummary(input: {
  assetId: string;
  sections: ReportSection[];
}): Promise<string> {
  const included = input.sections.filter((s) => s.status === 'INCLUDED');
  const total = input.sections.length;

  const fallback =
    included.length === 0
      ? `No section data was available to build a report for asset ${input.assetId}.`
      : `Report for asset ${input.assetId}: ${included.length} of ${total} section(s) available (${included
          .map((s) => s.title)
          .join(', ')}).${included.length < total ? ' This report is partial.' : ''}`;

  if (included.length === 0) {
    return fallback;
  }

  try {
    const rendered = reportSummaryPrompt.render({
      assetId: input.assetId,
      includedSectionCount: included.length,
      totalSectionCount: total,
      sectionSummaries: included.map((s) => `${s.title}: ${s.content}`).join('\n'),
    });
    const response = await aiFoundation.llmClient.generate({
      model: aiConfig.defaultModel,
      messages: [
        ...(rendered.system ? [{ role: 'system' as const, content: rendered.system }] : []),
        { role: 'user' as const, content: rendered.user },
      ],
      maxTokens: 300,
      temperature: 0.3,
    });
    return response.text.trim() || fallback;
  } catch {
    return fallback;
  }
}
