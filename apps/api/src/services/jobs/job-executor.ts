import { jobRepository } from '../../repositories/job.repository.js';
import { eventService } from '../assets/event.service.js';
import { config } from '../../config/env.js';
import { jobDispatcher, extractRequester } from './job-dispatcher.js';
import { retryService } from './retry.service.js';
import { PermanentJobError } from './job-errors.js';
import { SyncProviderError } from '../sync/sync-errors.js';
import { UnsupportedDiscoveryProviderError } from '../discovery/discovery-errors.js';
import { UnsupportedAgentProviderError } from '../../ai/agents/discovery/discovery.errors.js';
import { MissingRiskTargetError } from '../../ai/agents/risk/risk.errors.js';
import { MissingComplianceTargetError } from '../../ai/agents/compliance/compliance.errors.js';
import { MissingRecommendationTargetError } from '../../ai/agents/recommendation/recommendation.errors.js';
import { MissingReportTargetError } from '../../ai/agents/report/report.errors.js';
import { logger } from '../../observability/logger.js';
import { jobExecutionDurationSeconds, jobsFailedTotal } from '../../observability/metrics.js';
import type { Prisma, Severity, SyncJob } from '../../generated/prisma/client.js';

// Not every permanent failure originates inside the job framework itself —
// SyncService/DiscoveryService can throw their own "this will never
// succeed" errors (an unregistered provider) without knowing anything
// about jobs. Recognizing them here, rather than making job-errors.ts's
// PermanentJobError reach backwards into those modules, is what keeps this
// a one-directional dependency (jobs → sync/discovery, never the reverse)
// without touching either module.
function isPermanentFailure(err: unknown): boolean {
  return (
    err instanceof PermanentJobError ||
    err instanceof SyncProviderError ||
    err instanceof UnsupportedDiscoveryProviderError ||
    err instanceof UnsupportedAgentProviderError ||
    err instanceof MissingRiskTargetError ||
    err instanceof MissingComplianceTargetError ||
    err instanceof MissingRecommendationTargetError ||
    err instanceof MissingReportTargetError
  );
}

class JobExecutor {
  // The full lifecycle for one already-claimed job: heartbeat → dispatch →
  // persist result → emit events. Called by a Worker immediately after it
  // successfully claims a job via JobRepository.
  async execute(job: SyncJob, workerId: string): Promise<void> {
    await jobRepository.updateHeartbeat(job.id, workerId);
    await this.emitEvent(job, 'JOB_STARTED', 'INFO', { attempt: job.attempts + 1 });
    logger.info(
      { jobId: job.id, jobType: job.type, workerId, attempt: job.attempts + 1 },
      'job started',
    );

    // Keeps heartbeatAt fresh for the duration of a longer-running
    // dispatch, independent of the one-off write above — this is what lets
    // the reaper (workers/heartbeat.ts) tell "still working" apart from
    // "worker died mid-job".
    const heartbeatTicker = setInterval(() => {
      void jobRepository.updateHeartbeat(job.id, workerId);
    }, config.jobs.heartbeatIntervalMs);

    const startedAt = Date.now();
    try {
      const result = await jobDispatcher.dispatch(job);
      const durationMs = Date.now() - startedAt;

      if (result.success) {
        await jobRepository.update(job.id, {
          status: 'COMPLETED',
          result: (result.output ?? {}) as Prisma.InputJsonValue,
          finishedAt: new Date(),
        });
        await this.emitEvent(job, 'JOB_COMPLETED', 'INFO', {
          durationMs,
          warnings: result.warnings ?? [],
        });
        jobExecutionDurationSeconds.observe(
          { type: job.type, status: 'COMPLETED' },
          durationMs / 1000,
        );
        logger.info({ jobId: job.id, jobType: job.type, workerId, durationMs }, 'job completed');
      } else {
        await this.handleFailure(
          job,
          new Error(result.error ?? 'Job execution failed'),
          durationMs,
          false,
        );
      }
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      await this.handleFailure(job, err, durationMs, isPermanentFailure(err));
    } finally {
      clearInterval(heartbeatTicker);
    }
  }

  private async handleFailure(
    job: SyncJob,
    err: unknown,
    durationMs: number,
    isPermanent: boolean,
  ): Promise<void> {
    const message = err instanceof Error ? err.message : 'Unknown job failure';
    await this.emitEvent(job, 'JOB_FAILED', 'ERROR', {
      message,
      durationMs,
      attempt: job.attempts + 1,
    });

    if (isPermanent) {
      await jobRepository.update(job.id, {
        status: 'FAILED',
        attempts: job.attempts + 1,
        error: message,
        finishedAt: new Date(),
      });
      jobExecutionDurationSeconds.observe({ type: job.type, status: 'FAILED' }, durationMs / 1000);
      jobsFailedTotal.inc({ type: job.type, status: 'FAILED' });
      logger.error({ jobId: job.id, jobType: job.type, durationMs, error: message }, 'job failed');
      return;
    }

    const decision = retryService.decide(job);
    if (decision.shouldRetry) {
      await jobRepository.update(job.id, {
        status: 'RETRYING',
        attempts: job.attempts + 1,
        error: message,
        nextRetryAt: decision.nextRetryAt,
        workerId: null,
      });
      await this.emitEvent(job, 'JOB_RETRY', 'WARNING', {
        attempt: job.attempts + 1,
        nextRetryAt: decision.nextRetryAt?.toISOString(),
        message,
      });
      logger.warn(
        { jobId: job.id, jobType: job.type, attempt: job.attempts + 1, message },
        'job retrying',
      );
    } else {
      await jobRepository.update(job.id, {
        status: 'DEAD',
        attempts: job.attempts + 1,
        error: message,
        finishedAt: new Date(),
      });
      await this.emitEvent(job, 'JOB_DEAD', 'ERROR', {
        attempts: job.attempts + 1,
        message,
      });
      jobExecutionDurationSeconds.observe({ type: job.type, status: 'DEAD' }, durationMs / 1000);
      jobsFailedTotal.inc({ type: job.type, status: 'DEAD' });
      logger.error({ jobId: job.id, jobType: job.type, durationMs, message }, 'job dead');
    }
  }

  // Best-effort — a job with no assetId (a future system-level AI/webhook
  // job) has no timeline to attach to, and an event-emission failure must
  // never mask the job's own real outcome.
  private async emitEvent(
    job: SyncJob,
    type: string,
    severity: Severity,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    if (!job.assetId) {
      return;
    }
    const requester = extractRequester(job);
    if (!requester) {
      return;
    }
    try {
      await eventService.createForAsset(job.assetId, requester, {
        type,
        severity,
        title: `${type} — ${job.type} job`,
        metadata: { jobId: job.id, jobType: job.type, ...metadata },
      });
    } catch {
      // Swallowed intentionally — see doc comment above.
    }
  }
}

export const jobExecutor = new JobExecutor();
