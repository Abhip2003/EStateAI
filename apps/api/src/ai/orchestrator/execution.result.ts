import type { AgentTaskStatus, WorkflowStatus } from './types.js';

export interface AgentTaskResult {
  stepId: string;
  agentId: string;
  status: AgentTaskStatus;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  attempts: number;
  output?: unknown;
  error?: string;
}

// Aggregated outcome of one full orchestrator execution — `data` merges
// each successful step's output keyed by agentId (mirrors the
// SUCCESS/PARTIAL/FAILED roll-up shape services/agents/result-aggregator.ts
// already uses for the pre-existing agent system, reimplemented
// independently here since this module must not import from services/agents/).
export interface ExecutionResult {
  executionId: string;
  workflowId: string;
  status: WorkflowStatus;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  steps: AgentTaskResult[];
  data: Record<string, unknown>;
  error?: string;
}
