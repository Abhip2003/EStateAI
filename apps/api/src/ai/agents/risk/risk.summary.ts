import { aiFoundation } from '../../foundation.js';
import { aiConfig } from '../../config/index.js';
import { riskSummaryPrompt, riskFindingExplanationPrompt } from './risk.prompts.js';
import type { BusinessImpact, RiskFindingView, RiskSeverityCounts } from './risk.types.js';

// LLM responsibilities for this agent, per the Phase 19 spec: explain
// findings, group similar findings, prioritize, estimate impact,
// generate reasoning, and create summaries — narration only. The score,
// severity, priority, and business-impact values passed in here are
// always already-computed (risk.scoring.ts/risk.finding.ts); this file
// never lets the LLM change them, and every function degrades to a
// deterministic fallback string when no LLM provider is configured (e.g.
// no OPENAI_API_KEY set), so the agent's structured output never depends
// on an LLM being available.

// Rephrases at most this many of the highest-priority findings in prose —
// bounded to keep latency/cost predictable regardless of how many
// findings an asset has; the remaining findings still carry their full
// deterministic reasoning/evidence from risk.finding.ts, unaffected.
const MAX_LLM_EXPLAINED_FINDINGS = 5;

export async function generateRiskSummary(input: {
  assetId: string;
  overallScore: number;
  businessImpact: BusinessImpact;
  counts: RiskSeverityCounts;
  findingCount: number;
}): Promise<string> {
  const fallback = `Asset ${input.assetId} has an overall risk score of ${input.overallScore} (${input.businessImpact.toLowerCase()} business impact) across ${input.findingCount} open finding(s): ${input.counts.critical} critical, ${input.counts.high} high, ${input.counts.medium} medium, ${input.counts.low + input.counts.informational} low/informational.`;

  try {
    const rendered = riskSummaryPrompt.render({
      assetId: input.assetId,
      overallScore: input.overallScore,
      businessImpact: input.businessImpact,
      findingCount: input.findingCount,
      criticalCount: input.counts.critical,
      highCount: input.counts.high,
      mediumCount: input.counts.medium,
      lowCount: input.counts.low + input.counts.informational,
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
    // No configured LLM provider is expected in most environments running
    // this agent today — graceful degradation to a deterministic
    // summary, never a failed run.
    return fallback;
  }
}

// Rephrases the top N findings' reasoning in prose, in-place on a copy —
// leaves every other field (severity, priority, evidence, confidence)
// untouched. On any LLM failure (timeout, no provider, malformed
// response), returns the findings unchanged with their deterministic
// reasoning from risk.finding.ts intact — "invalid structured output"
// and "LLM timeout" both degrade to this same safe path.
export async function explainTopFindings(findings: RiskFindingView[]): Promise<RiskFindingView[]> {
  const toExplain = findings.slice(0, MAX_LLM_EXPLAINED_FINDINGS);
  if (toExplain.length === 0) {
    return findings;
  }

  const explained = await Promise.all(
    toExplain.map(async (finding) => {
      try {
        const rendered = riskFindingExplanationPrompt.render({
          title: finding.title,
          ruleCode: finding.ruleCode,
          severity: finding.severity,
          resourceId: finding.resourceId,
          defaultReasoning: finding.reasoning,
        });
        const response = await aiFoundation.llmClient.generate({
          model: aiConfig.defaultModel,
          messages: [
            ...(rendered.system ? [{ role: 'system' as const, content: rendered.system }] : []),
            { role: 'user' as const, content: rendered.user },
          ],
          maxTokens: 120,
          temperature: 0.3,
        });
        const text = response.text.trim();
        return text ? { ...finding, reasoning: text } : finding;
      } catch {
        return finding;
      }
    }),
  );

  const explainedById = new Map(explained.map((f) => [f.id, f]));
  return findings.map((finding) => explainedById.get(finding.id) ?? finding);
}
