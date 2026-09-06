import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import { jobRepository } from '../repositories/job.repository.js';
import { workerPool } from '../workers/worker-pool.js';

// One shared registry for every metric in the process — GET /metrics
// (routes/metrics.ts) just serializes this. collectDefaultMetrics adds the
// usual Node process/runtime metrics (heap, event loop lag, GC, etc.) for
// free, prefixed so they don't collide with our own names.
export const metricsRegistry = new Registry();
collectDefaultMetrics({ register: metricsRegistry, prefix: 'estateai_' });

// --- HTTP ---
export const httpRequestsTotal = new Counter({
  name: 'estateai_http_requests_total',
  help: 'Total HTTP requests handled',
  labelNames: ['method', 'route', 'status_code'] as const,
  registers: [metricsRegistry],
});

export const httpRequestDurationSeconds = new Histogram({
  name: 'estateai_http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status_code'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [metricsRegistry],
});

// A dedicated counter (rather than deriving "error rate" purely via a
// PromQL ratio over http_requests_total) so a dashboard/alert can query
// errors directly without a status_code-range regex — status >= 400.
export const httpErrorsTotal = new Counter({
  name: 'estateai_http_errors_total',
  help: 'Total HTTP responses with a 4xx or 5xx status code',
  labelNames: ['method', 'route', 'status_code'] as const,
  registers: [metricsRegistry],
});

// --- AI ---
export const aiRequestsTotal = new Counter({
  name: 'estateai_ai_requests_total',
  help: 'Total AI provider requests, by outcome',
  labelNames: ['provider', 'model', 'status'] as const,
  registers: [metricsRegistry],
});

export const aiRequestDurationSeconds = new Histogram({
  name: 'estateai_ai_request_duration_seconds',
  help: 'AI provider request latency in seconds',
  labelNames: ['provider', 'model', 'status'] as const,
  buckets: [0.1, 0.5, 1, 2.5, 5, 10, 20, 30, 60],
  registers: [metricsRegistry],
});

export const aiTokensTotal = new Counter({
  name: 'estateai_ai_tokens_total',
  help: 'Total AI tokens consumed, by kind',
  labelNames: ['provider', 'model', 'kind'] as const, // kind: prompt | completion
  registers: [metricsRegistry],
});

// Same data as aiRequestsTotal{status="FAILED"}, exposed as its own series
// so "AI failures" (spec'd as a distinct thing to track) doesn't require a
// label-matching query against the general request counter.
export const aiFailuresTotal = new Counter({
  name: 'estateai_ai_failures_total',
  help: 'Total AI provider requests that failed (permanent error or exhausted retries)',
  labelNames: ['provider', 'model'] as const,
  registers: [metricsRegistry],
});

// --- WebSocket ---
// Incremented/decremented directly by connection-registry.ts at the point
// a connection/subscription is added or removed, rather than computed via
// an async collect() callback — there's no I/O involved, so a live counter
// is simpler and cheaper than re-deriving the count on every scrape.
export const websocketActiveConnections = new Gauge({
  name: 'estateai_websocket_active_connections',
  help: 'Currently open WebSocket connections',
  registers: [metricsRegistry],
});

export const websocketActiveSubscriptions = new Gauge({
  name: 'estateai_websocket_active_subscriptions',
  help: 'Currently active (connection, asset) WebSocket subscriptions',
  registers: [metricsRegistry],
});

// --- Jobs ---
// Queue size is genuinely async (a Postgres count query), so this one uses
// prom-client's collect() hook instead of being pushed on every enqueue —
// it's read on-demand at scrape time, always fresh, and doesn't require
// jobRepository writes to also know about metrics.
export const jobQueueSize = new Gauge({
  name: 'estateai_job_queue_size',
  help: 'Jobs currently queued or retrying',
  registers: [metricsRegistry],
  async collect() {
    try {
      const count = await jobRepository.countPending();
      this.set(count);
    } catch {
      // Best-effort — a DB hiccup during a metrics scrape shouldn't throw
      // through to the /metrics response; the gauge just keeps its last
      // known value.
    }
  },
});

export const jobExecutionDurationSeconds = new Histogram({
  name: 'estateai_job_execution_duration_seconds',
  help: 'Job execution duration in seconds, from claim to terminal status',
  labelNames: ['type', 'status'] as const,
  buckets: [0.05, 0.1, 0.5, 1, 5, 10, 30, 60, 300],
  registers: [metricsRegistry],
});

export const jobsFailedTotal = new Counter({
  name: 'estateai_jobs_failed_total',
  help: 'Total jobs that ended FAILED or DEAD',
  labelNames: ['type', 'status'] as const,
  registers: [metricsRegistry],
});

// Fraction of this process's workers mid-job at scrape time — read via
// collect() (like jobQueueSize above) rather than pushed on every
// claim/release, since WorkerPool.stats() is a cheap in-memory read with
// no I/O of its own to avoid duplicating.
export const workerUtilization = new Gauge({
  name: 'estateai_worker_utilization_ratio',
  help: "Fraction of this process's job workers currently executing a job (0-1)",
  registers: [metricsRegistry],
  collect() {
    this.set(workerPool.stats().utilization);
  },
});

// --- Discovery ---
// Measured directly around DiscoveryService.discover()'s own core work,
// independent of job_execution_duration_seconds{type="DISCOVERY"} (which
// also includes job-framework overhead — heartbeat setup, dispatcher
// wrapping) — this one isolates discovery's own cost.
export const discoveryDurationSeconds = new Histogram({
  name: 'estateai_discovery_duration_seconds',
  help: 'Discovery run duration in seconds (DiscoveryService.discover())',
  labelNames: ['provider', 'success'] as const,
  buckets: [0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 120],
  registers: [metricsRegistry],
});
