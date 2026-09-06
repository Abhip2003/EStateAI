# Deployment Guide

Covers deploying `apps/api` + `apps/web` to a production host: environment variables, scaling, performance, security, backup/restore, rollback, and monitoring. Written against the Docker artifacts introduced at Phase 11 and extended at Phase 12 (`apps/api/Dockerfile`, `apps/web/Dockerfile`, `docker-compose.prod.yml`, `nginx/nginx.conf`), with the operational sections (server requirements, manual deployment, performance, security checklist, rollback, Grafana/OpenTelemetry monitoring guidance, troubleshooting) added at Phase 14 — see `ARCHITECTURE.md`'s "Production Readiness" sections for how these pieces fit together architecturally; this document is the operational how-to.

## 1. Deployment guide

### Topology
```
Internet → nginx (port 80, TLS termination not configured — see "TLS" below)
             ├─ /ws, /auth, /assets, ... , /health*, /metrics  → api:3000  (Fastify)
             ├─ /_next/static/*                                → web:3001  (cached)
             └─ everything else                                → web:3001  (Next.js)
api   → Postgres (source of truth), Redis (job-queue fast path + fast-path signal only)
```
One `apps/api` container also runs the in-process job worker pool (`WORKERS_ENABLED=true`, the default) — there is no separate worker deployable today. See "Scaling" below for what changes if you need one.

### Prerequisites
- Docker + Docker Compose v2 (`docker compose`, not the legacy `docker-compose` binary)
- A Postgres 16-compatible database (the bundled `postgres:16` container, or a managed instance — see "Using a managed database" below)
- A GitHub OAuth App (`GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET`) if the discovery/sync features will be used
- At least one AI provider API key if AI features (`aiMode`, `/copilot/chat`) will be used — optional, see `config/env.ts`'s own comment: the app runs fine with none configured, those features just fail per-request

### Server requirements
Nothing in this codebase is resource-hungry by design (no ML inference, no local vector index, no video/image processing) — the numbers below are a reasonable starting point for the full bundled stack (nginx + api + web + postgres + redis) on one host at low-to-moderate traffic, not a load-tested figure.

| Resource | Minimum | Notes |
|---|---|---|
| CPU | 2 vCPU | `apps/api` is single-threaded per replica (Node event loop); more cores help by running more replicas (see Scaling), not one bigger process. |
| Memory | 2 GB | ~512 MB–1 GB for `apps/api` (`MEMORY_WARNING_BYTES` defaults to 1.5 GB — tune to your actual container limit), the rest split across Postgres/Redis/nginx/`apps/web`. |
| Disk | 10 GB+ | Dominated by Postgres data growth over time, not the application images (`DISK_WARNING_BYTES` defaults to a 512 MB free-space floor — raise it on a small volume). |
| OS | Any Docker-capable Linux host | Images are built `FROM node:20-alpine`; no host OS assumptions beyond having a working Docker daemon. |
| Network | Outbound HTTPS | Required for GitHub OAuth token exchange, GitHub API discovery calls, and whichever AI provider(s) are configured. |

Single-host is fine for `docker-compose.prod.yml` as shipped (one replica per service, no orchestrator). See "Scaling" below for what changes past that.

### First deploy
```bash
cp apps/api/production.env.example apps/api/.env
# Edit apps/api/.env: replace every "replace-..." placeholder — real JWT_SECRET,
# CREDENTIAL_ENCRYPTION_KEY, GITHUB_*, AI provider keys, and CORS_ORIGIN set to
# your real apps/web origin. (apps/api/development.env.example is the
# equivalent file for local development instead — see docs/development.md.)

export POSTGRES_PASSWORD=<a real password>
export NEXT_PUBLIC_API_URL=https://your-domain.example  # baked into the web build

docker compose -f docker-compose.prod.yml up -d --build

# Apply migrations — deliberately not automatic (see DECISIONS.md):
docker compose -f docker-compose.prod.yml exec api pnpm prisma:deploy

# Optional: seed a single admin user so there's something to log in with on
# a brand new database (idempotent, safe to skip if you already have a real
# admin — see src/scripts/seed.ts). Change its password immediately after login.
docker compose -f docker-compose.prod.yml exec api pnpm prisma:seed

# Verify:
curl http://your-host/health/ready
```

