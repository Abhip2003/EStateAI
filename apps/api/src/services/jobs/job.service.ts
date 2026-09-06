import { jobRepository, type ListJobsParams } from '../../repositories/job.repository.js';
import { redis } from '../../cache/redis.js';
import { config } from '../../config/env.js';
import { eventService } from '../assets/event.service.js';
import { getOwnedAccount } from '../assets/account.service.js';
import { getOwnedAsset, isOwnerOrAdmin, type Requester } from '../assets/ownership.js';
import { ForbiddenError } from '../auth/errors.js';
import { JobNotCancellableError, JobNotFoundError, JobNotRetryableError } from './job-errors.js';
import { isTerminalJobStatus } from '../../types/job-status.js';
import type { JobPriority } from '../../types/job.js';
import type { SyncJob } from '../../generated/prisma/client.js';
import type { PaginatedResult } from '../../repositories/pagination.js';

// The Redis-backed fast path: pushing a job id here lets an idle worker
// pick it up on its very next poll tick instead of waiting out the full
// interval. Postgres (via JobRepository) remains the durable source of
// truth and the only thing that actually guarantees exactly-once claiming
// — losing this list (Redis restart, a missed push) only costs latency,
// never correctness, because workers always fall back to polling
// JobRepository.claimNextJob() directly.
const JOB_QUEUE_KEY = 'jobs:queue';

export interface EnqueueJobInput {
  type: string;
  requester: Requester;
  provider?: string;
  accountId?: string;
  assetId?: string;
  priority?: JobPriority;
  maxAttempts?: number;
  payload?: Record<string, unknown>;
}

export interface EnqueueResult {
  job: SyncJob;
  queueDepth: number;
}

export type ListJobsQuery = ListJobsParams;

async function getAuthorizedJob(jobId: string, requester: Requester): Promise<SyncJob> {
  const job = await jobRepository.findById(jobId);
  if (!job) {
    throw new JobNotFoundError(jobId);
  }
  if (job.assetId) {
    const asset = await getOwnedAsset(job.assetId, requester);
    if (!isOwnerOrAdmin(asset, requester)) {
      throw new ForbiddenError('You do not have access to this job');
    }
  } else if (requester.role !== 'ADMIN') {
    throw new ForbiddenError('Only administrators can access jobs with no associated asset');
  }
  return job;
}

class JobService {
  async enqueue(input: EnqueueJobInput): Promise<EnqueueResult> {
    if (input.assetId) {
      await getOwnedAsset(input.assetId, input.requester);
    }

    const job = await jobRepository.create({
      type: input.type,
      provider: input.provider,
      accountId: input.accountId,
      assetId: input.assetId,
      priority: input.priority ?? 'NORMAL',
      maxAttempts: input.maxAttempts ?? config.jobs.defaultMaxAttempts,
      payload: {
        ...input.payload,
        requesterId: input.requester.id,
        requesterRole: input.requester.role,
      },
    });

    await redis.rpush(JOB_QUEUE_KEY, job.id);

    if (job.assetId) {
      await eventService.createForAsset(job.assetId, input.requester, {
        type: 'JOB_CREATED',
        severity: 'INFO',
        title: `${job.type} job queued`,
        metadata: { jobId: job.id, jobType: job.type, priority: job.priority },
      });
    }

    const queueDepth = await jobRepository.countPending();
    return { job, queueDepth };
  }

  // Thin wrapper used by routes that enqueue work against a specific
  // account (sync, discovery, ...) — reuses AccountService's own
  // ownership-resolution helper instead of duplicating the "load account,
  // check ownership" logic here.
  async enqueueForAccount(
    type: string,
    accountId: string,
    requester: Requester,
    options: { priority?: JobPriority; payload?: Record<string, unknown> } = {},
  ): Promise<EnqueueResult> {
    const account = await getOwnedAccount(accountId, requester);
    return this.enqueue({
      type,
      requester,
      provider: account.provider,
      accountId: account.id,
      assetId: account.assetId,
      priority: options.priority,
      payload: options.payload,
    });
  }

