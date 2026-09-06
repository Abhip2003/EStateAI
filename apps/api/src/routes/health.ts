import type { FastifyInstance } from 'fastify';
import { statfs } from 'node:fs/promises';
import { checkDatabaseConnection } from '../db/prisma.js';
import { checkRedisConnection } from '../cache/redis.js';
import { config } from '../config/env.js';
import { workerPool } from '../workers/worker-pool.js';
import { jobService } from '../services/jobs/job.service.js';

// Not a network call — just confirms the configured default AI provider
// actually has credentials set, so /health/ready can flag a deployment
// that would fail every AI-mode request without ever attempting one.
function checkAIProviderConfigured(): { provider: string; configured: boolean } {
  const provider = config.ai.defaultProvider;
  const apiKey = config.ai[provider]?.apiKey;
  return { provider, configured: Boolean(apiKey) };
}

// Reports this process's own worker pool state — not a query against any
// other process, so in a multi-instance deployment this only ever
// describes the instance that answered the request.
function checkWorkers(): {
  enabled: boolean;
  total: number;
  running: number;
  busy: number;
  status: 'ok' | 'disabled' | 'degraded';
} {
  if (!config.jobs.workersEnabled) {
    return { enabled: false, total: 0, running: 0, busy: 0, status: 'disabled' };
  }
  const stats = workerPool.stats();
  // "degraded" (not "not_ready") — a worker pool that's supposed to be
  // running but has zero running workers means jobs will pile up
  // unprocessed, worth surfacing, but the HTTP API itself is still fine.
  const status = stats.running === 0 ? 'degraded' : 'ok';
  return { enabled: true, total: stats.total, running: stats.running, busy: stats.busy, status };
}

function checkMemory(): {
  status: 'ok' | 'warning';
  rssBytes: number;
  heapUsedBytes: number;
  heapTotalBytes: number;
  thresholdBytes: number;
} {
  const usage = process.memoryUsage();
  const status = usage.rss > config.health.memoryWarningBytes ? 'warning' : 'ok';
  return {
    status,
    rssBytes: usage.rss,
    heapUsedBytes: usage.heapUsed,
    heapTotalBytes: usage.heapTotal,
    thresholdBytes: config.health.memoryWarningBytes,
  };
}

async function checkDisk(): Promise<{
  status: 'ok' | 'warning' | 'unknown';
  freeBytes?: number;
  totalBytes?: number;
  thresholdBytes: number;
}> {
  try {
    const stats = await statfs(process.cwd());
    const freeBytes = stats.bfree * stats.bsize;
    const totalBytes = stats.blocks * stats.bsize;
    const status = freeBytes < config.health.diskWarningBytes ? 'warning' : 'ok';
    return { status, freeBytes, totalBytes, thresholdBytes: config.health.diskWarningBytes };
  } catch {
    // statfs isn't available on every platform/filesystem — degrade to
    // "unknown" rather than failing the whole readiness check over it.
    return { status: 'unknown', thresholdBytes: config.health.diskWarningBytes };
  }
}

export function healthRoutes(app: FastifyInstance): void {
  app.get('/health', () => {
    return { status: 'ok' };
  });

  app.get('/health/db', async (request, reply) => {
    const isConnected = await checkDatabaseConnection();

    if (!isConnected) {
      reply.code(503);
      return { status: 'error', database: 'disconnected' };
    }

    return { status: 'ok', database: 'connected' };
  });

  app.get('/health/redis', async (request, reply) => {
    const isConnected = await checkRedisConnection();

    if (!isConnected) {
      reply.code(503);
      return { status: 'error', redis: 'disconnected' };
    }

    return { status: 'ok', redis: 'connected' };
  });

  // Detailed readiness status (Phase 11 + Phase 12). Only Postgres and
  // Redis reachability gate the 200/503 status — every other check
  // (AI provider config, workers, queue, memory, disk) is informational,
  // same "report, don't gate" pattern established for the AI check at
  // Phase 11 and extended here (see DECISIONS.md): none of them mean the
  // HTTP API itself can't serve requests, so none of them should pull a
  // healthy instance out of a load balancer's rotation.
  app.get('/health/ready', async (request, reply) => {
    const [isDbConnected, isRedisConnected, disk] = await Promise.all([
      checkDatabaseConnection(),
      checkRedisConnection(),
      checkDisk(),
    ]);

    const database = isDbConnected ? 'connected' : 'disconnected';
    const redis = isRedisConnected ? 'connected' : 'disconnected';
    const ai = checkAIProviderConfigured();
    const workers = checkWorkers();
    // getQueueHealth() queries Postgres directly (jobRepository.countPending())
    // — calling it while isDbConnected is already false throws (Phase 15
    // found this via reliability testing: stopping Postgres turned
    // /health/ready into an unhandled 500 instead of the intended graceful
    // 503). Skip the query and report 'unknown' instead, same fallback
    // shape checkDisk() already uses for its own unavailable case.
    const queue = isDbConnected
      ? await jobService.getQueueHealth()
      : { size: 0, oldestQueuedAgeMs: null, status: 'unknown' as const };
    const memory = checkMemory();

    const body = { database, redis, ai, workers, queue, memory, disk };

    if (!isDbConnected || !isRedisConnected) {
      reply.code(503);
      return { status: 'not_ready', ...body };
    }

    return { status: 'ready', ...body };
  });
}
