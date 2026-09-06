import { knowledgeService } from './knowledge.service.js';
import { eventService } from '../assets/event.service.js';
import { getOwnedAsset, type Requester } from '../assets/ownership.js';
import { Prisma } from '../../generated/prisma/client.js';
import type { RetrievalRequest } from './dto/retrieval-request.js';
import type { KnowledgeContext } from './dto/knowledge-context.js';

export interface BuildContextInput {
  assetId: string;
  accountId?: string;
  focus?: string;
  requester: Requester;
}

// The front door of the Knowledge Retrieval Framework — Agent (or, today,
// AIService/the HTTP route) → ContextBuilder → KnowledgeService →
// retrievers → PromptBuilder. Thin: it only checks ownership, brackets
// the operation with CONTEXT_BUILD_STARTED/COMPLETED events (mirroring
// AgentOrchestrator's PLAN_CREATED/PLAN_COMPLETED), and delegates the
// actual retrieval/merge/trim work to KnowledgeService.
class ContextBuilder {
  async build(input: BuildContextInput): Promise<KnowledgeContext> {
    await getOwnedAsset(input.assetId, input.requester);

    const request: RetrievalRequest = {
      assetId: input.assetId,
      accountId: input.accountId,
      focus: input.focus,
      requester: input.requester,
    };

    await this.emitEvent(request, 'CONTEXT_BUILD_STARTED', { focus: input.focus });
    const context = await knowledgeService.retrieveAndBuildContext(request);
    await this.emitEvent(request, 'CONTEXT_BUILD_COMPLETED', {
      totalItems: context.metadata.totalItemsAfterTrim,
      estimatedTokens: context.metadata.estimatedTokens,
      truncated: context.metadata.truncated,
    });

    return context;
  }

  private async emitEvent(
    request: RetrievalRequest,
    type: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    try {
      await eventService.createForAsset(request.assetId, request.requester, {
        type,
        severity: 'INFO',
        title: type,
        metadata: metadata as Prisma.InputJsonValue,
      });
    } catch {
      // Best-effort — see ResourceService.emitEvent for the same reasoning.
    }
  }
}

export const contextBuilder = new ContextBuilder();
