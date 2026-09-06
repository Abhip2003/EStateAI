import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().min(1).default('0.0.0.0'),
  DATABASE_URL: z.url({ protocol: /^postgresql?$/ }),
  REDIS_HOST: z.string().min(1),
  REDIS_PORT: z.coerce.number().int().positive(),
  REDIS_PASSWORD: z
    .string()
    .optional()
    .transform((value) => (value ? value : undefined)),
  REDIS_DB: z.coerce.number().int().nonnegative().default(0),
  BCRYPT_COST: z.coerce.number().int().min(4).max(31).default(12),
  JWT_SECRET: z.string().min(32),
  JWT_EXPIRES_IN: z.string().min(1).default('15m'),
  JWT_ISSUER: z.string().min(1).default('estateai'),
  JWT_AUDIENCE: z.string().min(1).default('estateai-api'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  // AES-256 needs a 32-byte key; hex-encoded that's exactly 64 characters.
  CREDENTIAL_ENCRYPTION_KEY: z
    .string()
    .length(64, 'must be a 64-character hex string (32 bytes) for AES-256')
    .regex(/^[0-9a-f]+$/i, 'must be hex-encoded'),
  // How long a minted OAuth `state` value stays redeemable in Redis before
  // the callback is rejected as expired.
  OAUTH_STATE_TTL_SECONDS: z.coerce.number().int().positive().default(600),
  GITHUB_CLIENT_ID: z.string().min(1),
  GITHUB_CLIENT_SECRET: z.string().min(1),
  GITHUB_CALLBACK_URL: z.url(),
  // Overridable so GitHub Enterprise Server deployments (or a local mock in
  // verification scripts) can point at a different host than github.com.
  GITHUB_AUTHORIZE_URL: z.url().default('https://github.com/login/oauth/authorize'),
  GITHUB_TOKEN_URL: z.url().default('https://github.com/login/oauth/access_token'),
  GITHUB_USER_URL: z.url().default('https://api.github.com/user'),
  GITHUB_REPOS_URL: z.url().default('https://api.github.com/user/repos'),
  GITHUB_ORGS_URL: z.url().default('https://api.github.com/user/orgs'),
  // Base URL for repo-scoped endpoints (branches/contents/commits/pulls/
  // issues) the generic GitHub Tool (Phase 24) calls — separate from the
  // fixed URLs above since those endpoints need a `{owner}/{repo}`
  // segment interpolated in, not a static path. Overridable for the same
  // reason as GITHUB_USER_URL etc: a local mock server in verify scripts.
  GITHUB_API_BASE_URL: z.url().default('https://api.github.com'),
  // Async job platform (Phase 4)
  WORKERS_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  JOB_WORKER_COUNT: z.coerce.number().int().positive().default(2),
  JOB_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(2000),
  JOB_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().positive().default(15000),
  JOB_HEARTBEAT_STALE_MS: z.coerce.number().int().positive().default(60000),
  JOB_HEARTBEAT_CHECK_INTERVAL_MS: z.coerce.number().int().positive().default(30000),
  JOB_DEFAULT_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  // Comma-separated ms delays, one per retry attempt: 1m, 5m, 15m, 30m, 1h,
  // 6h, 24h. The last value repeats if attempts exceed the list length.
  JOB_RETRY_BACKOFF_MS: z
    .string()
    .default('60000,300000,900000,1800000,3600000,21600000,86400000')
    .transform((v) => v.split(',').map(Number)),
  // Intelligence Foundation (Phase 6A) — per-severity weight contributed to
  // a RiskScore's overallScore for each OPEN finding at that severity.
  // Overridable so the weighting can be tuned without a code change.
  RISK_WEIGHT_CRITICAL: z.coerce.number().int().nonnegative().default(100),
  RISK_WEIGHT_HIGH: z.coerce.number().int().nonnegative().default(70),
  RISK_WEIGHT_MEDIUM: z.coerce.number().int().nonnegative().default(40),
  RISK_WEIGHT_LOW: z.coerce.number().int().nonnegative().default(20),
  RISK_WEIGHT_INFORMATIONAL: z.coerce.number().int().nonnegative().default(5),
  // AI Integration Framework (Phase 7B) — provider selection + credentials.
  // API keys are optional at the env layer (a deployment might only ever
  // use one provider); AIProviderRegistry/AIService fail per-request, not
  // at startup, if an unconfigured provider is actually invoked.
  AI_PROVIDER: z.enum(['claude', 'openai', 'gemini']).default('claude'),
  CLAUDE_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  // Overridable so a local mock (verify-ai.ts) can stand in for the real
  // vendor endpoint, same pattern as GITHUB_*_URL.
  CLAUDE_API_URL: z.url().default('https://api.anthropic.com/v1/messages'),
  OPENAI_API_URL: z.url().default('https://api.openai.com/v1/chat/completions'),
  GEMINI_API_URL: z.url().default('https://generativelanguage.googleapis.com/v1beta/models'),
  AI_DEFAULT_MAX_TOKENS: z.coerce.number().int().positive().default(1024),
  AI_MAX_RETRIES: z.coerce.number().int().positive().default(2),
  AI_RETRY_BACKOFF_MS: z.coerce.number().int().nonnegative().default(500),
  AI_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  // Knowledge Retrieval & Context Builder (Phase 7C)
  KNOWLEDGE_MAX_CONTEXT_TOKENS: z.coerce.number().int().positive().default(4000),
  // Beyond this many items sharing the same groupKey within one section
  // (e.g. 4+ findings with the same ruleCode), KnowledgeService collapses
  // the overflow into one summary item instead of listing each individually.
  KNOWLEDGE_COLLAPSE_THRESHOLD: z.coerce.number().int().positive().default(3),
  // Phase 31 — Python AI service delegation.
  // 'typescript' (default): the existing in-process TS agents run, exactly
  // as before. 'python': supported AI_* jobs and the Copilot chat route are
  // delegated over HTTP to apps/ai-service, which reimplements the agent
  // layer in FastAPI + LangChain + LangGraph. The TS agents always remain
  // as the fallback — switching back is a single env change, no redeploy of
  // logic.
  AI_SERVICE_MODE: z.enum(['typescript', 'python']).default('typescript'),
  AI_SERVICE_URL: z.url().default('http://localhost:8000'),
  // Shared secret sent as X-Service-Token; must match the Python service's
  // AI_SERVICE_TOKEN. Never logged.
  AI_SERVICE_TOKEN: z.string().min(8).default('dev-insecure-service-token-change-me'),
  AI_SERVICE_TIMEOUT_MS: z.coerce.number().int().positive().default(60000),
  // Long-Term Memory / RAG (Phase 23) — embedding provider selection.
  // Defaults to 'local' (a deterministic, dependency-free fallback) so
  // indexing/retrieval work out of the box in dev/CI without an OpenAI
  // key configured, mirroring how LLM narration steps elsewhere degrade
  // to a deterministic fallback rather than hard-failing without a key.
  EMBEDDING_PROVIDER: z.enum(['local', 'openai']).default('local'),
  EMBEDDING_MODEL: z.string().default('text-embedding-3-small'),
  EMBEDDING_API_URL: z.url().default('https://api.openai.com/v1/embeddings'),
  // Production Readiness (Phase 11)
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).optional(),
  METRICS_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  // Comma-separated list of allowed origins, or '*' for any (never do this
  // in production — the schema doesn't forbid it, since a reverse proxy
  // deployment may intentionally terminate CORS at nginx instead).
  CORS_ORIGIN: z.string().default('*'),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(1000),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60000),
  // Fastify's own bodyLimit, in bytes — rejects an oversized request before
  // it's ever parsed.
  BODY_LIMIT_BYTES: z.coerce.number().int().positive().default(1048576),
  // Cloud Production Readiness (Phase 12)
  // A QUEUED (never-yet-attempted) job waiting longer than this is
  // reported as a "degraded" queue in GET /health/ready — see
  // JobService.getQueueHealth().
  QUEUE_UNHEALTHY_AGE_MS: z.coerce.number().int().positive().default(120000),
  // GET /health/ready's memory check compares process.memoryUsage().rss
  // against this — informational only, never gates readiness (see
  // DECISIONS.md, same pattern as the Phase 11 AI check).
  MEMORY_WARNING_BYTES: z.coerce.number().int().positive().default(1610612736), // 1.5 GiB
  // Same, for the disk check's free-space threshold.
  DISK_WARNING_BYTES: z.coerce.number().int().positive().default(536870912), // 512 MiB
  COMPRESSION_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  // Fastify's `trustProxy` option, as a string so all of its accepted
  // shapes are representable in an env var: 'true' (trust the immediate
  // peer — fine behind exactly one reverse proxy, e.g. this repo's own
  // nginx), 'false' (trust nothing — client IP is always the raw socket
  // address, the safe default with no proxy in front), or a comma-
  // separated allowlist of proxy IPs/CIDRs for a multi-hop topology.
  TRUSTED_PROXIES: z.string().default('false'),
});

