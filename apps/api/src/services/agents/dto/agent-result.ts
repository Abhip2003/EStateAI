export type AgentResultStatus = 'SUCCESS' | 'FAILED' | 'SKIPPED';

// What TaskService.runTask returns for one task attempt-set. `attempts`
// counts actual execute() calls made (0 for SKIPPED, since a skipped task
// never calls its agent). `data` is only present on SUCCESS.
export interface AgentResult {
  taskId: string;
  agentId: string;
  status: AgentResultStatus;
  startedAt: Date;
  durationMs: number;
  attempts: number;
  data?: Record<string, unknown>;
  error?: string;
}
