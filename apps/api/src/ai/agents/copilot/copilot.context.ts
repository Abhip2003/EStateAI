import { buildAIContext } from '../../context/ai-context-builder.js';
import type { AIContext } from '../../types/context.types.js';
import type { OrchestrationContext } from '../../orchestrator/execution.context.js';

export function buildCopilotAIContext(orchestrationContext: OrchestrationContext): AIContext {
  return buildAIContext({
    user: orchestrationContext.user,
    conversationId: orchestrationContext.conversationId,
    workflow: orchestrationContext.workflowId ?? 'copilot-agent',
    metadata: orchestrationContext.metadata,
  });
}
