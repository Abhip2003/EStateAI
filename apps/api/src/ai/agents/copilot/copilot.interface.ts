import type { AIContext } from '../../types/context.types.js';
import type { OrchestrationContext } from '../../orchestrator/execution.context.js';
import type { ConversationTurn } from '../../types/memory.types.js';
import type {
  CopilotExplanation,
  CopilotIntent,
  CopilotRunStatus,
  CopilotTriggeredWorkflow,
  CopilotSessionState,
  CopilotSummaryRecord,
  CopilotFailureRecord,
} from './copilot.types.js';

export interface CopilotExecutorInput {
  assetId?: string;
  conversationId: string;
  message: string;
}

// Superset of the Phase 17 placeholder `CopilotAgent` interface's fixed
// `{answer, citations?}` output.
export interface CopilotAgentOutput {
  status: CopilotRunStatus;
  answer: string;
  explanation: CopilotExplanation;
  intent: CopilotIntent;
  assetId?: string;
  conversationId: string;
  triggeredWorkflow?: CopilotTriggeredWorkflow;
  sourceAgents: string[];
  citations?: string[];
  metadata: {
    startedAt: string;
    finishedAt: string;
    durationMs: number;
  };
  confidenceScore: number;
  warnings: string[];
  errors: string[];
}

export interface ICopilotExecutor {
  run(
    input: CopilotExecutorInput,
    aiContext: AIContext,
    orchestrationContext: OrchestrationContext,
  ): Promise<CopilotAgentOutput>;
}

// Composes the Phase 16 ConversationMemory (turn log) + SessionMemory
// (short-lived "what were we just talking about" scratch space) into one
// domain-facing interface, plus its own execution-trace history — the
// same additive-wrapper shape every other agent's *Memory class uses
// over the shared MemoryStore abstraction.
export interface ICopilotMemory {
  appendTurn(conversationId: string, role: 'user' | 'assistant', content: string): Promise<void>;
  getTurns(conversationId: string): Promise<ConversationTurn[]>;
  clearConversation(conversationId: string): Promise<void>;
  getSessionState(conversationId: string): Promise<CopilotSessionState | undefined>;
  setSessionState(conversationId: string, state: CopilotSessionState): Promise<void>;
  recordRun(record: CopilotSummaryRecord): Promise<void>;
  getHistory(conversationId: string, limit?: number): Promise<CopilotSummaryRecord[]>;
  recordFailure(record: CopilotFailureRecord): Promise<void>;
}
