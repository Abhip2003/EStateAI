import http from 'node:http';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import WebSocket from 'ws';
import { prisma } from '../src/db/prisma.js';
import { userRepository } from '../src/repositories/user.repository.js';
import { categoryRepository } from '../src/repositories/category.repository.js';
import { assetRepository } from '../src/repositories/asset.repository.js';
import { jobRepository } from '../src/repositories/job.repository.js';
import { aiRequestLogRepository } from '../src/repositories/ai-request-log.repository.js';
import { JobType } from '../src/types/job.js';
import { metricsRegistry } from '../src/observability/metrics.js';
import {
  api,
  BASE_URL,
  createAdminAndCategory,
  createChecker,
  registerAndLogin,
} from './lib/verify-helpers.js';

const WS_URL = BASE_URL.replace(/^http/, 'ws') + '/ws';
// Matches the CLAUDE_API_URL override in apps/api/.env.example / .env —
// same convention verify-ai.ts uses, so this script can run against the
// same already-running dev/CI server without any env change.
const CLAUDE_MOCK_PORT = 3998;
const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');
const PERMANENT_FAILURE_TRIGGER = 'trigger-verify-production-permanent-failure';

function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      resolve(raw ? (JSON.parse(raw) as Record<string, unknown>) : {});
    });
  });
}

