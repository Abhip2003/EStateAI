import crypto from 'node:crypto';
import { jobRepository } from '../repositories/job.repository.js';
import { jobExecutor } from '../services/jobs/job-executor.js';
import { redis } from '../cache/redis.js';
import { config } from '../config/env.js';

const JOB_QUEUE_KEY = 'jobs:queue';

type WorkerState = 'stopped' | 'running' | 'paused';

// One polling worker with its own identity. Multiple Workers (WorkerPool)
// run inside the same process, each independently polling — claiming is
// safe under concurrency because JobRepository's claim guarantees
// exactly-once ownership regardless of how many workers (in this process
// or another) are polling simultaneously.
export class Worker {
  readonly id: string;
  private state: WorkerState = 'stopped';
  private pollTimer?: NodeJS.Timeout;
  private inFlight?: Promise<void>;

  constructor(id?: string) {
    this.id = id ?? `worker-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
  }

  start(): void {
    if (this.state === 'running') {
      return;
    }
    this.state = 'running';
    this.scheduleNextPoll(0);
  }

  stop(): void {
    this.state = 'stopped';
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  pause(): void {
    if (this.state === 'running') {
      this.state = 'paused';
    }
  }

  resume(): void {
    if (this.state === 'paused') {
      this.state = 'running';
      this.scheduleNextPoll(0);
    }
  }

  get status(): WorkerState {
    return this.state;
  }

  // Whether this worker is mid-execution of a claimed job right now — the
  // per-worker signal `WorkerPool.stats()` aggregates into utilization.
  get isBusy(): boolean {
    return this.inFlight !== undefined;
  }

  // Exposed for graceful shutdown — lets shutdown.ts wait for whatever job
  // is currently executing before the process exits.
  waitForIdle(): Promise<void> {
    return this.inFlight ?? Promise.resolve();
  }

  private scheduleNextPoll(delayMs: number): void {
    if (this.state !== 'running') {
      return;
    }
    this.pollTimer = setTimeout(() => {
      this.inFlight = this.pollOnce().finally(() => {
        this.inFlight = undefined;
        this.scheduleNextPoll(config.jobs.pollIntervalMs);
      });
    }, delayMs);
  }

  private async pollOnce(): Promise<void> {
    try {
      // Fast path: a job id pushed to Redis on enqueue, checked
      // non-blocking so this never stalls the poll loop waiting on Redis.
      const poppedId = await redis.lpop(JOB_QUEUE_KEY);
      // If the popped id turns out ineligible (already claimed, cancelled,
      // stale), fall back to the general query in the same tick rather
      // than wasting a full poll interval doing nothing.
      const job =
        (poppedId ? await jobRepository.claimJobById(poppedId, this.id) : null) ??
        (await jobRepository.claimNextJob(this.id));

      if (job) {
        await jobExecutor.execute(job, this.id);
      }
    } catch (err) {
      console.error(`[worker:${this.id}] poll error:`, err instanceof Error ? err.message : err);
    }
  }
}