  async cancel(jobId: string, requester: Requester): Promise<SyncJob> {
    const job = await getAuthorizedJob(jobId, requester);
    if (isTerminalJobStatus(job.status)) {
      throw new JobNotCancellableError(jobId, job.status);
    }

    const updated = await jobRepository.update(jobId, {
      status: 'CANCELLED',
      finishedAt: new Date(),
    });
    if (!updated) {
      throw new JobNotFoundError(jobId);
    }

    if (updated.assetId) {
      await eventService.createForAsset(updated.assetId, requester, {
        type: 'JOB_CANCELLED',
        severity: 'WARNING',
        title: `${updated.type} job cancelled`,
        metadata: { jobId },
      });
    }
    return updated;
  }

  // Manually re-queues a FAILED or DEAD job — resets the attempt counter,
  // since this is a fresh, deliberate retry, not a continuation of the
  // exhausted backoff sequence.
  async retry(jobId: string, requester: Requester): Promise<SyncJob> {
    const job = await getAuthorizedJob(jobId, requester);
    if (job.status !== 'FAILED' && job.status !== 'DEAD') {
      throw new JobNotRetryableError(jobId, job.status);
    }

    const updated = await jobRepository.update(jobId, {
      status: 'QUEUED',
      attempts: 0,
      error: null,
      nextRetryAt: null,
      workerId: null,
    });
    if (!updated) {
      throw new JobNotFoundError(jobId);
    }

    await redis.rpush(JOB_QUEUE_KEY, jobId);
    return updated;
  }

  async getStatus(jobId: string, requester: Requester): Promise<SyncJob> {
    return getAuthorizedJob(jobId, requester);
  }

  // Non-admins must scope by a specific asset they own (mirrors
  // AccountService.list) — there's no cheap way to list "every job across
  // every asset I own" without a real Asset relation, which this
  // checkpoint deliberately doesn't add (see job.repository.ts).
  async listJobs(requester: Requester, params: ListJobsQuery): Promise<PaginatedResult<SyncJob>> {
    if (params.assetId) {
      await getOwnedAsset(params.assetId, requester);
    } else if (requester.role !== 'ADMIN') {
      throw new ForbiddenError('assetId is required to list jobs');
    }
    return jobRepository.list(params);
  }

  async cleanup(olderThanMs: number): Promise<number> {
    return jobRepository.deleteTerminalOlderThan(olderThanMs);
  }

  // Called on an interval by workers/heartbeat.ts — reclaims jobs
  // abandoned by workers that stopped sending heartbeats (crashed, killed,
  // lost connectivity), making them retryable again.
  async reclaimStaleJobs(): Promise<number> {
    return jobRepository.reclaimStaleJobs(config.jobs.heartbeatStaleMs);
  }

  // Used by GET /health/ready (Phase 12) — informational, same
  // "report, don't gate readiness" pattern the AI check established at
  // Phase 11 (see DECISIONS.md). `oldestQueuedAgeMs` only ever reflects a
  // never-yet-attempted job, not one legitimately waiting out a retry
  // backoff (see findOldestQueued's own comment).
  async getQueueHealth(): Promise<{
    size: number;
    oldestQueuedAgeMs: number | null;
    status: 'ok' | 'degraded';
  }> {
    const [size, oldest] = await Promise.all([
      jobRepository.countPending(),
      jobRepository.findOldestQueued(),
    ]);
    const oldestQueuedAgeMs = oldest ? Date.now() - oldest.createdAt.getTime() : null;
    const status =
      oldestQueuedAgeMs !== null && oldestQueuedAgeMs > config.jobs.queueUnhealthyAgeMs
        ? 'degraded'
        : 'ok';
    return { size, oldestQueuedAgeMs, status };
  }
}

export const jobService = new JobService();
