// Overall lifecycle status of one orchestrator execution (a full workflow
// run) and of a single step within it — kept as two distinct unions since
// a workflow can be PARTIAL while individual steps are only ever
// SUCCESS/FAILED/SKIPPED/CANCELLED/TIMED_OUT.
export type WorkflowStatus =
  'PENDING' | 'RUNNING' | 'COMPLETED' | 'PARTIAL' | 'FAILED' | 'CANCELLED' | 'TIMED_OUT';

export type AgentTaskStatus = 'SUCCESS' | 'FAILED' | 'SKIPPED' | 'CANCELLED' | 'TIMED_OUT';
