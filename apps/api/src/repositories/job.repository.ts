import { prisma } from '../db/prisma.js';
import type { JobStatus, Prisma, SyncJob } from '../generated/prisma/client.js';
import {
  toPaginatedResult,
  toSkipTake,
  type PaginatedResult,
  type PaginationParams,
} from './pagination.js';

export interface ListJobsParams extends PaginationParams {
  assetId?: string;
  accountId?: string;
  type?: string;
  status?: JobStatus;
}

class JobRepository {
  async create(data: Prisma.SyncJobUncheckedCreateInput): Promise<SyncJob> {
    return prisma.syncJob.create({ data });
  }

  async findById(id: string): Promise<SyncJob | null> {
    return prisma.syncJob.findUnique({ where: { id } });
  }

  async update(id: string, data: Prisma.SyncJobUncheckedUpdateInput): Promise<SyncJob | null> {
    try {
      return await prisma.syncJob.update({ where: { id }, data });
    } catch {
      return null;
    }
  }

  async list(params: ListJobsParams): Promise<PaginatedResult<SyncJob>> {
    const where: Prisma.SyncJobWhereInput = {
      ...(params.assetId ? { assetId: params.assetId } : {}),
      ...(params.accountId ? { accountId: params.accountId } : {}),
      ...(params.type ? { type: params.type } : {}),
      ...(params.status ? { status: params.status } : {}),
    };

    const [items, total] = await Promise.all([
      prisma.syncJob.findMany({
        where,
        orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
        ...toSkipTake(params),
      }),
      prisma.syncJob.count({ where }),
    ]);

    return toPaginatedResult(items, total, params);
  }

  // Number of jobs still waiting to run — used to give callers a rough
  // "estimated queue state" when they enqueue, not an exact position.
  async countPending(): Promise<number> {
    return prisma.syncJob.count({ where: { status: { in: ['QUEUED', 'RETRYING'] } } });
  }

  // The longest-waiting never-yet-attempted job — used by
  // JobService.getQueueHealth() (Phase 12) to flag a queue that isn't
  // being drained. Deliberately QUEUED only, not RETRYING: a RETRYING job
  // can legitimately sit for hours (JOB_RETRY_BACKOFF_MS), so including it
  // would misreport an expected backoff delay as a stuck queue.
  async findOldestQueued(): Promise<SyncJob | null> {
    return prisma.syncJob.findFirst({
      where: { status: 'QUEUED' },
      orderBy: { createdAt: 'asc' },
    });
  }

  // Claims whichever eligible job (QUEUED, or RETRYING past its
  // nextRetryAt) is highest priority and oldest, ordered exactly the way
  // workers should execute them.
  async claimNextJob(workerId: string): Promise<SyncJob | null> {
    const now = new Date();
    const candidate = await prisma.syncJob.findFirst({
      where: {
        OR: [{ status: 'QUEUED' }, { status: 'RETRYING', nextRetryAt: { lte: now } }],
      },
      orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
    });
    if (!candidate) {
      return null;
    }
    return this.attemptClaim(candidate.id, candidate.status, workerId);
  }

  // Claims a specific job by id (the Redis-backed fast path) — falls back
  // to the caller trying claimNextJob() if this returns null, whether
  // because the job doesn't exist, isn't eligible, or lost the race.
  async claimJobById(id: string, workerId: string): Promise<SyncJob | null> {
    const job = await prisma.syncJob.findUnique({ where: { id } });
    if (!job) {
      return null;
    }
    const eligible =
      job.status === 'QUEUED' ||
      (job.status === 'RETRYING' && job.nextRetryAt !== null && job.nextRetryAt <= new Date());
    if (!eligible) {
      return null;
    }
    return this.attemptClaim(job.id, job.status, workerId);
  }

  // The status guard in this WHERE clause is what actually prevents two
  // workers from claiming the same row: Postgres takes a row lock on
  // UPDATE and re-evaluates the WHERE predicate after acquiring it, so a
  // concurrent UPDATE that loses the race simply matches zero rows instead
  // of racing on the read. No explicit transaction/isolation-level tuning
  // needed for this guarantee.
  private async attemptClaim(
    id: string,
    expectedStatus: JobStatus,
    workerId: string,
  ): Promise<SyncJob | null> {
    const now = new Date();
    const claimed = await prisma.syncJob.updateMany({
      where: { id, status: expectedStatus },
      data: { status: 'RUNNING', workerId, startedAt: now, heartbeatAt: now },
    });
    if (claimed.count === 0) {
      return null;
    }
    return prisma.syncJob.findUnique({ where: { id } });
  }

  async updateHeartbeat(id: string, workerId: string): Promise<void> {
    await prisma.syncJob.updateMany({ where: { id, workerId }, data: { heartbeatAt: new Date() } });
  }

  // Jobs still RUNNING whose heartbeat has gone stale were claimed by a
  // worker that's now presumed dead (crashed, killed, lost connectivity).
  // Reclaiming does not increment `attempts` — an infrastructure failure
  // is not the job's fault, unlike a real dispatch failure.
  async reclaimStaleJobs(staleBeforeMs: number): Promise<number> {
    const threshold = new Date(Date.now() - staleBeforeMs);
    const result = await prisma.syncJob.updateMany({
      where: { status: 'RUNNING', heartbeatAt: { lt: threshold } },
      data: { status: 'RETRYING', nextRetryAt: new Date(), workerId: null },
    });
    return result.count;
  }

  async deleteTerminalOlderThan(olderThanMs: number): Promise<number> {
    const threshold = new Date(Date.now() - olderThanMs);
    const result = await prisma.syncJob.deleteMany({
      where: {
        status: { in: ['COMPLETED', 'FAILED', 'CANCELLED', 'DEAD'] },
        createdAt: { lt: threshold },
      },
    });
    return result.count;
  }

  async delete(id: string): Promise<SyncJob | null> {
    try {
      return await prisma.syncJob.delete({ where: { id } });
    } catch {
      return null;
    }
  }
}

export const jobRepository = new JobRepository();
