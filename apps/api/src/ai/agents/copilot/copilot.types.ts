// Shared, plain data types for the Copilot Agent — mirrors the file split
// every other agent under src/ai/agents/ established (types here, zod
// schemas in copilot.schemas.ts, class-level contracts in
// copilot.interface.ts).

export type CopilotRunStatus = 'SUCCESS' | 'PARTIAL' | 'FAILED';

// What the user's message was classified as (copilot.intent.ts) — a
// deterministic keyword classifier, same "not an LLM call" approach
// Planner.resolveWorkflowId() uses for workflow intent, applied here to
// conversational intent instead.
export type CopilotIntent =
  | 'EXPLAIN_RISK'
  | 'EXPLAIN_COMPLIANCE'
  | 'EXPLAIN_RECOMMENDATION'
  | 'SUMMARIZE_REPORT'
  | 'ANALYZE'
  | 'FOLLOW_UP'
  | 'GENERAL';

// Every answer's required shape per spec: Summary, Reasoning, Evidence,
// Suggested action, Confidence — built deterministically from whichever
// existing agent data was available, then optionally rephrased in prose
// by the LLM (copilot.summary.ts), same graceful-degradation pattern
// every other agent's summary module uses.
export interface CopilotExplanation {
  summary: string;
  reasoning: string;
  evidence: string[];
  suggestedAction: string;
  confidence: number; // 0-100
}

// Which upstream workflow (if any) was auto-triggered because the
// requested information didn't exist yet (Phase 22 goal #4 — Intelligent
// Routing).
export interface CopilotTriggeredWorkflow {
  workflowId: string;
  executionId: string;
  status: string;
}

// Session-scoped conversational state — "what the user was just talking
// about" — read/written via aiFoundation.sessionMemory, keyed by
// conversationId. Lets a follow-up ("explain that", "why") resolve
// without the user repeating assetId/topic.
export interface CopilotSessionState {
  lastAssetId?: string;
  lastWorkflowId?: string;
  lastIntent?: CopilotIntent;
  lastRecommendationId?: string;
  lastQuestion?: string;
  updatedAt: string;
}

export interface CopilotSummaryRecord {
  conversationId: string;
  assetId?: string;
  status: CopilotRunStatus;
  intent: CopilotIntent;
  question: string;
  triggeredWorkflowId?: string;
  agentsUsed: string[];
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  confidenceScore: number;
  warnings: string[];
  errors: string[];
}

export interface CopilotFailureRecord {
  conversationId: string;
  message: string;
  timestamp: string;
}
