import { aiFoundation } from '../../foundation.js';
import { aiConfig } from '../../config/index.js';
import { complianceSummaryPrompt, complianceGapExplanationPrompt } from './compliance.prompts.js';
import type { ComplianceControlView } from './compliance.types.js';

// LLM responsibilities for this agent, per the Phase 20 spec: explain
// compliance gaps, summarize missing controls, generate evidence
// summaries, estimate compliance impact, explain why controls fail,
// generate compliance narratives — narration only. The complianceScore,
// control status (PASS/FAIL/MISSING), and priority passed in here are
// always already-computed (compliance.tool.ts/compliance.mapping.ts);
// this file never lets the LLM change them, and every function degrades
// to a deterministic fallback string when no LLM provider is configured,
// so the agent's structured output never depends on an LLM being
// available.

// Rephrases at most this many of the highest-priority gaps (FAIL, then
// MISSING) in prose — bounded to keep latency/cost predictable regardless
// of how many controls a framework has; every other control still
// carries its full deterministic reasoning, unaffected.
const MAX_LLM_EXPLAINED_GAPS = 5;

export async function generateComplianceSummary(input: {
  assetId: string;
  complianceScore: number;
  passCount: number;
  failCount: number;
  warningCount: number;
  frameworkCount: number;
}): Promise<string> {
  const fallback = `Asset ${input.assetId} has a compliance score of ${input.complianceScore} across ${input.frameworkCount} framework(s) assessed: ${input.passCount} controls passed, ${input.failCount} failed, ${input.warningCount} flagged with a warning.`;

  try {
    const rendered = complianceSummaryPrompt.render(input);
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

// Rephrases the top N gaps' (FAIL, then MISSING) reasoning in prose, on a
// copy — leaves every other field (status, priority, evidence,
// confidence) untouched. On any LLM failure (timeout, no provider,
// malformed response), returns the controls unchanged with their
// deterministic reasoning intact.
export async function explainTopGaps(
  controls: ComplianceControlView[],
): Promise<ComplianceControlView[]> {
  const gaps = controls.filter((c) => c.status !== 'PASS').slice(0, MAX_LLM_EXPLAINED_GAPS);
  if (gaps.length === 0) {
    return controls;
  }

  const explained = await Promise.all(
    gaps.map(async (control) => {
      try {
        const rendered = complianceGapExplanationPrompt.render({
          controlName: control.controlName,
          framework: control.framework,
          policyName: control.policyName,
          status: control.status,
          defaultReasoning: control.reasoning,
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
        return text ? { ...control, reasoning: text } : control;
      } catch {
        return control;
      }
    }),
  );

  const key = (c: ComplianceControlView) => `${c.framework}:${c.controlId}`;
  const explainedByKey = new Map(explained.map((c) => [key(c), c]));
  return controls.map((control) => explainedByKey.get(key(control)) ?? control);
}