function startClaudeMockServer(): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    void (async () => {
      const body = await readJsonBody(req);
      const messages = (body.messages ?? []) as { content?: string }[];
      const lastContent = messages[messages.length - 1]?.content ?? '';
      if (lastContent.includes(PERMANENT_FAILURE_TRIGGER)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid api key' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'msg_verify_production',
          model: 'claude-sonnet-5',
          content: [{ type: 'text', text: 'production verification response' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 12, output_tokens: 6 },
        }),
      );
    })();
  });
  return new Promise((resolve) => server.listen(CLAUDE_MOCK_PORT, () => resolve(server)));
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const { check, state } = createChecker();
  const stamp = Date.now();
  let categoryId: string | undefined;
  let assetId: string | undefined;
  let adminId: string | undefined;
  let ownerId: string | undefined;
  let claudeMock: http.Server | undefined;
  let wsClient: WebSocket | undefined;
  const aiLogIds: string[] = [];
  const jobIds: string[] = [];

  try {
    console.log('1. setup — admin+category, one owner user, one asset');
    const { admin, categoryId: newCategoryId } = await createAdminAndCategory('production');
    adminId = admin.id;
    categoryId = newCategoryId;
    const owner = await registerAndLogin(`verify-prod-owner-${stamp}@example.test`);
    ownerId = owner.id;
    const assetRes = await api<{ id: string }>('POST', '/assets', owner.accessToken, {
      categoryId,
      name: `verify-prod-asset-${stamp}`,
    });
    assetId = assetRes.body.id;

    console.log('2. health endpoints');
    const health = await api<{ status: string }>('GET', '/health');
    check('GET /health is 200', health.status === 200);
    check('GET /health status is ok', health.body.status === 'ok');

    const healthDb = await api<{ status: string; database: string }>('GET', '/health/db');
    check('GET /health/db reports database connected', healthDb.body.database === 'connected');

    const healthRedis = await api<{ status: string; redis: string }>('GET', '/health/redis');
    check('GET /health/redis reports redis connected', healthRedis.body.redis === 'connected');

    const healthReady = await api<{
      status: string;
      database: string;
      redis: string;
      ai: { provider: string; configured: boolean };
      workers: { enabled: boolean; total: number; running: number; busy: number; status: string };
      queue: { size: number; oldestQueuedAgeMs: number | null; status: string };
      memory: { status: string; rssBytes: number };
      disk: { status: string };
    }>('GET', '/health/ready');
    check('GET /health/ready is 200', healthReady.status === 200);
    check('GET /health/ready reports ready', healthReady.body.status === 'ready');
    check(
      'GET /health/ready reports AI provider configuration',
      typeof healthReady.body.ai?.provider === 'string' &&
        typeof healthReady.body.ai?.configured === 'boolean',
      JSON.stringify(healthReady.body.ai),
    );
    check(
      'GET /health/ready reports worker status',
      typeof healthReady.body.workers?.total === 'number' &&
        typeof healthReady.body.workers?.status === 'string',
      JSON.stringify(healthReady.body.workers),
    );
    check(
      'GET /health/ready reports queue health',
      typeof healthReady.body.queue?.size === 'number' &&
        typeof healthReady.body.queue?.status === 'string',
      JSON.stringify(healthReady.body.queue),
    );
    check(
      'GET /health/ready reports memory status',
      typeof healthReady.body.memory?.status === 'string' &&
        typeof healthReady.body.memory?.rssBytes === 'number',
      JSON.stringify(healthReady.body.memory),
    );
    check(
      'GET /health/ready reports disk status',
      typeof healthReady.body.disk?.status === 'string',
      JSON.stringify(healthReady.body.disk),
    );

    console.log('3. logging — requestId/correlationId on both success and error responses');
    const successRaw = await fetch(`${BASE_URL}/health`);
    const successRequestId = successRaw.headers.get('x-request-id');
    check('x-request-id header present on success responses', Boolean(successRequestId));
    check(
      'x-correlation-id header present on success responses',
      Boolean(successRaw.headers.get('x-correlation-id')),
    );

    const suppliedCorrelationId = `verify-production-correlation-${stamp}`;
    const correlatedRaw = await fetch(`${BASE_URL}/health`, {
      headers: { 'x-correlation-id': suppliedCorrelationId },
    });
    check(
      'a client-supplied x-correlation-id is echoed back unchanged',
      correlatedRaw.headers.get('x-correlation-id') === suppliedCorrelationId,
      correlatedRaw.headers.get('x-correlation-id') ?? 'missing',
    );

    const errorRaw = await fetch(`${BASE_URL}/assets/does-not-exist`, {
      headers: { Authorization: `Bearer ${owner.accessToken}` },
    });
    const errorBody = (await errorRaw.json()) as { requestId?: string };
    const errorRequestId = errorRaw.headers.get('x-request-id');
    check('x-request-id header present on error responses', Boolean(errorRequestId));
    check(
      'error response body carries the same requestId as the header',
      Boolean(errorBody.requestId) && errorBody.requestId === errorRequestId,
      JSON.stringify(errorBody),
    );

    console.log('3b. security — helmet headers, CORS, compression');
    const secHeaders = successRaw.headers;
    check(
      'X-Content-Type-Options header present (helmet)',
      secHeaders.get('x-content-type-options') === 'nosniff',
    );
    check('X-Frame-Options header present (helmet)', Boolean(secHeaders.get('x-frame-options')));

    const corsRaw = await fetch(`${BASE_URL}/health`, {
      headers: { Origin: 'https://verify-production.example.test' },
    });
    check(
      'CORS access-control-allow-origin header present',
      Boolean(corsRaw.headers.get('access-control-allow-origin')),
    );

    const compressedRaw = await fetch(`${BASE_URL}/metrics`, {
      headers: { 'Accept-Encoding': 'gzip' },
    });
    check(
      'GET /metrics is gzip-compressed when requested',
      compressedRaw.headers.get('content-encoding') === 'gzip',
      compressedRaw.headers.get('content-encoding') ?? 'none',
    );

    console.log('4. WebSocket still works — connect, subscribe, receive a real event');
    wsClient = new WebSocket(`${WS_URL}?token=${encodeURIComponent(owner.accessToken)}`);
    interface WsMessage {
      type: string;
      assetId?: string;
      event?: { title: string };
    }
    const wsMessages: WsMessage[] = [];
    wsClient.on('message', (raw: Buffer) => {
      wsMessages.push(JSON.parse(raw.toString()) as WsMessage);
    });
    await new Promise<void>((resolve) => wsClient?.once('open', () => resolve()));
    await sleep(200);
    check(
      'websocket sends "connected" on open',
      wsMessages.some((m) => m.type === 'connected'),
    );
    wsClient.send(JSON.stringify({ type: 'subscribe', assetId }));
    await sleep(200);
    check(
      'websocket subscribe still works',
      wsMessages.some((m) => m.type === 'subscribed' && m.assetId === assetId),
    );

    const eventTitle = `verify-production-event-${stamp}`;
    await api('POST', `/assets/${assetId}/events`, owner.accessToken, {
      type: 'PRODUCTION_CHECK',
      title: eventTitle,
    });
    await sleep(300);
    check(
      'websocket still delivers real AssetEvents live',
      wsMessages.some((m) => m.type === 'event' && m.event?.title === eventTitle),
    );

    console.log('5. AI still works — POST /ai/generate against a local provider mock');
    claudeMock = await startClaudeMockServer();
    const aiRes = await api<{ text: string; provider: string }>(
      'POST',
      '/ai/generate',
      owner.accessToken,
      { prompt: 'production verification', assetId },
    );
    check('POST /ai/generate still returns 200', aiRes.status === 200, `${aiRes.status}`);
    check(
      'POST /ai/generate still returns generated text',
      aiRes.body.text === 'production verification response',
      aiRes.body.text,
    );
    // Also force one permanent failure — exercises AIService's failure
    // path so estateai_ai_failures_total has a real data point by the
    // time the metrics check below scrapes /metrics.
    const aiFailRes = await api('POST', '/ai/generate', owner.accessToken, {
      prompt: PERMANENT_FAILURE_TRIGGER,
      assetId,
    });
    check(
      'a permanent AI provider failure still maps to a 5xx',
      aiFailRes.status >= 500,
      `${aiFailRes.status}`,
    );

    const aiLogs = await prisma.aIRequestLog.findMany({ where: { assetId } });
    for (const log of aiLogs) aiLogIds.push(log.id);

    console.log('6. Jobs still work — the worker pool still claims and terminates a job');
    const job = await jobRepository.create({ type: JobType.AI_ANALYSIS, priority: 'NORMAL' });
    jobIds.push(job.id);
    let terminal = null;
    for (let i = 0; i < 20; i++) {
      const current = await jobRepository.findById(job.id);
      if (current && current.status !== 'QUEUED' && current.status !== 'RETRYING') {
        terminal = current;
        break;
      }
      await sleep(500);
    }
    check(
      'a queued job is still claimed and driven to a terminal status by the worker pool',
      terminal !== null,
      terminal ? terminal.status : 'timed out waiting',
    );

    console.log('7. metrics endpoint — Prometheus text format, key series present');
    const metricsRaw = await fetch(`${BASE_URL}/metrics`);
    const metricsText = await metricsRaw.text();
    check('GET /metrics is 200', metricsRaw.status === 200);
    check(
      'GET /metrics content-type is Prometheus text format',
      (metricsRaw.headers.get('content-type') ?? '').includes('text/plain'),
      metricsRaw.headers.get('content-type') ?? '',
    );
    const expectedSeries = [
      'estateai_http_requests_total',
      'estateai_http_request_duration_seconds',
      'estateai_http_errors_total',
      'estateai_ai_requests_total',
      'estateai_ai_request_duration_seconds',
      'estateai_ai_tokens_total',
      'estateai_ai_failures_total',
      'estateai_websocket_active_connections',
      'estateai_websocket_active_subscriptions',
      'estateai_job_queue_size',
      'estateai_job_execution_duration_seconds',
      'estateai_jobs_failed_total',
      'estateai_worker_utilization_ratio',
      'estateai_process_cpu_seconds_total',
      'estateai_process_resident_memory_bytes',
    ];
    for (const series of expectedSeries) {
      check(`/metrics includes ${series}`, metricsText.includes(series));
    }
    // Not exercised via a real discovery run in this script (needs a full
    // account+credential+provider-mock setup) — verified as registered in
    // the metrics registry instead, which is a real check of the wiring
    // without requiring an observation to exist yet.
    check(
      'estateai_discovery_duration_seconds is registered',
      metricsRegistry.getSingleMetric('estateai_discovery_duration_seconds') !== undefined,
    );

    console.log('8. Docker — compose files are valid, both images build');
    try {
      execFileSync('docker', ['compose', '-f', 'docker-compose.dev.yml', 'config', '-q'], {
        cwd: REPO_ROOT,
        stdio: 'pipe',
      });
      check('docker-compose.dev.yml is valid', true);

      execFileSync('docker', ['compose', '-f', 'docker-compose.prod.yml', 'config', '-q'], {
        cwd: REPO_ROOT,
        stdio: 'pipe',
        env: { ...process.env, POSTGRES_PASSWORD: 'verify' },
      });
      check('docker-compose.prod.yml is valid', true);

      execFileSync(
        'docker',
        [
          'build',
          '-f',
          'apps/api/Dockerfile',
          '--target',
          'runtime',
          '-t',
          'estateai-api-verify-production',
          '.',
        ],
        { cwd: REPO_ROOT, stdio: 'pipe' },
      );
      check('apps/api/Dockerfile builds (runtime target)', true);

      execFileSync(
        'docker',
        [
          'build',
          '-f',
          'apps/web/Dockerfile',
          '--target',
          'runtime',
          '-t',
          'estateai-web-verify-production',
          '.',
        ],
        { cwd: REPO_ROOT, stdio: 'pipe' },
      );
      check('apps/web/Dockerfile builds (runtime target)', true);

      execFileSync(
        'docker',
        ['image', 'rm', 'estateai-api-verify-production', 'estateai-web-verify-production'],
        {
          cwd: REPO_ROOT,
          stdio: 'pipe',
        },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('ENOENT')) {
        console.log('   docker CLI not available in this environment — skipping Docker checks');
      } else {
        check('Docker build/config checks', false, message.slice(0, 500));
      }
    }

    console.log('9. regression smoke — pre-Phase-11 endpoints are unaffected');
    const categoriesRes = await api('GET', '/categories', owner.accessToken);
    check('GET /categories still works', categoriesRes.status === 200, `${categoriesRes.status}`);
    const assetGetRes = await api('GET', `/assets/${assetId}`, owner.accessToken);
    check('GET /assets/:id still works', assetGetRes.status === 200, `${assetGetRes.status}`);
    const meRes = await api('GET', '/auth/me', owner.accessToken);
    check('GET /auth/me still works', meRes.status === 200, `${meRes.status}`);

    if (state.failed) {
      console.error('\nOne or more production readiness checks FAILED.');
    } else {
      console.log('\nAll production readiness checks passed.');
    }
  } finally {
    console.log('10. cleanup');
    wsClient?.close();
    claudeMock?.close();
    for (const id of jobIds) {
      try {
        await jobRepository.update(id, { status: 'CANCELLED' });
      } catch {
        // Already terminal — fine.
      }
    }
    for (const id of aiLogIds) {
      try {
        await aiRequestLogRepository.delete(id);
      } catch {
        // Already deleted — fine.
      }
    }
    if (assetId) await assetRepository.delete(assetId);
    if (categoryId) await categoryRepository.delete(categoryId);
    if (adminId) await userRepository.delete(adminId);
    if (ownerId) await userRepository.delete(ownerId);
    console.log('   test data cleaned up');
  }

  await prisma.$disconnect();
  process.exit(state.failed ? 1 : 0);
}

void main();