function loadEnv() {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    console.error('Invalid environment configuration:\n');
    for (const issue of result.error.issues) {
      console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
    }
    process.exit(1);
  }

  return result.data;
}

const env = loadEnv();

// LOG_LEVEL has no schema-level default because the right default depends
// on NODE_ENV, not a fixed value: verbose in development, quiet-but-real
// in test (so a failing verify run can still see warnings/errors without
// being drowned in per-request debug lines), standard in production.
function defaultLogLevel(nodeEnv: typeof env.NODE_ENV): string {
  switch (nodeEnv) {
    case 'development':
      return 'debug';
    case 'test':
      return 'warn';
    case 'production':
      return 'info';
  }
}

export const config = Object.freeze({
  nodeEnv: env.NODE_ENV,
  port: env.PORT,
  host: env.HOST,
  database: Object.freeze({
    url: env.DATABASE_URL,
  }),
  redis: Object.freeze({
    host: env.REDIS_HOST,
    port: env.REDIS_PORT,
    password: env.REDIS_PASSWORD,
    db: env.REDIS_DB,
  }),
  security: Object.freeze({
    bcryptCost: env.BCRYPT_COST,
    credentialEncryptionKey: env.CREDENTIAL_ENCRYPTION_KEY,
    corsOrigin: env.CORS_ORIGIN,
    rateLimitMax: env.RATE_LIMIT_MAX,
    rateLimitWindowMs: env.RATE_LIMIT_WINDOW_MS,
    bodyLimitBytes: env.BODY_LIMIT_BYTES,
  }),
  jwt: Object.freeze({
    secret: env.JWT_SECRET,
    expiresIn: env.JWT_EXPIRES_IN,
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE,
  }),
  refreshToken: Object.freeze({
    ttlDays: env.REFRESH_TOKEN_TTL_DAYS,
  }),
  oauth: Object.freeze({
    stateTtlSeconds: env.OAUTH_STATE_TTL_SECONDS,
    github: Object.freeze({
      clientId: env.GITHUB_CLIENT_ID,
      clientSecret: env.GITHUB_CLIENT_SECRET,
      callbackUrl: env.GITHUB_CALLBACK_URL,
      authorizeUrl: env.GITHUB_AUTHORIZE_URL,
      tokenUrl: env.GITHUB_TOKEN_URL,
      userUrl: env.GITHUB_USER_URL,
      reposUrl: env.GITHUB_REPOS_URL,
      orgsUrl: env.GITHUB_ORGS_URL,
      apiBaseUrl: env.GITHUB_API_BASE_URL,
    }),
  }),
  jobs: Object.freeze({
    workersEnabled: env.WORKERS_ENABLED,
    workerCount: env.JOB_WORKER_COUNT,
    pollIntervalMs: env.JOB_POLL_INTERVAL_MS,
    heartbeatIntervalMs: env.JOB_HEARTBEAT_INTERVAL_MS,
    heartbeatStaleMs: env.JOB_HEARTBEAT_STALE_MS,
    heartbeatCheckIntervalMs: env.JOB_HEARTBEAT_CHECK_INTERVAL_MS,
    defaultMaxAttempts: env.JOB_DEFAULT_MAX_ATTEMPTS,
    retryBackoffMs: env.JOB_RETRY_BACKOFF_MS,
    queueUnhealthyAgeMs: env.QUEUE_UNHEALTHY_AGE_MS,
  }),
  risk: Object.freeze({
    weights: Object.freeze({
      CRITICAL: env.RISK_WEIGHT_CRITICAL,
      HIGH: env.RISK_WEIGHT_HIGH,
      MEDIUM: env.RISK_WEIGHT_MEDIUM,
      LOW: env.RISK_WEIGHT_LOW,
      INFORMATIONAL: env.RISK_WEIGHT_INFORMATIONAL,
    }),
  }),
  ai: Object.freeze({
    defaultProvider: env.AI_PROVIDER,
    defaultMaxTokens: env.AI_DEFAULT_MAX_TOKENS,
    maxRetries: env.AI_MAX_RETRIES,
    retryBackoffMs: env.AI_RETRY_BACKOFF_MS,
    requestTimeoutMs: env.AI_REQUEST_TIMEOUT_MS,
    claude: Object.freeze({
      apiKey: env.CLAUDE_API_KEY,
      apiUrl: env.CLAUDE_API_URL,
    }),
    openai: Object.freeze({
      apiKey: env.OPENAI_API_KEY,
      apiUrl: env.OPENAI_API_URL,
    }),
    gemini: Object.freeze({
      apiKey: env.GEMINI_API_KEY,
      apiUrl: env.GEMINI_API_URL,
    }),
  }),
  knowledge: Object.freeze({
    maxContextTokens: env.KNOWLEDGE_MAX_CONTEXT_TOKENS,
    collapseThreshold: env.KNOWLEDGE_COLLAPSE_THRESHOLD,
  }),
  aiService: Object.freeze({
    mode: env.AI_SERVICE_MODE,
    url: env.AI_SERVICE_URL,
    token: env.AI_SERVICE_TOKEN,
    timeoutMs: env.AI_SERVICE_TIMEOUT_MS,
  }),
  embedding: Object.freeze({
    provider: env.EMBEDDING_PROVIDER,
    model: env.EMBEDDING_MODEL,
    apiKey: env.OPENAI_API_KEY,
    apiUrl: env.EMBEDDING_API_URL,
  }),
  logging: Object.freeze({
    level: env.LOG_LEVEL ?? defaultLogLevel(env.NODE_ENV),
  }),
  metrics: Object.freeze({
    enabled: env.METRICS_ENABLED,
  }),
  health: Object.freeze({
    memoryWarningBytes: env.MEMORY_WARNING_BYTES,
    diskWarningBytes: env.DISK_WARNING_BYTES,
  }),
  compression: Object.freeze({
    enabled: env.COMPRESSION_ENABLED,
  }),
  trustedProxies: env.TRUSTED_PROXIES,
});
