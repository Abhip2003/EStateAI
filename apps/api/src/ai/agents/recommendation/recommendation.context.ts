import { buildAIContext } from '../../context/ai-context-builder.js';
import type { AIContext } from '../../types/context.types.js';
import type { OrchestrationContext } from '../../orchestrator/execution.context.js';

export function buildRecommendationAIContext(
  orchestrationContext: OrchestrationContext,
): AIContext {
  return buildAIContext({
    user: orchestrationContext.user,
    conversationId: orchestrationContext.conversationId,
    workflow: orchestrationContext.workflowId ?? 'recommendation-agent',
    metadata: orchestrationContext.metadata,
  });
}
