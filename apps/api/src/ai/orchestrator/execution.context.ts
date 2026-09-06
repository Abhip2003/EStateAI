// Shared execution context threaded through planning and every step of an
// orchestrator run. Deliberately a distinct type from src/ai/types/context.types.ts's
// `AIContext` (the Phase 16 LLM-call context) — this one is scoped to a
// single workflow execution and carries orchestration-specific state
// (agent outputs, previous decisions) that has no meaning at the LLM-call
// level.
export interface OrchestrationUser {
  id: string;
  role: string;
}

export interface OrchestrationOrganization {
  id?: string;
  name?: string;
}

export interface ConnectedAccountRef {
  id: string;
  provider: string;
}

export interface AssetRef {
  id: string;
  categoryId?: string;
}

export interface AgentOutputEntry {
  stepId: string;
  agentId: string;
  status: 'SUCCESS' | 'FAILED' | 'SKIPPED';
  output?: unknown;
  timestamp: string;
  // Phase 20 additions — optional so every existing caller of
  // recordAgentOutput (which never set these) keeps compiling unchanged.
  // durationMs is copied from the step's own AgentTaskResult by Executor;
  // confidence is opportunistically read off `output.confidenceScore`
  // when the agent exposes one (Discovery/Risk/Compliance/Recommendation/
  // Report all do) — this is what lets downstream agents and the trace
  // API report per-step confidence without re-parsing each agent's
  // distinct output shape.
  durationMs?: number;
  confidence?: number;
}

export interface ToolOutputEntry {
  toolName: string;
  input: unknown;
  output: unknown;
  timestamp: string;
}

export interface PreviousDecisionEntry {
  decision: string;
  reason?: string;
  timestamp: string;
}

export interface OrchestrationContext {
  readonly executionId: string;
  readonly user: OrchestrationUser;
  readonly organization?: OrchestrationOrganization;
  readonly connectedAccounts: ConnectedAccountRef[];
  readonly assets: AssetRef[];
  readonly workflowId?: string;
  readonly conversationId?: string;
  readonly metadata: Record<string, unknown>;
  readonly agentOutputs: AgentOutputEntry[];
  readonly toolOutputs: ToolOutputEntry[];
  readonly previousDecisions: PreviousDecisionEntry[];
  readonly memoryReferences: string[];
}

export interface OrchestrationContextInput {
  executionId: string;
  user: OrchestrationUser;
  organization?: OrchestrationOrganization;
  connectedAccounts?: ConnectedAccountRef[];
  assets?: AssetRef[];
  workflowId?: string;
  conversationId?: string;
  metadata?: Record<string, unknown>;
  memoryReferences?: string[];
}

export function buildOrchestrationContext(input: OrchestrationContextInput): OrchestrationContext {
  return {
    executionId: input.executionId,
    user: input.user,
    organization: input.organization,
    connectedAccounts: input.connectedAccounts ?? [],
    assets: input.assets ?? [],
    workflowId: input.workflowId,
    conversationId: input.conversationId,
    metadata: input.metadata ?? {},
    agentOutputs: [],
    toolOutputs: [],
    previousDecisions: [],
    memoryReferences: input.memoryReferences ?? [],
  };
}

export function recordAgentOutput(
  context: OrchestrationContext,
  entry: Omit<AgentOutputEntry, 'timestamp'>,
): void {
  context.agentOutputs.push({ ...entry, timestamp: new Date().toISOString() });
}

export function recordToolOutput(
  context: OrchestrationContext,
  entry: Omit<ToolOutputEntry, 'timestamp'>,
): void {
  context.toolOutputs.push({ ...entry, timestamp: new Date().toISOString() });
}

export function recordDecision(
  context: OrchestrationContext,
  decision: string,
  reason?: string,
): void {
  context.previousDecisions.push({ decision, reason, timestamp: new Date().toISOString() });
}
