import { config } from '../../config/env.js';
import type { SyncJob } from '../../generated/prisma/client.js';

export interface RetryDecision {
  shouldRetry: boolean;
  nextRetryAt?: Date;
}

class RetryService {
  // Exponential backoff schedule, configurable via JOB_RETRY_BACKOFF_MS
  // (defaults to 1m, 5m, 15m, 30m, 1h, 6h, 24h). If attempts exceed the
  // schedule's length, the last delay repeats.
  decide(job: Pick<SyncJob, 'attempts' | 'maxAttempts'>): RetryDecision {
    const nextAttemptNumber = job.attempts + 1;
    if (nextAttemptNumber >= job.maxAttempts) {
      return { shouldRetry: false };
    }

    const schedule = config.jobs.retryBackoffMs;
    const delayMs = schedule[Math.min(job.attempts, schedule.length - 1)];
    return { shouldRetry: true, nextRetryAt: new Date(Date.now() + delayMs) };
  }
}

export const retryService = new RetryService();
