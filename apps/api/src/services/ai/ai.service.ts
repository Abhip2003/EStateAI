import { config } from '../../config/env.js';
import { aiProviderRegistry } from './provider-registry.js';
import { promptBuilder } from './prompt-builder.js';
import { AIProviderTransientError } from './ai-errors.js';
import { aiRequestLogRepository } from '../../repositories/ai-request-log.repository.js';
import { eventService } from '../assets/event.service.js';
import { getOwnedAsset, type Requester } from '../assets/ownership.js';
import { Prisma } from '../../generated/prisma/client.js';
import { contextBuilder } from '../knowledge/context-builder.js';
import { logger } from '../../observability/logger.js';
import {
  aiFailuresTotal,
  aiRequestDurationSeconds,
  aiRequestsTotal,
  aiTokensTotal,
} from '../../observability/metrics.js';
import type { AIProvider } from './provider.interface.js';
import type { AIResponse } from './dto/ai-response.js';
import type { KnowledgeContext } from '../knowledge/dto/knowledge-context.js';
import './providers/index.js';

export interface GenerateInput {
  requester: Requester;
  provider?: string;
  model?: string;
  systemPrompt?: string;
  prompt: string;
  maxTokens?: number;
  temperature?: number;
  // Optional: an AI request isn't inherently tied to an asset (unlike
  // /agents/execute) — when provided, ownership is checked, a
  // KnowledgeContext is built and handed to PromptBuilder (Phase 7C), and
  // events are emitted against it; when omitted, this call is a
  // standalone utility request with no automatic context and no events
  // (there's no user-level or global event stream in this codebase, only
  // per-asset).
  assetId?: string;
  // What the KnowledgeContext is being gathered for — passed straight
  // through to ContextBuilder/retrievers as a hint; see RetrievalRequest.
  focus?: string;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Resolves which provider (and, if unspecified, which of its models)
// handles this request. An explicit `provider` always wins; otherwise an
// explicit `model` is routed via whichever registered provider
// supports() it; otherwise config.ai.defaultProvider decides — this is
// what "Provider selected via configuration" means in practice.
function resolveProviderAndModel(input: GenerateInput): { provider: AIProvider; model: string } {
  if (input.provider) {
    const provider = aiProviderRegistry.resolve(input.provider);
    return { provider, model: input.model ?? provider.models()[0] };
  }
  if (input.model) {
    const provider = aiProviderRegistry.resolveForModel(input.model);
    return { provider, model: input.model };
  }
  const provider = aiProviderRegistry.resolve(config.ai.defaultProvider);
  return { provider, model: provider.models()[0] };
}

// Orchestrates a single AI call end-to-end: select provider → build
// prompt → execute with retry → parse (providers already return a
// standardized AIResponse) → track usage. Agents never call providers
// directly — this is the one path every AI call flows through, per the
// spec's "All AI calls flow through AIService" requirement.
class AIService {
  async generate(input: GenerateInput): Promise<AIResponse> {
    if (input.assetId) {
      await getOwnedAsset(input.assetId, input.requester);
    }

    const { provider, model } = resolveProviderAndModel(input);

    // Auto-build a KnowledgeContext whenever this call is asset-scoped —
    // this is what makes every asset-scoped AI call automatically
    // grounded in that asset's current resources/findings/policies/risk,
    // without any Agent needing to gather that context itself (Phase 7C).
    // Degrades gracefully rather than failing the whole request: a
    // knowledge-layer hiccup shouldn't block generation, it should just
    // mean this one call runs without the extra grounding.
    let knowledgeContext: KnowledgeContext | undefined;
    if (input.assetId) {
      try {
        knowledgeContext = await contextBuilder.build({
          assetId: input.assetId,
          focus: input.focus,
          requester: input.requester,
        });
      } catch {
        knowledgeContext = undefined;
      }
    }

    const request = promptBuilder.build(
      {
        systemPrompt: input.systemPrompt,
        userPrompt: input.prompt,
        model,
        maxTokens: input.maxTokens,
        temperature: input.temperature,
        knowledgeContext,
      },
      config.ai.defaultMaxTokens,
    );

    await this.emitEvent(input, 'AI_REQUEST_STARTED', { provider: provider.id(), model });

    const startedAt = Date.now();
    let attempts = 0;
    let lastError: unknown;

    while (attempts < config.ai.maxRetries) {
      attempts += 1;
      try {
        const response = await provider.generate(request);
        await this.recordAndEmitSuccess(input, response, attempts, startedAt);
        return response;
      } catch (err) {
        lastError = err;
        // A permanent rejection (bad key, malformed request) is never
        // worth retrying — only AIProviderTransientError is.
        if (!(err instanceof AIProviderTransientError)) {
          break;
        }
        if (attempts < config.ai.maxRetries) {
          await delay(config.ai.retryBackoffMs);
        }
      }
    }

    await this.recordAndEmitFailure(input, provider.id(), model, attempts, lastError, startedAt);
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async recordAndEmitSuccess(
    input: GenerateInput,
    response: AIResponse,
    attempts: number,
    startedAt: number,
  ): Promise<void> {
    const durationSeconds = (Date.now() - startedAt) / 1000;
    const labels = { provider: response.provider, model: response.model, status: 'SUCCESS' };
    aiRequestsTotal.inc(labels);
    aiRequestDurationSeconds.observe(labels, durationSeconds);
    aiTokensTotal.inc(
      { provider: response.provider, model: response.model, kind: 'prompt' },
      response.usage.promptTokens,
    );
    aiTokensTotal.inc(
      { provider: response.provider, model: response.model, kind: 'completion' },
      response.usage.completionTokens,
    );
    logger.info(
      {
        provider: response.provider,
        model: response.model,
        attempts,
        latencyMs: response.latencyMs,
        totalTokens: response.usage.totalTokens,
        estimatedCostUsd: response.estimatedCostUsd,
      },
      'ai request completed',
    );
    await aiRequestLogRepository.create({
      provider: response.provider,
      model: response.model,
      assetId: input.assetId,
      status: 'SUCCESS',
      promptTokens: response.usage.promptTokens,
      completionTokens: response.usage.completionTokens,
      totalTokens: response.usage.totalTokens,
      estimatedCostUsd: response.estimatedCostUsd,
      latencyMs: response.latencyMs,
      attempts,
    });
    await this.emitEvent(input, 'AI_REQUEST_COMPLETED', {
      provider: response.provider,
      model: response.model,
      finishReason: response.finishReason,
      attempts,
    });
    await this.emitEvent(input, 'TOKEN_USAGE_RECORDED', {
      provider: response.provider,
      model: response.model,
      usage: response.usage,
      estimatedCostUsd: response.estimatedCostUsd,
    });
  }

  private async recordAndEmitFailure(
    input: GenerateInput,
    provider: string,
    model: string,
    attempts: number,
    error: unknown,
    startedAt: number,
  ): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    const durationSeconds = (Date.now() - startedAt) / 1000;
    const labels = { provider, model, status: 'FAILED' };
    aiRequestsTotal.inc(labels);
    aiRequestDurationSeconds.observe(labels, durationSeconds);
    aiFailuresTotal.inc({ provider, model });
    logger.error({ provider, model, attempts, error: message }, 'ai request failed');
    await aiRequestLogRepository.create({
      provider,
      model,
      assetId: input.assetId,
      status: 'FAILED',
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      estimatedCostUsd: 0,
      latencyMs: Date.now() - startedAt,
      attempts,
      error: message,
    });
    await this.emitEvent(input, 'AI_REQUEST_FAILED', { provider, model, attempts, error: message });
  }

  private async emitEvent(
    input: GenerateInput,
    type: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    if (!input.assetId) {
      return;
    }
    try {
      await eventService.createForAsset(input.assetId, input.requester, {
        type,
        severity: type === 'AI_REQUEST_FAILED' ? 'WARNING' : 'INFO',
        title: type,
        metadata: metadata as Prisma.InputJsonValue,
      });
    } catch {
      // Best-effort — see ResourceService.emitEvent for the same reasoning.
    }
  }
}

export const aiService = new AIService();
