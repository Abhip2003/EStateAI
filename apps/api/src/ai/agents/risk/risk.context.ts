import { buildAIContext } from '../../context/ai-context-builder.js';
import type { AIContext } from '../../types/context.types.js';
import type { OrchestrationContext } from '../../orchestrator/execution.context.js';

// Bridges the two context types that meet at the Risk Agent's boundary —
// same reasoning as discovery.context.ts's buildDiscoveryAIContext:
// OrchestratorAgent.execute() receives an OrchestrationContext (Phase 17,
// scoped to one workflow execution), while ToolRegistry.execute() requires
// an AIContext (Phase 16, scoped to one LLM/tool call chain).
export function buildRiskAIContext(orchestrationContext: OrchestrationContext): AIContext {
  return buildAIContext({
    user: orchestrationContext.user,
    conversationId: orchestrationContext.conversationId,
    workflow: orchestrationContext.workflowId ?? 'risk-agent',
    metadata: orchestrationContext.metadata,
  });
}
