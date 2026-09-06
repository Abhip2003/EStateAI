import { config } from './config/env.js';
import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import fastifyHelmet from '@fastify/helmet';
import fastifyCors from '@fastify/cors';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyCompress from '@fastify/compress';
import { healthRoutes } from './routes/health.js';
import { metricsRoutes } from './routes/metrics.js';
import { authRoutes } from './routes/auth.js';
import { categoryRoutes } from './routes/categories.js';
import { assetRoutes } from './routes/assets.js';
import { tagRoutes } from './routes/tags.js';
import { accountRoutes } from './routes/accounts.js';
import { oauthRoutes } from './routes/oauth.js';
import { jobRoutes } from './routes/jobs.js';
import { resourceRoutes } from './routes/resources.js';
import { analysisRoutes } from './routes/analysis.js';
import { policyRoutes } from './routes/policies.js';
import { agentRoutes } from './routes/agents.js';
import { aiRoutes } from './routes/ai.js';
import { orchestratorRoutes } from './routes/orchestrator.js';
import { discoveryRoutes } from './routes/discovery.js';
import { riskAgentRoutes } from './routes/risk-agent.js';
import { complianceAgentRoutes } from './routes/compliance-agent.js';
import { recommendationAgentRoutes } from './routes/recommendation-agent.js';
import { reportAgentRoutes } from './routes/report-agent.js';
import { copilotAgentRoutes } from './routes/copilot-agent.js';
import { knowledgeRoutes } from './routes/knowledge.js';
import { knowledgeRagRoutes } from './routes/knowledge-rag.js';
import { copilotRoutes } from './routes/copilot.js';
import { plannerRoutes } from './routes/planner.js';
import { approvalRoutes } from './routes/approval.js';
import { langgraphRoutes } from './routes/langgraph.js';
import { llmPlannerRoutes } from './routes/llm-planner.js';
import { debateRoutes } from './routes/debate.js';
import { episodesRoutes } from './routes/episodes.js';
import { aiGraphRoutes } from './routes/ai-graph.js';
import { registerBuiltinTools } from './ai/tools/builtin/index.js';
import { registerWebSocketGateway } from './services/websocket/websocket-gateway.js';
import { authPlugin } from './plugins/auth.js';
import { randomUUID } from 'node:crypto';
import { observabilityPlugin } from './plugins/observability.js';
import { prisma } from './db/prisma.js';
import { closeRedisConnection } from './cache/redis.js';
import { workerPool } from './workers/worker-pool.js';
import { startHeartbeatMonitor } from './workers/heartbeat.js';
import { registerGracefulShutdown } from './workers/shutdown.js';
import { pinoOptions } from './observability/logger.js';

// TRUSTED_PROXIES: 'true' (trust the immediate peer — correct for exactly
// one reverse proxy in front, e.g. this repo's own nginx), 'false' (trust
// nothing, the default), or a comma-separated allowlist of proxy IPs/CIDRs.
// This is what makes `request.ip` (and therefore @fastify/rate-limit's
// per-IP bucketing) reflect the real client behind nginx's
// X-Forwarded-For instead of always resolving to the proxy's own address.
function resolveTrustProxy(value: string): boolean | string[] {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value.split(',').map((entry) => entry.trim());
}

const app = Fastify({
  logger: pinoOptions,
  // Every request gets a real, globally-unique id (Fastify's default is a
  // per-process incrementing counter, not safe to correlate across
  // restarts/instances) — and a reverse proxy's own x-request-id/
  // x-correlation-id, when present, wins over generating a new one, so a
  // request can be traced end-to-end from nginx through to the API's own
  // logs.
  genReqId: (req) =>
    (req.headers['x-request-id'] as string | undefined) ??
    (req.headers['x-correlation-id'] as string | undefined) ??
    randomUUID(),
  // Fastify's own automatic "incoming request"/"request completed" log
  // lines are replaced by observabilityPlugin's single, richer structured
  // line (requestId/correlationId/userId/assetId/route/status/duration) —
  // this avoids logging the same request twice.
  disableRequestLogging: true,
  bodyLimit: config.security.bodyLimitBytes,
  trustProxy: resolveTrustProxy(config.trustedProxies),
});

// Called directly (not via app.register) so the decorations attach to this
// root instance rather than a new encapsulated child context, making
// app.authenticate visible to the sibling route plugins registered below.
authPlugin(app);
observabilityPlugin(app);

