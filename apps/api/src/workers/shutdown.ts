import type { Server } from 'node:http';
import { workerPool } from './worker-pool.js';

const SHUTDOWN_GRACE_MS = 10_000;

// Stops accepting new jobs immediately (worker.stop() cancels the poll
// loop), then gives whatever job is already executing a bounded window to
// finish before the process exits, so a job isn't cut off mid-write.
export function registerGracefulShutdown(server: Server, heartbeatTimer: NodeJS.Timeout): void {
  let shuttingDown = false;

  const shutdown = (signal: string): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log(`[shutdown] received ${signal}, stopping worker pool...`);

    workerPool.stop();
    clearInterval(heartbeatTimer);

    const timeout = setTimeout(() => {
      console.warn('[shutdown] grace period elapsed, exiting anyway');
      process.exit(0);
    }, SHUTDOWN_GRACE_MS);

    void workerPool.waitForIdle().then(() => {
      clearTimeout(timeout);
      server.close(() => process.exit(0));
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
