import { jobService } from '../../services/jobs/job.service.js';
import type { Requester } from '../../services/assets/ownership.js';
import type { JobPriority, SyncJob } from '../../generated/prisma/client.js';

// Background task queue for orchestrator agent steps, built on this
// project's existing SyncJob queue (Postgres durable record + Redis
// fast-path hint — see services/jobs/job.service.ts) rather than BullMQ:
// this codebase has no BullMQ dependency anywhere else, and SyncJob
// already provides durable retry (RetryService, exponential backoff),
// priority ordering, and dead-letter (JobStatus.DEAD) semantics equivalent
// to what a BullMQ queue would add. See docs/ARCHITECTURE.md for the full
// rationale.
//
// `ORCHESTRATOR_TASK_JOB_TYPE` is a known job type with no dispatcher
// handler registered yet (mirrors WEBHOOK/OAUTH_CALLBACK/AI_* in
// types/job.ts) — enqueueing works today, but a worker attempting to
// dispatch one currently fails immediately with UnsupportedJobTypeError (a
// PermanentJobError, so no retry storm). Registering a real handler in
// job-dispatcher.ts is future-phase work, once a concrete agent exists for
// it to invoke.
export const ORCHESTRATOR_TASK_JOB_TYPE = 'AI_ORCHESTRATOR_AGENT_TASK';

export interface OrchestratorTaskPayload {
  executionId: string;
  stepId: string;
  agentId: string;
  input?: Record<string, unknown>;
}

export interface EnqueueTaskOptions {
  requester: Requester;
  assetId?: string;
  priority?: JobPriority;
  maxAttempts?: number;
  // Best-effort only (an in-process setTimeout before enqueueing) — not
  // durable across a process restart. Acceptable for this phase since no
  // concrete agent task exists yet to actually schedule; a durable delay
  // would need a `scheduledAt` column added to SyncJob, deferred to
  // whichever future phase first needs it.
  delayMs?: number;
}

export interface QueuedTaskHandle {
  jobId: string;
}

export class TaskQueue {
  async enqueue(
    payload: OrchestratorTaskPayload,
    options: EnqueueTaskOptions,
  ): Promise<QueuedTaskHandle> {
    const schedule = async (): Promise<QueuedTaskHandle> => {
      const { job } = await jobService.enqueue({
        type: ORCHESTRATOR_TASK_JOB_TYPE,
        requester: options.requester,
        assetId: options.assetId,
        priority: options.priority,
        maxAttempts: options.maxAttempts,
        payload: { ...payload },
      });
      return { jobId: job.id };
    };

    if (options.delayMs && options.delayMs > 0) {
      return new Promise((resolve, reject) => {
        setTimeout(() => {
          schedule().then(resolve).catch(reject);
        }, options.delayMs);
      });
    }
    return schedule();
  }

  async cancel(jobId: string, requester: Requester): Promise<SyncJob> {
    return jobService.cancel(jobId, requester);
  }

  async status(jobId: string, requester: Requester): Promise<SyncJob> {
    return jobService.getStatus(jobId, requester);
  }
}

export const taskQueue = new TaskQueue();
