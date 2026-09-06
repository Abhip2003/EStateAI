import { aiService } from '../ai/ai.service.js';
import { eventService } from '../assets/event.service.js';
import { getOwnedAsset } from '../assets/ownership.js';
import { Prisma } from '../../generated/prisma/client.js';
import { CopilotChatStatus } from './dto/copilot-chat.js';
import type { CopilotChatInput, CopilotChatResult } from './dto/copilot-chat.js';

const SYSTEM_PROMPT =
  'You are a security copilot answering questions about a single asset. Use ' +
  'only the grounded context you are given (resources, relationships, ' +
  'findings, policies, recommendations, risk) to answer. If the context does ' +
  'not contain the answer, say so plainly rather than guessing.';

// Thin by design: all retrieval (ContextBuilder -> KnowledgeService) and all
// provider mechanics (PromptBuilder -> AIService -> Provider) already exist
// and are reused verbatim via AIService.generate() — CopilotService adds
// nothing to that chain except a system prompt, event emission, and
// reshaping AIService's response into a chat-shaped result. Never calls
// ContextBuilder/KnowledgeService/PromptBuilder/a provider directly.
class CopilotService {
  async chat(input: CopilotChatInput): Promise<CopilotChatResult> {
    await getOwnedAsset(input.assetId, input.requester);

    await this.emitEvent(input, 'COPILOT_CHAT_STARTED', {});

    try {
      const response = await aiService.generate({
        requester: input.requester,
        assetId: input.assetId,
        systemPrompt: SYSTEM_PROMPT,
        prompt: input.message,
        focus: 'COPILOT_CHAT',
      });

      const result: CopilotChatResult = {
        status: CopilotChatStatus.SUCCESS,
        answer: response.text,
        citations: response.citations,
        metadata: {
          provider: response.provider,
          model: response.model,
          promptTokens: response.usage.promptTokens,
          completionTokens: response.usage.completionTokens,
          totalTokens: response.usage.totalTokens,
          estimatedCostUsd: response.estimatedCostUsd,
          latencyMs: response.latencyMs,
          generatedAt: new Date().toISOString(),
        },
      };

      await this.emitEvent(input, 'COPILOT_CHAT_COMPLETED', {
        provider: response.provider,
        model: response.model,
      });
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.emitEvent(input, 'COPILOT_CHAT_FAILED', { error: message });
      return { status: CopilotChatStatus.FAILED, error: message };
    }
  }

  private async emitEvent(
    input: CopilotChatInput,
    type: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    try {
      await eventService.createForAsset(input.assetId, input.requester, {
        type,
        severity: type === 'COPILOT_CHAT_FAILED' ? 'WARNING' : 'INFO',
        title: type,
        metadata: metadata as Prisma.InputJsonValue,
      });
    } catch {
      // Best-effort — see ResourceService.emitEvent for the same reasoning.
    }
  }
}

export const copilotService = new CopilotService();
