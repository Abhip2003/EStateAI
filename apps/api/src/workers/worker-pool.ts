import { Worker } from './worker.js';

// Owns a fixed set of Workers for this process. Multiple processes can
// each run their own WorkerPool against the same database — there's no
// process-to-process coordination beyond the shared Postgres/Redis state,
// by design (that's what makes this horizontally scalable).
class WorkerPool {
  private workers: Worker[] = [];

  start(count: number): void {
    if (this.workers.length > 0) {
      return;
    }
    for (let i = 0; i < count; i++) {
      const worker = new Worker(`worker-${process.pid}-${i}`);
      worker.start();
      this.workers.push(worker);
    }
  }

  stop(): void {
    this.workers.forEach((worker) => {
      worker.stop();
    });
  }

  pauseAll(): void {
    this.workers.forEach((worker) => {
      worker.pause();
    });
  }

  resumeAll(): void {
    this.workers.forEach((worker) => {
      worker.resume();
    });
  }

  async waitForIdle(): Promise<void> {
    await Promise.all(this.workers.map((worker) => worker.waitForIdle()));
  }

  get size(): number {
    return this.workers.length;
  }

  get workerIds(): string[] {
    return this.workers.map((worker) => worker.id);
  }

  // Snapshot used by both /health/ready (Phase 12) and the
  // estateai_worker_utilization_ratio gauge — total workers, how many are
  // currently running (not paused/stopped), and how many of those are
  // mid-job right now.
  stats(): { total: number; running: number; busy: number; utilization: number } {
    const total = this.workers.length;
    const running = this.workers.filter((w) => w.status === 'running').length;
    const busy = this.workers.filter((w) => w.isBusy).length;
    return { total, running, busy, utilization: total > 0 ? busy / total : 0 };
  }
}

export const workerPool = new WorkerPool();