### Subsequent deploys
```bash
git pull
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml exec api pnpm prisma:deploy   # only if new migrations exist
```
There's no zero-downtime rolling-deploy mechanism in `docker-compose.prod.yml` itself (single replica per service) — a `docker compose up -d --build` recreates `api`/`web` with a brief gap. See "Scaling" for a multi-replica setup that avoids this.

### Manual deployment (without Docker)
Only needed if the target host can't run Docker at all — the Docker path above is strongly preferred (it's what's actually tested via CI's `docker-build` job). This runs the same two build artifacts CI produces (see `.github/workflows/ci.yml`'s `api-dist`/`web-standalone` upload steps) directly with a host-installed Node 20 + pnpm, against host-installed (or externally managed) Postgres 16 and Redis 7.

```bash
# Install dependencies and build both apps (from the repo root)
corepack enable
pnpm install --frozen-lockfile
pnpm --filter api prisma:generate
pnpm --filter api build
pnpm --filter web build      # requires NEXT_PUBLIC_API_URL set beforehand — see .env

# Apply migrations
cd apps/api && pnpm prisma:deploy && cd -

# Run the API — reads apps/api/.env the same way it does under Docker
cd apps/api && NODE_ENV=production node dist/server.js &

# Run the web frontend — Next's standalone output is self-contained
# (bundles its own node_modules subset), copy it out or run in place:
cd apps/web && PORT=3001 HOSTNAME=0.0.0.0 node .next/standalone/apps/web/server.js &
```
Put a reverse proxy (this repo's own `nginx/nginx.conf` works unmodified — it only assumes `api`/`web` are reachable hostnames, which resolve fine as `localhost` with an adjusted `upstream` block) in front of both processes; run each under a process supervisor (systemd, pm2, etc.) for restart-on-crash — `docker-compose.prod.yml`'s `restart: unless-stopped` has no manual-deploy equivalent otherwise. There is no init script/systemd unit shipped in this repo; write one against the two commands above.

### TLS
`nginx/nginx.conf` listens on plain HTTP (port 80) only. To add TLS: terminate it either at a layer in front of this stack (a cloud load balancer, Cloudflare, etc. — the common choice, since certificate provisioning/renewal is infrastructure-specific) or by adding a `listen 443 ssl` server block to `nginx.conf` with real certificate paths (e.g. via `certbot`) and a bind-mounted cert volume. Neither is provided out of the box since certs are deployment-specific.

### Using a managed database instead of the bundled Postgres container
Set `DATABASE_URL` directly in `apps/api/.env` (it overrides the compose file's constructed URL only if you also drop the `postgres` service from `docker-compose.prod.yml`) and point `REDIS_HOST`/`REDIS_PORT` at a managed Redis instance the same way. The app itself has no dependency on either being the bundled containers — `db/prisma.ts`/`cache/redis.ts` only ever read from `config`.

## 2. Production environment variables

Full reference lives in `apps/api/.env.example` (every var, with its default and rationale inline). The ones that matter most for a production deploy specifically:

| Variable | Required | Notes |
|---|---|---|
| `NODE_ENV=production` | Yes | Set by `docker-compose.prod.yml` already — drives `LOG_LEVEL`'s default (`info`) and disables the dev-only pretty log transport. |
| `JWT_SECRET` | Yes | ≥32 chars, real random value — never the `.env.example` placeholder. |
| `CREDENTIAL_ENCRYPTION_KEY` | Yes | 64-char hex (32 bytes). Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. Rotating this makes every already-stored `Account.credentialCiphertext` undecryptable — see `DATABASE.md`. |
| `DATABASE_URL`, `REDIS_HOST`/`REDIS_PORT`/`REDIS_PASSWORD` | Yes | See "Using a managed database" above if not using the bundled containers. |
| `GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET`/`GITHUB_CALLBACK_URL` | Yes (schema requires them) | `GITHUB_CALLBACK_URL` must be your real public URL's `/oauth/github/callback`, registered in the GitHub OAuth App. |
| `CLAUDE_API_KEY`/`OPENAI_API_KEY`/`GEMINI_API_KEY` | Optional | Only the one matching `AI_PROVIDER` needs to be real. |
| `CORS_ORIGIN` | Recommended | Defaults to `*` — set to your real `apps/web` origin(s) in production. |
| `TRUSTED_PROXIES` | Recommended | `docker-compose.prod.yml` already sets this to `'true'` for the bundled nginx topology (exactly one hop in front). Change only if your real topology differs (e.g. a cloud LB *and* nginx — see the `TRUSTED_PROXIES` comment in `.env.example` for the CIDR-allowlist form). |
| `RATE_LIMIT_MAX`/`RATE_LIMIT_WINDOW_MS` | Recommended | App-level default (1000/60s) is sized for `apps/api`'s own verify-suite traffic, not tuned to your real production load — revisit once you know real traffic patterns. `nginx.conf`'s own `limit_req_zone` (20r/s) is the edge-level complement (Phase 12). |
| `WORKERS_ENABLED` | Situational | `true` (default) runs job workers in the same process as the HTTP API. Set `false` on any replica that should serve HTTP only — see "Scaling". |
| `MEMORY_WARNING_BYTES`/`DISK_WARNING_BYTES`/`QUEUE_UNHEALTHY_AGE_MS` | Optional | Thresholds for `/health/ready`'s informational (non-gating) memory/disk/queue fields — tune to your actual container resource limits. |

`docker-compose.prod.yml` also requires `POSTGRES_PASSWORD` (exported in your shell or a root `.env` Compose reads automatically) and `NEXT_PUBLIC_API_URL` (build-time only, baked into the Next.js bundle — see `apps/web/Dockerfile`).

## 3. Scaling guide

**Vertical (raise container resource limits)** — the simplest lever. `apps/api` is a single Node process; more CPU mainly helps under concurrent request load, more memory raises the ceiling `MEMORY_WARNING_BYTES` should be tuned against.

**Horizontal — HTTP layer**: `apps/api` is safe to run as multiple replicas behind nginx (add more `server api:3000;` lines to the `estateai_api` upstream in `nginx.conf`, or point it at a real load balancer) — every replica shares the same Postgres/Redis, and Fastify itself holds no in-process session state for REST routes. Two things do **not** currently fan out across replicas (see `ARCHITECTURE.md`'s "What does not exist yet" and `DECISIONS.md`):
- **WebSocket** (`realtime-bus.ts`) — an event published on one replica only reaches connections held open on that same replica. A client connected to replica A never sees an event created via a request replica B handled. Needed before scaling horizontally with WebSocket features in real use: a shared pub/sub transport (Redis pub/sub is the natural choice, already in this stack) behind `realtimeBus`'s existing `publishAssetEvent`/`onAssetEvent` interface.
- **`/metrics`** — reflects only the replica that answered the scrape. A Prometheus setup needs to either scrape every replica individually (via DNS-based service discovery) or aggregate via a push-gateway; this repo ships neither.

**Horizontal — job workers**: every `apps/api` replica with `WORKERS_ENABLED=true` runs its own `WorkerPool`, all polling the same Postgres/Redis queue — `JobRepository`'s status-guarded claim (`UPDATE ... WHERE status='QUEUED'`) is what makes this safe without any inter-replica coordination (see `ARCHITECTURE.md`'s async-domains section). To scale workers independently of HTTP capacity, run a dedicated replica set with `WORKERS_ENABLED=true` but no public ingress, and set `WORKERS_ENABLED=false` on your HTTP-facing replicas — `JOB_WORKER_COUNT` controls how many polling workers run per replica.

**Database**: Postgres is the one hard bottleneck with no built-in fan-out in this codebase — read replicas or connection pooling (PgBouncer) are the standard next steps if it becomes one, neither wired up here.

## 4. Performance guide

**Cache headers**: `nginx/nginx.conf` sets `Cache-Control: public, max-age=31536000, immutable` only on `/_next/static/*` (content-hashed, safe to cache forever) — nothing else is cached, since API responses are per-user/JWT-authenticated and the app shell HTML needs to stay live. Verify: `curl -sI http://your-host/_next/static/<any-hashed-file>` should show that header; `curl -sI http://your-host/dashboard` should not.

**Compression**: two independent layers — `apps/api`'s own `@fastify/compress` (`COMPRESSION_ENABLED=true`, gzip/brotli, applies even when the API is hit directly) and `nginx.conf`'s `gzip on` (applies at the edge for both `api` and `web` traffic). Verify either: `curl -sH 'Accept-Encoding: gzip' -o /dev/null -w '%{size_download} %{header_json}' http://your-host/assets` and check for a `content-encoding: gzip` (or `br`) response header.

**Redis tuning**: Redis's role in this codebase is a fast-path job-queue signal only — Postgres remains the source of truth (`JobRepository`'s DB-level claim is what's actually safe under concurrent workers), so Redis holds no durable state that benefits from persistence tuning. The bundled `redis:7` image's defaults are adequate; if running a shared/external Redis instance, `maxmemory-policy allkeys-lru` (or leaving eviction off entirely, given the low, ephemeral key volume) is a reasonable choice — there's no scenario in this codebase where evicting a stale key causes incorrect behavior, only a slightly delayed job pickup until the next poll interval.

**Connection pooling**: `apps/api` uses Prisma's `@prisma/adapter-pg` over `pg`'s own connection pool — no `connection_limit` is set explicitly in `DATABASE_URL` today, so `pg` picks its default (currently 10). One `apps/api` replica opens up to that many connections; N replicas means up to `N × pool size` against Postgres — factor that in before scaling replica count against a `max_connections`-limited managed database, or add `?connection_limit=<n>` to `DATABASE_URL` (or front Postgres with PgBouncer — see the Scaling guide's Database note) if replicas ever multiply enough for this to matter.

## 5. Security checklist

Everything below is already implemented (see `ARCHITECTURE.md`'s Production Readiness sections) — this is a deploy-time verification checklist, not new work.

| Control | Where | Verify |
|---|---|---|
| Helmet security headers | `@fastify/helmet` in `server.ts`, plus `nginx.conf`'s own `add_header` set (belt-and-suspenders at the edge) | `curl -sI http://your-host/health` — look for `x-frame-options`, `x-content-type-options`, etc. |
| CORS | `@fastify/cors`, `CORS_ORIGIN` | Must be your real `apps/web` origin(s) in production, **never** `*` — `production.env.example` defaults it to a placeholder that forces this decision. |
| Rate limiting | App-level `@fastify/rate-limit` (`RATE_LIMIT_MAX`/`RATE_LIMIT_WINDOW_MS`) + edge-level `nginx.conf`'s `limit_req_zone` (20r/s) — two independently-tuned layers by design, see `DECISIONS.md` | `for i in $(seq 1 30); do curl -s -o /dev/null -w '%{http_code}\n' http://your-host/health; done` shouldn't 429 under normal traffic. |
| Compression | See Performance guide above | — |
| Secure cookies | N/A — this API is stateless-bearer, not cookie-based: `POST /auth/login`/`/auth/refresh` return `accessToken`/`refreshToken` in the JSON response body, never a `Set-Cookie` header (see `API_REFERENCE.md`). There is no cookie attack surface to secure because there are no cookies; the client (`apps/web`) is responsible for storing tokens safely (see `ARCHITECTURE.md`). |
| Secrets management | `JWT_SECRET`, `CREDENTIAL_ENCRYPTION_KEY`, OAuth/AI provider keys — all read from environment (`apps/api/.env`, never committed; `.dockerignore`/`.gitignore` both exclude `**/.env`) | Confirm `apps/api/.env` isn't tracked (`git check-ignore apps/api/.env`) and isn't baked into any image layer (`.dockerignore` excludes it from the Docker build context entirely). Use a real secrets manager (not a plain `.env` file on disk) for anything beyond a single-host deploy. |
| JWT configuration | `JWT_SECRET` (≥32 chars, validated by `config/env.ts`'s Zod schema at boot — the app refuses to start with a short/placeholder value), `JWT_EXPIRES_IN=15m` short-lived access tokens, rotating refresh tokens with reuse detection (`refresh-token.service.ts`) | Confirm `JWT_SECRET` in production is not the `.env.example`/`production.env.example` placeholder — the app would have failed to boot otherwise, but double-check after any `.env` edit. |
| Credential encryption | `CREDENTIAL_ENCRYPTION_KEY` (AES-256-GCM), OAuth account tokens (`Account.credentialCiphertext`) never stored in plaintext | Same boot-time Zod validation as `JWT_SECRET` (64-char hex, exactly 32 bytes) — see `DATABASE.md`. |
| Non-root containers | Both `apps/api/Dockerfile` and `apps/web/Dockerfile`'s `runtime` stage run `USER node` | `docker compose -f docker-compose.prod.yml exec api whoami` → `node`. |

## 6. Backup guide

**What needs backing up**: Postgres only. Redis holds no durable state (`ARCHITECTURE.md`: "Redis's role here is a fast-path signal only — Postgres remains the sole source of truth"); losing it costs nothing but a little latency until the next poll interval. Uploaded/generated files don't exist in this codebase (no file storage feature).

**Bundled-container Postgres** (`docker-compose.prod.yml`'s `postgres` service, volume `postgres_prod_data`):
```bash
# Logical dump (portable, works across Postgres versions/hosts):
docker compose -f docker-compose.prod.yml exec -T postgres \
  pg_dump -U "${POSTGRES_USER:-estateai}" "${POSTGRES_DB:-estateai}" \
  | gzip > backup-$(date +%Y%m%d-%H%M%S).sql.gz
```
Run this on a schedule (cron, or your platform's scheduled-job feature) and ship the resulting file off-host (S3, etc.) — nothing in this repo automates that last step.

**Managed database**: use your provider's own backup mechanism (RDS automated snapshots, etc.) instead of `pg_dump` against it directly — this repo has no opinion on that layer.

**Credential encryption key**: `CREDENTIAL_ENCRYPTION_KEY` is not stored in the database — it must be backed up/escrowed separately from the DB dump (a secrets manager, not source control). A DB restore without the matching key makes every `Account.credentialCiphertext` permanently undecryptable (see `DATABASE.md`).

## 7. Restore guide

```bash
# Stop the app so nothing writes during restore:
docker compose -f docker-compose.prod.yml stop api

# Restore into a running postgres container (drops and recreates the target DB — destructive):
gunzip -c backup-20260101-000000.sql.gz | \
  docker compose -f docker-compose.prod.yml exec -T postgres \
  psql -U "${POSTGRES_USER:-estateai}" -d "${POSTGRES_DB:-estateai}"

# Re-apply any migrations newer than the backup:
docker compose -f docker-compose.prod.yml exec api pnpm prisma:deploy

docker compose -f docker-compose.prod.yml start api
curl http://your-host/health/ready   # confirm database: "connected"
```
Restoring into a **fresh** Postgres volume/instance instead of overwriting a live one: bring up `postgres` alone first (`docker compose -f docker-compose.prod.yml up -d postgres`), restore into it, run `prisma:deploy`, then start `api`/`web`/`nginx`.

`CREDENTIAL_ENCRYPTION_KEY` must be restored to the exact value that was active when the backup was taken — see the Backup section's warning.

## 8. Rollback guide

No blue/green or automated rollback mechanism ships with `docker-compose.prod.yml` (single replica per service — see "Scaling"). Rolling back is a manual, two-part decision: application code and database schema move independently.

**Application code** (safe, fast — do this first for any bad deploy):
```bash
git checkout <previous-good-commit-or-tag>
docker compose -f docker-compose.prod.yml up -d --build
```
Since Postgres holds all durable state and neither `api` nor `web` are stateful otherwise, reverting the code is non-destructive on its own.

**Database migrations**: Prisma's `migrate deploy` has no built-in `down` migration — rolling back a schema change means either (a) writing and applying a new forward migration that undoes it, or (b) restoring the pre-migration backup (see "Restore guide"). Prefer (a) whenever the migration is additive (new nullable column, new table) since a restore loses every write since the backup; reserve (b) for a migration that already ran destructively (e.g. a dropped column) with no safe forward fix.

**Order matters**: if both application code and a migration need reverting, roll back the application code first (so nothing is running against a schema it doesn't expect), then handle the migration. Deploying old application code against a newer/incompatible schema (or vice versa) is the actual outage risk here, not the rollback step itself.

## 9. Monitoring guide

**Health**: `GET /health/ready` is the one endpoint to point an uptime/liveness check at — 503 only when Postgres or Redis is actually unreachable; every other field (`ai`, `workers`, `queue`, `memory`, `disk`) is informational (see `DECISIONS.md` for why none of them gate the status). Read those fields, don't just alert on the top-level `status`.

**Metrics**: `GET /metrics` (Prometheus text format — point a Prometheus server's scrape config at it, `scrape_interval: 15s` is a reasonable default). Key series to build dashboards/alerts from:
| Series | What it tells you |
|---|---|
| `estateai_http_requests_total`, `estateai_http_errors_total` | Traffic volume and error rate (`rate(estateai_http_errors_total[5m]) / rate(estateai_http_requests_total[5m])`) |
| `estateai_http_request_duration_seconds` | Latency (histogram — use `histogram_quantile`) |
| `estateai_ai_requests_total`, `estateai_ai_failures_total`, `estateai_ai_request_duration_seconds`, `estateai_ai_tokens_total` | AI call volume/failure rate/latency/token spend |
| `estateai_discovery_duration_seconds` | Discovery run latency, independent of job-framework overhead |
| `estateai_job_queue_size`, `estateai_job_execution_duration_seconds`, `estateai_jobs_failed_total`, `estateai_worker_utilization_ratio` | Whether the job queue is keeping up |
| `estateai_websocket_active_connections`, `estateai_websocket_active_subscriptions` | Live WebSocket load |
| `estateai_process_resident_memory_bytes`, `estateai_process_cpu_seconds_total`, `estateai_nodejs_*` (from `collectDefaultMetrics()`) | Process resource usage |

**Logs**: structured JSON to stdout (pino) — point your platform's log collector at container stdout (Docker's default logging driver already captures it; no separate log-shipping agent is configured in this repo). Every request log line carries `requestId`/`correlationId`/`userId`/`assetId`/`route`/`statusCode`/`responseTimeMs`, and 5xx responses additionally carry `err.message`/`err.stack` — this is enough to build a "trace this request end-to-end" view in most log platforms (Datadog, CloudWatch Logs Insights, etc.) via a `requestId`/`correlationId` filter. Note the scope limit in `DECISIONS.md`: a request's `correlationId` does not currently propagate into any job it enqueues or AI call it triggers — those get their own (job id / freshly generated) — full end-to-end tracing across HTTP → job → AI is not wired up yet.

**Log rotation**: `apps/api` never writes to a log file itself (stdout only, per the above) — there is nothing inside the container to rotate. Rotation is the *host's* or platform's responsibility for whatever captures that stdout stream:
- **Docker's default `json-file` log driver** grows unbounded unless configured — set `max-size`/`max-file` (either per-service in a compose override, or daemon-wide in `/etc/docker/daemon.json`: `{"log-driver": "json-file", "log-opts": {"max-size": "10m", "max-file": "5"}}`). `docker-compose.prod.yml` doesn't set this today — worth adding before running unattended for long periods.
- **A log-shipping agent** (Fluent Bit, Vector, Datadog Agent, CloudWatch Logs agent) reading container stdout typically replaces the need for local rotation entirely — ship first, rotate never.
- **Managed platforms** (ECS, Cloud Run, Kubernetes) generally handle this at the platform level — nothing to configure in this repo either way.

**Grafana**: not bundled, but every `/metrics` series listed above is a standard Prometheus data source away from a dashboard — point a Grafana instance's Prometheus data source at wherever your Prometheus server scrapes `/metrics` from (see above), then build panels directly from the series table. No pre-built dashboard JSON ships with this repo; the series names are stable enough (`estateai_*` prefix) to hand-build one or generate it from Grafana's own Prometheus-metrics-to-dashboard import flow.

**OpenTelemetry**: not implemented in this codebase — `apps/api` emits Prometheus-format metrics (`prom-client`) and structured JSON logs (`pino`) directly, with no OTel SDK, no trace spans, and no OTLP exporter wired in. Distributed tracing (a span per HTTP request, propagated through job execution and AI calls) is the natural next step if end-to-end tracing across HTTP → job → AI (the same gap called out in the Logs paragraph above and in `DECISIONS.md`) is ever needed — it would mean adding `@opentelemetry/sdk-node` plus auto-instrumentation for Fastify/`pg`/`ioredis`, and an OTLP exporter pointed at a collector (Jaeger, Tempo, an APM vendor). Genuinely not started, not just undocumented.

**Alerting**: no Alertmanager/Grafana config ships with this repo — `/metrics`/`/health/ready` are scrape-ready, wiring them into an actual alerting pipeline is a deployment-specific next step. Starting-point thresholds against the series above, once an alerting pipeline exists:
| Alert | Condition | Rationale |
|---|---|---|
| API down | `up{job="estateai-api"} == 0` for 1m | Prometheus itself can't reach `/metrics`. |
| Not ready | `GET /health/ready` returning 503 for 2m | Postgres or Redis actually unreachable — the one condition that endpoint gates on. |
| High error rate | `rate(estateai_http_errors_total[5m]) / rate(estateai_http_requests_total[5m]) > 0.05` for 5m | >5% of requests 5xx-ing sustained, not a single blip. |
| High latency | `histogram_quantile(0.95, rate(estateai_http_request_duration_seconds_bucket[5m])) > 2` for 5m | p95 request latency over 2s. |
| Job queue backing up | `estateai_job_queue_size > 100` for 10m, or `estateai_worker_utilization_ratio > 0.9` sustained | Workers can't keep up — see Scaling guide's job-worker section. |
| AI failure spike | `rate(estateai_ai_failures_total[10m]) > 0` sustained | Any non-transient rate of AI provider failures — this series should normally sit at ~0. |
| Memory/disk pressure | `/health/ready`'s `memory`/`disk` fields reporting non-`ok` for 5m (no dedicated metric series for these today — see `ARCHITECTURE.md`) | Matches `MEMORY_WARNING_BYTES`/`DISK_WARNING_BYTES` thresholds already computed server-side. |

These are starting points, not tuned against real production traffic — revisit once actual traffic/error baselines are known, same caveat as `RATE_LIMIT_MAX` elsewhere in this document.

## 10. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `docker compose up` succeeds but `/health/ready` returns 503 with `database: "error"` | Migrations never applied to a fresh volume (deliberately not automatic — see `DECISIONS.md`) | `docker compose -f docker-compose.prod.yml exec api pnpm prisma:deploy` |
| `api` container restarts in a loop | `.env` missing/invalid — `config/env.ts`'s Zod schema throws at boot on a missing `JWT_SECRET`, a `CREDENTIAL_ENCRYPTION_KEY` that isn't exactly 64 hex chars, etc. | `docker compose -f docker-compose.prod.yml logs api` — the Zod error names the exact offending variable. |
| Login/register works but every GitHub connection attempt fails | `GITHUB_CALLBACK_URL` doesn't match what's registered in the GitHub OAuth App, or points at `localhost` in a real deployment | Update both to the real public URL's `/oauth/github/callback`. |
| `apps/web` loads but every API call fails from the browser (not from `curl`) | `NEXT_PUBLIC_API_URL` baked in at build time doesn't match the real public API origin, or `CORS_ORIGIN` on the API doesn't include the web origin | Rebuild `web` with the correct `NEXT_PUBLIC_API_URL` build arg; fix `CORS_ORIGIN` in `apps/api/.env` and restart `api`. Both are build/boot-time values — neither can be fixed by editing `.env` alone without a rebuild/restart. |
| WebSocket connects then immediately drops | `nginx.conf`'s `/ws` location not matched (custom nginx config edited without preserving it), or a load balancer in front of nginx not forwarding `Upgrade`/`Connection` headers | Confirm `curl -i -N -H "Connection: Upgrade" -H "Upgrade: websocket" ...` against nginx directly first, then check any additional proxy hop in front of it. |
| A discovery/sync job stays `QUEUED` forever | `WORKERS_ENABLED=false` on every running replica, or the worker pool crashed silently | `GET /health/ready`'s `workers`/`queue` fields — `docs/DEPLOYMENT.md`'s Monitoring guide's `queue`-related alert thresholds apply here too. |
| 429s under normal-looking traffic | Edge (`nginx.conf`'s `limit_req_zone`, 20r/s) or app-level (`RATE_LIMIT_MAX`/`RATE_LIMIT_WINDOW_MS`) rate limit too tight for real traffic patterns | Both layers are independently tuned (see `DECISIONS.md`) — raise whichever one is actually tripping (check response headers/logs to tell which). |
| `docker build` fails on `pnpm install --frozen-lockfile` | `pnpm-lock.yaml` out of sync with a `package.json` change that wasn't committed alongside it | Run `pnpm install` locally, commit the updated lockfile. |
| Restored database, `Account` credentials fail to decrypt | `CREDENTIAL_ENCRYPTION_KEY` doesn't match the value active when the backup was taken | See "Backup guide"'s warning — there is no recovery path for a lost/mismatched key; affected accounts must be reconnected via OAuth. |