// Security middleware (Phase 11) — registered before every route so it
// applies uniformly, same reasoning as authPlugin/observabilityPlugin
// being called first.
await app.register(fastifyHelmet, {
  // The API is a pure JSON backend consumed by a separate frontend
  // deployable, never a browser-rendered page — a default CSP tuned for
  // HTML responses would only add noise to every JSON response's headers
  // for no protective benefit here.
  contentSecurityPolicy: false,
});
await app.register(fastifyCors, {
  origin: config.security.corsOrigin === '*' ? true : config.security.corsOrigin.split(','),
  // @fastify/cors's own default is 'GET,HEAD,POST' only (see
  // node_modules/@fastify/cors/index.js's defaultOptions) — every verb
  // this API's routes actually use (PATCH/DELETE included) must be
  // listed explicitly or the browser blocks the real request at the
  // OPTIONS preflight step before it ever reaches Fastify.
  methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
});
await app.register(fastifyRateLimit, {
  max: config.security.rateLimitMax,
  timeWindow: config.security.rateLimitWindowMs,
  // Health/metrics endpoints are polled continuously by infra (Docker
  // healthchecks, a Prometheus scraper) — counting those against the same
  // budget as real API traffic would make the rate limit fire on
  // monitoring load, not abuse.
  allowList: (request) => request.url.startsWith('/health') || request.url.startsWith('/metrics'),
});
if (config.compression.enabled) {
  // gzip/brotli response compression. nginx (nginx/nginx.conf) also
  // compresses at the edge for production traffic — this is what makes
  // compression apply the same way when the API is hit directly (dev,
  // internal service-to-service calls that bypass nginx, verify scripts).
  await app.register(fastifyCompress, { global: true });
}

await app.register(healthRoutes);
await app.register(metricsRoutes);
await app.register(authRoutes);
await app.register(categoryRoutes);
await app.register(assetRoutes);
await app.register(tagRoutes);
await app.register(accountRoutes);
await app.register(oauthRoutes);
await app.register(jobRoutes);
await app.register(resourceRoutes);
await app.register(analysisRoutes);
await app.register(policyRoutes);
await app.register(agentRoutes);
await app.register(aiRoutes);
await app.register(orchestratorRoutes);
await app.register(discoveryRoutes);
await app.register(riskAgentRoutes);
await app.register(complianceAgentRoutes);
await app.register(recommendationAgentRoutes);
await app.register(reportAgentRoutes);
await app.register(copilotAgentRoutes);
await app.register(knowledgeRoutes);
await app.register(knowledgeRagRoutes);
await app.register(copilotRoutes);
await app.register(plannerRoutes);
await app.register(approvalRoutes);
await app.register(langgraphRoutes);
await app.register(llmPlannerRoutes);
await app.register(debateRoutes);
await app.register(episodesRoutes);
await app.register(aiGraphRoutes);

// Generic, agent-agnostic tools (Phase 24) — registered once, after every
// agent module above has already self-registered its own tools (each
// route import above transitively imports that agent's index.ts), so
// registration order never matters between the two: tool names are
// disjoint (postgres_query/github_repository_info/fs_*/web_search/
// knowledge_search vs. every agent's own risk_*/compliance_*/etc names).
registerBuiltinTools();

// WebSocket support (Phase 10) — registered last, after every REST route.
// registerWebSocketGateway is called directly (not via app.register) for
// the same reason authPlugin is above: /ws needs to sit on the root
// instance, not a new encapsulated child context.
await app.register(fastifyWebsocket);
registerWebSocketGateway(app);

app.addHook('onClose', async () => {
  await prisma.$disconnect();
  await closeRedisConnection();
});

async function start(): Promise<void> {
  try {
    await app.listen({ port: config.port, host: config.host });

    // In-process worker pool: this single deployable runs both the HTTP
    // API and the job workers. Gated by WORKERS_ENABLED so it can be
    // disabled (e.g. a future dedicated worker deployment, or tests that
    // want to control job execution manually) without a code change.
    if (config.jobs.workersEnabled) {
      workerPool.start(config.jobs.workerCount);
      const heartbeatTimer = startHeartbeatMonitor();
      registerGracefulShutdown(app.server, heartbeatTimer);
    }
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

void start();
