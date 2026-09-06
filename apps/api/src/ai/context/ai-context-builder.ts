import type {
  AIContext,
  AIContextAsset,
  AIContextSession,
  AIContextUser,
} from '../types/context.types.js';

export interface AIContextInput {
  user: AIContextUser;
  session?: AIContextSession;
  asset?: AIContextAsset;
  conversationId?: string;
  workflow?: string;
  metadata?: Record<string, unknown>;
}

// Builds a fresh AIContext for one interaction (a single LLM call, a
// single tool-using turn, a single agent step in future phases).
// toolHistory/executionHistory always start empty here — they accumulate
// via ToolRegistry.execute() and recordExecutionStep() over the life of
// that one context, not across separate interactions (that's what
// memory/ is for).
export function buildAIContext(input: AIContextInput): AIContext {
  return {
    user: input.user,
    session: input.session,
    asset: input.asset,
    conversationId: input.conversationId,
    workflow: input.workflow,
    metadata: input.metadata,
    toolHistory: [],
    executionHistory: [],
  };
}

export function recordExecutionStep(
  context: AIContext,
  step: string,
  detail?: Record<string, unknown>,
): void {
  context.executionHistory.push({
    step,
    timestamp: new Date().toISOString(),
    detail,
  });
}
