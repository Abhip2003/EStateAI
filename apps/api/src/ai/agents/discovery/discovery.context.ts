import { buildAIContext } from '../../context/ai-context-builder.js';
import type { AIContext } from '../../types/context.types.js';
import type { OrchestrationContext } from '../../orchestrator/execution.context.js';

// Bridges the two context types that meet at the Discovery Agent's
// boundary: OrchestratorAgent.execute() receives an OrchestrationContext
// (Phase 17, scoped to one workflow execution), while ToolRegistry.execute()
// requires an AIContext (Phase 16, scoped to one LLM/tool call chain).
// They're deliberately different types (see ai/orchestrator's own docs) —
// this is the one place the Discovery Agent translates between them,
// rather than either module depending on the other's shape.
export function buildDiscoveryAIContext(orchestrationContext: OrchestrationContext): AIContext {
  return buildAIContext({
    user: orchestrationContext.user,
    conversationId: orchestrationContext.conversationId,
    workflow: orchestrationContext.workflowId ?? 'discovery-agent',
    metadata: orchestrationContext.metadata,
  });
}
