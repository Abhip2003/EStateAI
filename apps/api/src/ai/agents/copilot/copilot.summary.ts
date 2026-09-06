import { aiFoundation } from '../../foundation.js';
import { aiConfig } from '../../config/index.js';
import { copilotAnswerPrompt } from './copilot.prompts.js';
import type { CopilotExplanation } from './copilot.types.js';

// Turns a deterministic CopilotExplanation into one prose answer.
// Never lets the LLM change summary/reasoning/evidence/suggestedAction
// (those are returned unchanged in CopilotAgentOutput.explanation
// regardless of whether this succeeds) — this only produces the
// conversational `answer` string layered on top. Falls back to a
// deterministic concatenation on any LLM failure/absence, same pattern
// every other agent's summary module uses.
export async function generateAnswer(input: {
  question: string;
  explanation: CopilotExplanation;
}): Promise<string> {
  const fallback = [
    input.explanation.summary,
    input.explanation.reasoning,
    input.explanation.suggestedAction
      ? `Suggested action: ${input.explanation.suggestedAction}`
      : '',
  ]
    .filter(Boolean)
    .join(' ');

  try {
    const rendered = copilotAnswerPrompt.render({
      question: input.question,
      summary: input.explanation.summary,
      reasoning: input.explanation.reasoning,
      evidence: input.explanation.evidence.join('; ') || 'none',
      suggestedAction: input.explanation.suggestedAction || 'none',
    });
    const response = await aiFoundation.llmClient.generate({
      model: aiConfig.defaultModel,
      messages: [
        ...(rendered.system ? [{ role: 'system' as const, content: rendered.system }] : []),
        { role: 'user' as const, content: rendered.user },
      ],
      maxTokens: 300,
      temperature: 0.4,
    });
    return response.text.trim() || fallback;
  } catch {
    return fallback;
  }
}
