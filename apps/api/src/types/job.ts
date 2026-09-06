import type { SyncJob } from '../generated/prisma/client.js';

export type Job = SyncJob;

export { JobPriority } from '../generated/prisma/client.js';

// Free-form on purpose (stored as a plain string column, not a DB enum) —
// same reasoning as Account.provider: a new job type must never require a
// migration, only a new dispatcher registration. This is the known set
// today; future types (real AI job types, new integrations) just add a key
// here and register a handler in job-dispatcher.ts.
export const JobType = {
  SYNC: 'SYNC',
  DISCOVERY: 'DISCOVERY',
  REFRESH_TOKEN: 'REFRESH_TOKEN',
  OAUTH_CALLBACK: 'OAUTH_CALLBACK',
  WEBHOOK: 'WEBHOOK',
  AI_DISCOVERY: 'AI_DISCOVERY',
  AI_ANALYSIS: 'AI_ANALYSIS',
  AI_RISK: 'AI_RISK',
  AI_COMPLIANCE: 'AI_COMPLIANCE',
  AI_RECOMMENDATION: 'AI_RECOMMENDATION',
  AI_REPORT: 'AI_REPORT',
  // Phase 33 — the complete security-analysis LangGraph workflow, run in
  // one shot by the Python AI service (only when AI_SERVICE_MODE=python;
  // there is no in-process TS equivalent, so this handler no-ops with a
  // clear error under typescript mode).
  AI_FULL_ANALYSIS: 'AI_FULL_ANALYSIS',
  AI_COST: 'AI_COST',
  AI_NOTIFICATION: 'AI_NOTIFICATION',
  // Phase 17 — background execution of one Orchestrator Agent workflow
  // step. No dispatcher handler registered yet (see
  // ai/orchestrator/task.queue.ts); added here only so TaskQueue can
  // enqueue against a real, typed job type.
  AI_ORCHESTRATOR_AGENT_TASK: 'AI_ORCHESTRATOR_AGENT_TASK',
} as const;

export type JobType = (typeof JobType)[keyof typeof JobType];
