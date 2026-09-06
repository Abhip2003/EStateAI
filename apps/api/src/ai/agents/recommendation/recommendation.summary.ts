import { aiFoundation } from '../../foundation.js';
import { aiConfig } from '../../config/index.js';
import { recommendationSummaryPrompt } from './recommendation.prompts.js';
import type { RecommendationView } from './recommendation.types.js';

const MAX_TITLES_IN_PROMPT = 5;

// Narrates a completed run — never invents a recommendation, only
// summarizes the already-aggregated list. Degrades to a deterministic
// string on any LLM failure/absence, same pattern as
// compliance.summary.ts's generateComplianceSummary().
export async function generateRecommendationSummary(input: {
  assetId: string;
  recommendations: RecommendationView[];
}): Promise<string> {
  const count = input.recommendations.length;
  const topTitles = input.recommendations
    .slice(0, MAX_TITLES_IN_PROMPT)
    .map((r) => r.title)
    .join('; ');

  const fallback =
    count === 0
      ? `Asset ${input.assetId} has no open recommendations at this time.`
      : `Asset ${input.assetId} has ${count} open recommendation(s). Top priorities: ${topTitles}.`;

  if (count === 0) {
    return fallback;
  }

  try {
    const rendered = recommendationSummaryPrompt.render({
      assetId: input.assetId,
      recommendationCount: count,
      topTitles: topTitles || 'none',
    });
    const response = await aiFoundation.llmClient.generate({
      model: aiConfig.defaultModel,
      messages: [
        ...(rendered.system ? [{ role: 'system' as const, content: rendered.system }] : []),
        { role: 'user' as const, content: rendered.user },
      ],
      maxTokens: 200,
      temperature: 0.3,
    });
    return response.text.trim() || fallback;
  } catch {
    return fallback;
  }
}
