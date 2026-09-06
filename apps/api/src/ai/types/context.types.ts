export interface AIContextUser {
  id: string;
  role: string;
}

export interface AIContextSession {
  sessionId: string;
  startedAt: string;
}

export interface AIContextAsset {
  assetId: string;
  categoryId?: string;
}

export interface AIToolHistoryEntry {
  toolName: string;
  input: unknown;
  output: unknown;
  durationMs: number;
  timestamp: string;
  error?: string;
}

export interface AIExecutionHistoryEntry {
  step: string;
  timestamp: string;
  detail?: Record<string, unknown>;
}

// The shared, request-scoped context threaded through every LLM call, tool
// execution, and memory read/write for a given interaction. Not persisted
// as-is — memory/ persists conversation turns; this carries the
// in-flight execution state around them (who's asking, what asset/session
// they're in, and what's happened so far this turn).
export interface AIContext {
  user: AIContextUser;
  session?: AIContextSession;
  asset?: AIContextAsset;
  conversationId?: string;
  workflow?: string;
  metadata?: Record<string, unknown>;
  toolHistory: AIToolHistoryEntry[];
  executionHistory: AIExecutionHistoryEntry[];
}
