import { buildAIContext } from '../../context/ai-context-builder.js';
import type { AIContext } from '../../types/context.types.js';
import type { OrchestrationContext } from '../../orchestrator/execution.context.js';

// Bridges the two context types that meet at the Compliance Agent's
// boundary — same reasoning as risk.context.ts's buildRiskAIContext:
// OrchestratorAgent.execute() receives an OrchestrationContext (Phase 17,
// scoped to one workflow execution), while ToolRegistry.execute() requires
// an AIContext (Phase 16, scoped to one LLM/tool call chain).
export function buildComplianceAIContext(orchestrationContext: OrchestrationContext): AIContext {
  return buildAIContext({
    user: orchestrationContext.user,
    conversationId: orchestrationContext.conversationId,
    workflow: orchestrationContext.workflowId ?? 'compliance-agent',
    metadata: orchestrationContext.metadata,
  });
}
