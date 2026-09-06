import { config } from '../config/env.js';
import { jobService } from '../services/jobs/job.service.js';

// The reaper: on an interval, finds RUNNING jobs whose heartbeatAt has
// gone stale (their worker stopped updating it — crashed, killed, lost
// connectivity) and makes them retryable again. This is what turns "a
// worker died mid-job" into "another worker picks it up shortly after",
// instead of the job being stuck RUNNING forever.
export function startHeartbeatMonitor(): NodeJS.Timeout {
  return setInterval(() => {
    jobService
      .reclaimStaleJobs()
      .then((count) => {
        if (count > 0) {
          console.log(`[heartbeat] reclaimed ${count} stale job(s)`);
        }
      })
      .catch((err: unknown) => {
        console.error('[heartbeat] reclaim error:', err instanceof Error ? err.message : err);
      });
  }, config.jobs.heartbeatCheckIntervalMs);
}
