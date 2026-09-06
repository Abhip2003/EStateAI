import type { CopilotAgent as CopilotAgentContract } from '../../orchestrator/agents/copilot-agent.interface.js';
import type { OrchestrationContext } from '../../orchestrator/execution.context.js';
import { buildCopilotAIContext } from './copilot.context.js';
import type { ICopilotExecutor, CopilotAgentOutput } from './copilot.interface.js';

// Implements the Phase 17 placeholder `CopilotAgent` interface — the
// sixth and last of the six original `src/ai/orchestrator/agents/`
// placeholder roles. `CopilotAgentOutput` is a strict superset of that
// interface's fixed `{answer, citations?}` output. Registered under
// orchestratorAgentRegistry with id 'copilot-agent' (see index.ts).
//
// Unlike Discovery/Risk/Compliance/Recommendation/Report, this agent's
// primary entry point is conversational (POST /ai/copilot/chat), not a
// DAG step — but it still implements the same OrchestratorAgent contract
// so it can also be invoked as a workflow step if a future workflow ever
// wants one, and so its own Intelligent Routing can trigger *other*
// workflows through the same OrchestratorService every other agent's
// routing goes through, never by calling another agent directly.
export class CopilotAgentImpl implements CopilotAgentContract {
  readonly id = 'copilot-agent' as const;
  readonly description =
    "The primary conversational interface for EstateAI — answers questions about an asset's risk, compliance, and recommendations by reading existing Risk/Compliance/Recommendation Agent data, auto-triggering the relevant workflow through the existing orchestrator when that data does not exist yet, and maintaining per-conversation memory for follow-up questions. Never computes a score or generates a finding/recommendation itself.";

  constructor(private readonly executor: ICopilotExecutor) {}

  canHandle(taskType: string): boolean {
    return /copilot|chat|ask/i.test(taskType);
  }

  async execute(
    input: { assetId?: string; conversationId?: string; message: string },
    context: OrchestrationContext,
  ): Promise<CopilotAgentOutput> {
    const aiContext = buildCopilotAIContext(context);
    const conversationId = input.conversationId ?? context.conversationId ?? context.executionId;
    return this.executor.run(
      { assetId: input.assetId, conversationId, message: input.message },
      aiContext,
      context,
    );
  }
}
