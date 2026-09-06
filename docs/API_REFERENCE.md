# API Reference

Base URL: `http://localhost:3000` (dev). All routes except `/health*`, `/metrics`, `/auth/register`, `/auth/login`, `/auth/refresh`, `/auth/logout`, and `/oauth/:provider/callback` require `Authorization: Bearer <access token>`.

Every list endpoint accepts pagination query params `page` (int ≥1, default 1) and `limit` (int ≥1, max 100, default 20) via the shared `paginationQuerySchema`. Validation failures return `{status:'error', message:'Validation failed', errors:[{path,message}]}` (400) via the shared `formatValidationErrors` helper.

There is no shared error→status mapping helper — each route file defines its own local `mapXError`. See error tables below per domain.

**Production readiness (Phase 11, extended Phase 12)**: every response carries an `x-request-id` and `x-correlation-id` header (the latter echoes an inbound `x-correlation-id` request header if the caller supplied one, else it matches `x-request-id`; every 4xx/5xx JSON body also carries `x-request-id`'s value as a `requestId` field — see `plugins/observability.ts`); every request is rate-limited (`RATE_LIMIT_MAX` per `RATE_LIMIT_WINDOW_MS`, default 1000/60s, `/health*` and `/metrics` exempt — nginx adds a second, coarser edge-level limit in front of this in production, see `nginx/nginx.conf`); request bodies over `BODY_LIMIT_BYTES` (default 1MB) are rejected before parsing; `@fastify/helmet` sets standard security headers; `@fastify/cors` gates cross-origin access via `CORS_ORIGIN`; `@fastify/compress` gzip/brotli-compresses responses when `COMPRESSION_ENABLED=true` (default); `TRUSTED_PROXIES` controls Fastify's `trustProxy` (needed for `request.ip`/rate-limiting to see the real client IP behind nginx).

## Health (`src/routes/health.ts`) — no auth

| Method | Path | Notes |
|---|---|---|
| GET | `/health` | `{status:'ok'}` |
| GET | `/health/db` | 503 if DB unreachable |
| GET | `/health/redis` | 503 if Redis unreachable |
| GET | `/health/ready` | Checks DB + Redis in parallel — only these two gate the 503. Response: `{status, database, redis, ai:{provider, configured}, workers:{enabled, total, running, busy, status}, queue:{size, oldestQueuedAgeMs, status}, memory:{status, rssBytes, heapUsedBytes, heapTotalBytes, thresholdBytes}, disk:{status, freeBytes?, totalBytes?, thresholdBytes}}`. Every field beyond `database`/`redis` is informational only (Phase 11's `ai` field, extended at Phase 12 with `workers`/`queue`/`memory`/`disk`) — none of them can turn a 200 into a 503; see DECISIONS.md. |

## Metrics (`src/routes/metrics.ts`) — no auth, Phase 11

| Method | Path | Notes |
|---|---|---|
| GET | `/metrics` | Prometheus text-format exposition of `observability/metrics.ts`'s registry — HTTP/AI/job/WebSocket counters and histograms plus Node process defaults. 404 if `METRICS_ENABLED=false`. Excluded from rate limiting (`allowList` in `server.ts`) since it's polled continuously by infra, not a real API caller. |

## Auth (`src/routes/auth.ts`)

| Method | Path | Auth | Body/Query | Notes |
|---|---|---|---|---|
| POST | `/auth/register` | none | `{email, password (min8), firstName, lastName}` | 409 `EmailAlreadyExistsError` |
| POST | `/auth/login` | none | `{email, password}` | Issues access+refresh tokens. 401 `InvalidCredentialsError` |
| GET | `/auth/me` | required | — | Returns `request.user` |
| POST | `/auth/refresh` | none | `{refreshToken}` | Rotates refresh token, issues new access token. 401 `InvalidRefreshTokenError` (incl. `RefreshTokenReuseError`, which also revokes all of the user's refresh tokens) |
| POST | `/auth/logout` | none | `{refreshToken}` | Revokes the given refresh token |

## Categories (`src/routes/categories.ts`) — all authenticated

| Method | Path | Body/Query | Notes |
|---|---|---|---|
| GET | `/categories` | `page, limit, search?` | |
| POST | `/categories` | `{name, slug (^[a-z0-9]+(-[a-z0-9]+)*$), description?, icon?}` | 403 Forbidden (non-admin), 409 `CategoryAlreadyExistsError` |

## Tags (`src/routes/tags.ts`) — all authenticated

| Method | Path | Body/Query | Notes |
|---|---|---|---|
| GET | `/tags` | `page, limit, search?` | |
| POST | `/tags` | `{name, color?}` | 409 `TagAlreadyExistsError` |

## Assets (`src/routes/assets.ts`) — all authenticated, `mapAssetError`

| Domain error | HTTP |
|---|---|
| `ForbiddenError` | 403 |
| `AssetNotFoundError` / `CategoryNotFoundError` / `TagNotFoundError` | 404 |
| `InvalidRiskScoreError` | 400 |

| Method | Path | Body/Query | Notes |
|---|---|---|---|
| GET | `/assets` | pagination + `status?, categoryId?, tag?, minRiskScore?, maxRiskScore?, search?, sort? (name|createdAt|updatedAt|riskScore), order?` | |
| GET | `/assets/search` | same, `search` required | |
| GET | `/assets/:id` | — | |
| POST | `/assets` | `{categoryId, name, displayName?, description?, status?, visibility?, riskScore?}` | |
| PATCH | `/assets/:id` | all fields optional, ≥1 required | |
| DELETE | `/assets/:id` | — | Soft-archives (`status=ARCHIVED`), never a hard delete |
| GET | `/assets/:id/events` | pagination + `severity?, type?` | |
| POST | `/assets/:id/events` | `{type, severity?, title, description?, metadata?}` | |
| POST | `/assets/:id/tags` | `{tagId}` | Returns full tag list |
| DELETE | `/assets/:id/tags/:tagId` | — | Returns full tag list |

## Accounts (`src/routes/accounts.ts`) — all authenticated, `mapAccountError`

| Domain error | HTTP |
|---|---|
| `ForbiddenError` | 403 |
| `AccountNotFoundError` | 404 |
| `AccountAlreadyExistsError` | 409 |

| Method | Path | Body/Query | Notes |
|---|---|---|---|
| GET | `/accounts` | pagination + `assetId?, provider?, search?` | |
| POST | `/accounts/connect` | `{assetId, provider, credential?, displayName?, email?, username?, metadata?}` | |
| PATCH | `/accounts/:id` | `displayName?, email?, username?, credential?, metadata?`, ≥1 required | |
| POST | `/accounts/:id/sync` | — | **Async (Phase 4)**: enqueues a `SYNC` job. Returns **202** `{jobId, status, priority, queueDepth}` |
| POST | `/accounts/:id/discover` | — | **Async (Phase 4)**: enqueues a `DISCOVERY` job. Returns **202** `{jobId, status, priority, queueDepth}` |
| DELETE | `/accounts/:id` | — | Soft-disconnect, not a hard delete |

## OAuth (`src/routes/oauth.ts`) — `mapOAuthError`

| Domain error | HTTP |
|---|---|
| `ForbiddenError` | 403 |
| `AssetNotFoundError` | 404 |
| `DuplicateOAuthConnectionError` | 409 |
| `InvalidOAuthStateError` / `OAuthCodeExchangeError` / `OAuthProviderError` | 400 |
| `OAuthConfigurationError` | 500 |

| Method | Path | Auth | Query | Notes |
|---|---|---|---|---|
| GET | `/oauth/:provider` | required | `{assetId}` | 302 redirect to provider consent screen |
| GET | `/oauth/:provider/callback` | **none** | `{code, state}` | Security comes from the single-use, TTL'd state token (Redis, `OAUTH_STATE_TTL_SECONDS`), not a header the redirect can't carry. Returns `{status:'ok', account}` |

Supported providers: `github` (only, currently).

## Jobs (`src/routes/jobs.ts`) — all authenticated, `mapJobError`

| Domain error | HTTP |
|---|---|
| `ForbiddenError` | 403 |
| `JobNotFoundError` | 404 |
| `JobNotCancellableError` / `JobNotRetryableError` | 409 |

| Method | Path | Body/Query | Notes |
|---|---|---|---|
| GET | `/jobs` | pagination + `assetId?, accountId?, type?, status? (QUEUED\|RUNNING\|COMPLETED\|FAILED\|RETRYING\|CANCELLED\|DEAD)` | Non-admin requires `assetId` |
| GET | `/jobs/:id` | — | |
| POST | `/jobs/:id/cancel` | — | Only cancellable statuses |
| POST | `/jobs/:id/retry` | — | Only retryable (terminal-failure) statuses |

## Resources (`src/routes/resources.ts`) — all authenticated, `mapResourceError`

| Domain error | HTTP |
|---|---|
| `ForbiddenError` | 403 |
| `ResourceNotFoundError` / `AssetNotFoundError` | 404 |

| Method | Path | Body/Query | Notes |
|---|---|---|---|
| GET | `/resources` | pagination + `assetId?, accountId?, provider?, resourceType?, name?, metadataKey?, metadataValue?, relationshipType?, includeDeleted? (bool), sort? (displayName\|lastSeen\|firstSeen\|createdAt), order?` | Non-admin requires `assetId` |
| GET | `/resources/:id` | — | |
| GET | `/resources/:id/neighbors` | — | One hop, both directions |
| GET | `/resources/:id/children` | — | Directional, one hop |
| GET | `/resources/:id/parents` | — | Directional, one hop |
| GET | `/resources/:id/connected` | — | Bounded BFS, both directions, maxDepth=5 |
| GET | `/resources/:id/path/:targetId` | — | Returns `{pathExists: boolean}`, bounded BFS maxDepth=5 |

## Analysis (`src/routes/analysis.ts`) — all authenticated, `mapAnalysisError`

| Domain error | HTTP |
|---|---|
| `ForbiddenError` | 403 |
| `FindingNotFoundError` / `AssetNotFoundError` / `AccountNotFoundError` | 404 |

| Method | Path | Body/Query | Notes |
|---|---|---|---|
| GET | `/analysis/findings` | pagination + `assetId?, accountId?, resourceId?, provider?, ruleCode?, severity? (CRITICAL\|HIGH\|MEDIUM\|LOW\|INFORMATIONAL), status? (OPEN\|RESOLVED), search?, sort? (createdAt\|updatedAt\|severity), order?` | Non-admin requires `assetId` |
| GET | `/analysis/findings/:id` | — | Authorization resolved via the finding's `Resource.assetId` |
| GET | `/analysis/recommendations` | pagination + `assetId?, accountId?, findingId?, status? (OPEN\|RESOLVED\|DISMISSED), priority?, search?, sort? (createdAt\|updatedAt\|priority), order?` | Non-admin requires `assetId` |
| GET | `/analysis/risk` | `assetId?` | Non-admin requires `assetId` (returns that asset's ASSET-scope score); admin without `assetId` returns the platform-wide OVERALL-scope score |
| GET | `/analysis/risk/assets/:id` | — | ASSET-scope `RiskScore` for this asset |
| GET | `/analysis/risk/accounts/:id` | — | ACCOUNT-scope `RiskScore` for this account |

All risk endpoints return `{risk: RiskScore | null}` — `null` when no discovery has run for that scope yet.

## Policy & Compliance (`src/routes/policies.ts`) — all authenticated, `mapPolicyError`

| Domain error | HTTP |
|---|---|
| `ForbiddenError` | 403 |
| `PolicyNotFoundError` / `AssetNotFoundError` / `AccountNotFoundError` | 404 |

| Method | Path | Body/Query | Notes |
|---|---|---|---|
| GET | `/policies` | pagination + `provider?, enabled? (true\|false), severity?, search?` | No ownership scoping — policies are an organizational catalog, visible to any authenticated user, same as categories/tags |
| GET | `/policies/:id` | — | |
| GET | `/compliance` | `assetId?, provider?` | `assetId` set → ASSET-scope report (ownership-checked); else `provider` set → PROVIDER-scope report (admin-only); else admin-only OVERALL-scope report; non-admin with neither → 403 |
| GET | `/compliance/assets/:id` | — | ASSET-scope `ComplianceReport` |
| GET | `/compliance/accounts/:id` | — | ACCOUNT-scope `ComplianceReport` |

`ComplianceReport` shape: `{scope, passCount, failCount, warningCount, notApplicableCount, complianceScore, policyFailures: [{policyCode, policyName, resourceId, reason}], policyPasses: [...], severityDistribution: {critical, high, medium, low, informational}, riskDistribution: {low, medium, high, critical}}`. Computed at query time from current `PolicyResult`/`Finding`/`RiskScore` rows — no persisted snapshot, unlike `RiskScore` itself.

## Agents (`src/routes/agents.ts`) — all authenticated, `mapAgentError`

| Domain error | HTTP |
|---|---|
| `ForbiddenError` | 403 |
| `AssetNotFoundError` / `PlanExecutionNotFoundError` | 404 |
| `UnsupportedRequestTypeError` (no registered agent for the given `requestType`) | 400 |

| Method | Path | Body/Query | Notes |
|---|---|---|---|
| POST | `/agents/execute` | `{requestType, assetId, aiMode?}` | Runs Planner → Task Graph → Agents → Result Aggregator synchronously (not job-queued) and returns the merged result. `requestType` is one of `DISCOVERY_SUMMARY`, `RISK_SUMMARY`, `COMPLIANCE_SUMMARY`, `RECOMMENDATIONS`, `SECURITY_REPORT`. Ownership-checked via `assetId`. `aiMode` (Phase 7D) is one of `OFF` (default) / `SUMMARY` / `FULL_REPORT` — only `ReportAgent` (only relevant when `requestType` is `SECURITY_REPORT`) reads it; every other agent ignores it. |
| GET | `/agents` | — | Registry introspection: `{items: [{id, supportedRequestTypes}]}` for every registered agent. No ownership scoping — a shared catalog, like `GET /policies`. |
| GET | `/agents/plans/:id` | — | The persisted `AgentPlanExecution` audit row for a past `POST /agents/execute` call. Ownership-checked via the execution's own `assetId`. |

`POST /agents/execute` response shape (`AggregatedPlanResult`): `{planId, requestType, assetId, status (SUCCESS\|PARTIAL\|FAILED), durationMs, tasks: [{taskId, agentId, status (SUCCESS\|FAILED\|SKIPPED), startedAt, durationMs, attempts, error?}], data: {<agentId>: <agent's own output>, ...}}`. `data.report` (only present for `SECURITY_REPORT`) has `{executive, technical, asset}` sections, plus an additive `aiReport` (Phase 7D) whenever `aiMode` was `SUMMARY` or `FULL_REPORT`: `{aiStatus (SUCCESS\|FAILED), mode, executiveSummary?, riskNarrative?, recommendationSummary?, keyObservations?: string[], limitations?: string[], metadata?: {provider, model, latencyMs, promptTokens, completionTokens, totalTokens, estimatedCostUsd, generatedAt}, error?}`. `SUMMARY` mode only ever populates `executiveSummary`; `FULL_REPORT` populates all five narrative fields. On AI failure the structured report is unaffected, `aiStatus` is `FAILED` with `error` set, and the request still returns 200 — AI failure never fails `POST /agents/execute`.

## AI (`src/routes/ai.ts`) — all authenticated, `mapAIError`

| Domain error | HTTP |
|---|---|
| `ForbiddenError` | 403 |
| `AssetNotFoundError` | 404 |
| `UnsupportedAIProviderError` / `UnsupportedAIModelError` | 400 |
| `AIProviderRequestError` (the upstream vendor rejected the request — bad key, malformed payload) | 502 |

| Method | Path | Body/Query | Notes |
|---|---|---|---|
| POST | `/ai/generate` | `{provider?, model?, systemPrompt?, prompt, maxTokens?, temperature?, assetId?, focus?}` | Runs `AIService.generate()` synchronously (not job-queued). Provider resolution: explicit `provider` wins; else explicit `model` is routed to whichever registered provider `supports()` it; else falls back to the `AI_PROVIDER` config default and that provider's first model. `assetId` is optional — when given, ownership-checked, a `KnowledgeContext` is auto-built (Phase 7C) and handed to `PromptBuilder`, and events are emitted; when omitted, this is a standalone call with no automatic context and no events. `focus` is passed straight through to the `KnowledgeContext` build when `assetId` is given. |
| GET | `/ai/providers` | — | Registry introspection: `{items: [{id, models}]}` for every registered provider. No ownership scoping — a shared catalog, like `GET /agents`/`GET /policies`. |
| GET | `/ai/models` | — | Flattened `{items: [{provider, model}]}` across every registered provider's `models()`. |

`POST /ai/generate` response shape (`AIResponse`): `{provider, model, text, reasoning?, usage: {promptTokens, completionTokens, totalTokens}, finishReason, citations?, estimatedCostUsd, latencyMs}`. Every call (success or failure) is also persisted as one write-once `AIRequestLog` row — not itself exposed via any GET route yet.

## Orchestrator (`src/routes/orchestrator.ts`) — all authenticated (Phase 17)

| Domain error | HTTP |
|---|---|
| `PlanningError` | 400 |
| `AgentNotRegisteredError` | 409 |
| `WorkflowError` | 404 |

| Method | Path | Body/Query | Notes |
|---|---|---|---|
| POST | `/ai/orchestrator/execute` | `{intent, conversationId?, connectedAccounts?, assets?, metadata?}` | Runs `Planner.createPlan()` → `WorkflowEngine` (dependency-wave execution against `orchestratorAgentRegistry`) → aggregated `ExecutionResult`, synchronously (not job-queued). `intent` is either a known workflow id (`full-security-analysis`, `risk-only`, `compliance-only`) or free text matched via keyword regex. |
| GET | `/ai/orchestrator/workflows` | — | Registry introspection: `{items: [{id, name, description, steps}]}` for every registered `WorkflowDefinition`. No ownership scoping — a shared catalog, like `GET /agents`. |
| GET | `/ai/orchestrator/workflows/:id` | — | One workflow's full definition plus `visualization: {nodes, edges}` (a DAG a frontend can render directly). |
| GET | `/ai/orchestrator/history` | `limit?` (max 200) | Recent `ExecutionResult` summaries across all executions, most recent first. |
| GET | `/ai/orchestrator/status` | `executionId?` | With `executionId`: that run's live `WorkflowExecutionState` (or 404). Without it: `{status:'ok', registeredWorkflows, registeredAgents}`. |

`ExecutionResult` shape: `{executionId, workflowId, status (COMPLETED\|PARTIAL\|FAILED\|CANCELLED\|TIMED_OUT), startedAt, finishedAt, durationMs, steps: [{stepId, agentId, status (SUCCESS\|FAILED\|SKIPPED\|CANCELLED\|TIMED_OUT), startedAt, finishedAt, durationMs, attempts, output?, error?}], data: {<agentId>: <that step's output>, ...}, error?}`. A step whose `agentId` has no registered agent fails only that step (`error: 'no agent registered for "<agentId>"'`) — it never throws or 500s the whole request.

## Discovery Agent (`src/routes/discovery.ts`) — all authenticated (Phase 18)

| Domain error | HTTP |
|---|---|
| `ForbiddenError` | 403 |
| `AccountNotFoundError` | 404 |

| Method | Path | Body/Query | Notes |
|---|---|---|---|
| POST | `/ai/discovery/start` | `{accountId, message?}` | **Async**, same enqueue contract as `POST /accounts/:id/discover`: enqueues an `AI_DISCOVERY` job (dispatched to `DiscoveryAgent`, see `services/jobs/job-dispatcher.ts`). Returns **202** `{jobId, status, priority, queueDepth}`. `message` (optional free text, e.g. "Discover all GitHub repositories") is classified via `classifyDiscoveryIntent()` purely for logging — it never changes what the agent does. |
| POST | `/ai/discovery/refresh` | `{accountId, message?}` | Identical flow to `start`, with a `refresh: true` payload flag carried through for wording/telemetry only — `DiscoveryService.discover()` already handles a repeat run identically (upsert + soft-delete diff) either way. |
| GET | `/ai/discovery/history` | `accountId` (required), `limit?` (max 200) | Ownership-checked. Reads `DiscoveryMemory` (Redis-backed) — a lightweight summary per past run, most recent first. |
| GET | `/ai/discovery/status` | `accountId?` or `jobId?` (one required) | With `jobId`: delegates to `GET /jobs/:id`. With `accountId`: the account's last recorded `DiscoverySummaryRecord` from `DiscoveryMemory`, or `{status:'UNKNOWN'}` if none yet. |
| GET | `/ai/discovery/providers` | — | Registry introspection over `provider.registry.ts`'s `DiscoveryToolProviderRegistry`: `{items: [{provider, implemented, tools, description}]}`. `github` is `implemented: true`; `gitlab`/`bitbucket`/`aws`/`azure`/`gcp`/`docker-hub`/`kubernetes` are listed with `implemented: false, tools: []`. No ownership scoping — a shared catalog. |

Job `result` shape once an `AI_DISCOVERY` job settles (`GET /jobs/:id`): `{status (SUCCESS\|PARTIAL\|FAILED), provider, accountId, resourceCount, resources, repositories, organizations, languages: [{language, repositoryCount}], topics: [{topic, repositoryCount}], relationships: {created, updated, unchanged}, metadata: {startedAt, finishedAt, durationMs, refresh}, summary, confidenceScore, warnings, errors}`. An account whose provider has no implemented Discovery Agent tool set (only `github` is implemented) fails the job immediately and permanently (`SyncJob.status: 'FAILED'`, not retried) rather than looping through the retry schedule — same treatment `POST /accounts/:id/discover` already gives an unregistered `discoveryProviderRegistry` provider.

## Risk Agent (`src/routes/risk-agent.ts`) — all authenticated (Phase 19)

| Domain error | HTTP |
|---|---|
| `ForbiddenError` | 403 |
| `AssetNotFoundError` | 404 |

| Method | Path | Body/Query | Notes |
|---|---|---|---|
| POST | `/ai/risk/analyze` | `{assetId, message?}` | **Async**: enqueues an `AI_RISK` job (dispatched to `RiskAgent`, see `services/jobs/job-dispatcher.ts`), scoped to `assetId` (not `accountId` — risk is asset-scoped). Returns **202** `{jobId, status, priority, queueDepth}`. `message` is accepted but not currently classified into a control-flow branch. |
| GET | `/ai/risk/history` | `assetId` (required), `limit?` (max 200) | Ownership-checked. Reads `RiskMemory` (Redis-backed) — a lightweight summary per past run, most recent first. |
| GET | `/ai/risk/findings` | `assetId` (required), `severity?`, `page?`, `limit?` (max 200) | Ownership-checked (via `findingService.list()`). Same underlying `Finding` rows as `GET /analysis/findings`, but each is shaped through `risk.finding.ts` into a `RiskFindingView` (adds `reasoning`, `evidence`, `priority`, `businessImpact`, `repeated`) rather than the raw row. |
| GET | `/ai/risk/summary` | `assetId` (required) | Ownership-checked. The asset's last recorded `RiskSummaryRecord` from `RiskMemory`, or `{status:'UNKNOWN'}` if none yet. |

Job `result` shape once an `AI_RISK` job settles (`GET /jobs/:id`): `{status (SUCCESS\|PARTIAL\|FAILED), assetId, overallScore, businessImpact, counts: {critical, high, medium, low, informational}, findings, criticalFindings, highFindings, mediumFindings, lowFindings, metadata: {startedAt, finishedAt, durationMs}, summary, confidenceScore, warnings, errors}`. `overallScore`/`counts` are always read verbatim from the existing `RiskScore` row (never recomputed by this agent); `businessImpact` is a deterministic worst-severity-wins label derived from `counts`. A job with no resolvable `assetId` fails immediately and permanently (`SyncJob.status: 'FAILED'`, not retried).

## Compliance Agent (`src/routes/compliance-agent.ts`) — all authenticated (Phase 20)

| Domain error | HTTP |
|---|---|
| `ForbiddenError` | 403 |
| `AssetNotFoundError` | 404 |

| Method | Path | Body/Query | Notes |
|---|---|---|---|
| POST | `/ai/compliance/analyze` | `{assetId, message?}` | **Async**: enqueues an `AI_COMPLIANCE` job (dispatched to `ComplianceAgent`, see `services/jobs/job-dispatcher.ts`), scoped to `assetId`. Returns **202** `{jobId, status, priority, queueDepth}`. `message` is accepted but not currently classified into a control-flow branch. |
| GET | `/ai/compliance/history` | `assetId` (required), `limit?` (max 200) | Ownership-checked. Reads `ComplianceMemory` (Redis-backed) — a lightweight summary per past run, most recent first. |
| GET | `/ai/compliance/summary` | `assetId` (required) | Ownership-checked. The asset's last recorded `ComplianceSummaryRecord` from `ComplianceMemory`, or `{status:'UNKNOWN'}` if none yet. |
| GET | `/ai/compliance/frameworks` | — | Registry introspection over `compliance.mapping.ts`'s `listFrameworks()`: `{items: [{framework, name, controlCount, mappedPolicyCodes}]}`. Every listed framework (`NIST_CSF`, `CIS_CONTROLS`, `ISO_27001`, `SOC2`) is fully implemented in this phase — no ownership scoping, a shared catalog like `GET /ai/discovery/providers`. |

Job `result` shape once an `AI_COMPLIANCE` job settles (`GET /jobs/:id`): `{status (SUCCESS\|PARTIAL\|FAILED), assetId, complianceScore, passCount, failCount, warningCount, notApplicableCount, policyFailures, policyPasses, frameworks: [{framework, name, passedControls, failedControls, missingControls, coveragePercent}], metadata: {startedAt, finishedAt, durationMs}, summary, confidenceScore, warnings, errors}`. `complianceScore`/`passCount`/`failCount`/`warningCount`/`notApplicableCount`/`policyFailures`/`policyPasses` are always read verbatim from the existing `ComplianceReport` (never recomputed by this agent). Each framework's `coveragePercent` is a distinct data-coverage ratio (how much of that framework's control catalog has any policy mapped to it) — not a second compliance score. A job with no resolvable `assetId` fails immediately and permanently (`SyncJob.status: 'FAILED'`, not retried).

## Recommendation Agent (`src/routes/recommendation-agent.ts`) — all authenticated (Phase 21)

| Domain error | HTTP |
|---|---|
| `ForbiddenError` | 403 |
| `AssetNotFoundError` | 404 |

| Method | Path | Body/Query | Notes |
|---|---|---|---|
| POST | `/ai/recommendation/analyze` | `{assetId, message?}` | **Async**: enqueues an `AI_RECOMMENDATION` job (dispatched to `RecommendationAgent`), scoped to `assetId`. Returns **202** `{jobId, status, priority, queueDepth}`. Called this way (no live `OrchestrationContext`), the agent falls back to a direct `FindingService` read for Risk data; Compliance cross-references are unavailable on this path (no live Compliance step to hand off from). |
| GET | `/ai/recommendation/history` | `assetId` (required), `limit?` (max 200) | Ownership-checked. Reads `RecommendationMemory` (Redis-backed) — a lightweight summary per past run, most recent first. |
| GET | `/ai/recommendation/summary` | `assetId` (required) | Ownership-checked. The asset's last recorded `RecommendationSummaryRecord` from `RecommendationMemory`, or `{status:'UNKNOWN'}` if none yet. |

Job `result` shape once an `AI_RECOMMENDATION` job settles (`GET /jobs/:id`): `{status (SUCCESS\|PARTIAL\|FAILED), assetId, recommendations: [{id, findingId, title, description, estimatedImpact, priority, status, sourceAgents, sourceFindingIds, relatedCompliancePolicyCodes, confidence, reasoning, createdAt}], prioritized (same items, priority-sorted), handoffSources: [{agentId, used, origin: 'context'\|'fallback'\|'unavailable'}], metadata: {startedAt, finishedAt, durationMs}, summary, confidenceScore, warnings, errors}`. Every `recommendations` entry is backed by an existing, persisted `Recommendation` row (`services/analysis/recommendation.service.ts`) — this agent never generates one itself. `handoffSources` tells you whether Risk/Compliance data came from a live workflow handoff, a standalone fallback read, or wasn't available. A job with no resolvable `assetId` fails immediately and permanently.

## Report Agent (`src/routes/report-agent.ts`) — all authenticated (Phase 21)

| Domain error | HTTP |
|---|---|
| `ForbiddenError` | 403 |
| `AssetNotFoundError` | 404 |

| Method | Path | Body/Query | Notes |
|---|---|---|---|
| POST | `/ai/report/generate` | `{assetId, message?}` | **Async**: enqueues an `AI_REPORT` job (dispatched to `ReportAgent`), scoped to `assetId`. Returns **202** `{jobId, status, priority, queueDepth}`. Called this way (no live `OrchestrationContext`), sections fall back to each upstream agent's own memory (Discovery has no such fallback — its memory is keyed by `accountId`, not `assetId` — so a standalone report always shows Discovery as `MISSING`). |
| GET | `/ai/report/history` | `assetId` (required), `limit?` (max 200) | Ownership-checked. Reads `ReportMemory` (Redis-backed) — a lightweight summary per past run, most recent first. |
| GET | `/ai/report/summary` | `assetId` (required) | Ownership-checked. The asset's last recorded `ReportSummaryRecord` from `ReportMemory`, or `{status:'UNKNOWN'}` if none yet. |

Job `result` shape once an `AI_REPORT` job settles (`GET /jobs/:id`): `{status (SUCCESS\|PARTIAL\|FAILED), assetId, summary, sections: [{id, title, status: 'INCLUDED'\|'MISSING'\|'FAILED', origin: 'context'\|'memory'\|'unavailable', content, confidence?}], executive: {overallRiskScore, complianceScore, openFindingsCount, recommendationCount, topRecommendations: [{title, priority}]}, metadata: {startedAt, finishedAt, durationMs}, confidenceScore, warnings, errors}`. `status` is `PARTIAL` whenever at least one but not all four sections are `INCLUDED`, `FAILED` only if none are. Every `executive` field is copied verbatim off whichever upstream agent outputs were actually available — never recomputed by this agent. A job with no resolvable `assetId` fails immediately and permanently.

## Knowledge (`src/routes/knowledge.ts`) — all authenticated, `mapKnowledgeError`

| Domain error | HTTP |
|---|---|
| `ForbiddenError` | 403 |
| `AssetNotFoundError` | 404 |

| Method | Path | Body/Query | Notes |
|---|---|---|---|
| POST | `/knowledge/context` | `{assetId, accountId?, focus?}` | Runs `ContextBuilder.build()` synchronously: resolves every registered retriever, executes them in parallel, merges/dedupes/collapses-repeated-entities/sorts-by-relevance/trims to a token budget. Ownership-checked via `assetId` (required — unlike `/ai/generate`, this endpoint is always asset-scoped). |
| GET | `/knowledge/retrievers` | — | Registry introspection: `{items: [{id}]}` for every registered retriever. No ownership scoping — a shared catalog, like `GET /agents`/`GET /ai/providers`. |

`POST /knowledge/context` response shape (`KnowledgeContext`): `{assetId, resources, relationships, findings, policies, recommendations, risk, metadata}`. Each of the first 6 fields is a `RetrievedItem[]`: `{type, entityKey, groupKey?, summary, relevance, raw?}`. `metadata`: `{generatedAt, retrieversRun, totalItemsRetrieved, totalItemsAfterDedup, totalItemsAfterTrim, estimatedTokens, truncated}`.

## Copilot (`src/routes/copilot.ts`) — all authenticated, `mapCopilotError`

| Domain error | HTTP |
|---|---|
| `ForbiddenError` | 403 |
| `AssetNotFoundError` | 404 |

| Method | Path | Body/Query | Notes |
|---|---|---|---|
| POST | `/copilot/chat` | `{assetId, message}` | Ownership-checked via `assetId` (always asset-scoped), then runs `CopilotService.chat()`: calls `AIService.generate({assetId, systemPrompt: <copilot persona>, prompt: message, focus: 'COPILOT_CHAT'})` — the same chokepoint `POST /ai/generate` and `ReportAgent` (Phase 7D) use, which auto-grounds itself via `ContextBuilder`/`KnowledgeService` since `assetId` is set. `CopilotService` never calls `ContextBuilder`/`KnowledgeService`/`PromptBuilder`/a provider directly. |

`POST /copilot/chat` response shape (`CopilotChatResult`): `{status (SUCCESS\|FAILED), answer?, citations?: string[], metadata?: {provider, model, promptTokens, completionTokens, totalTokens, estimatedCostUsd, latencyMs, generatedAt}, error?}`. `citations` is only ever populated if the resolved provider's response includes any (Claude currently never does — see `ClaudeProvider`). On AI failure, `status` is `FAILED` with `error` set and no `answer`/`citations`/`metadata` — the request itself still returns 200; AI failure never fails `POST /copilot/chat`.

## WebSocket (`src/services/websocket/websocket-gateway.ts`) — Phase 10

Not a REST route — no existing REST endpoint was changed to add this. A single `GET /ws` upgrade endpoint, authenticated by query param (a browser `WebSocket` can't set an `Authorization` header): `ws://<host>/ws?token=<access token>`.

| Server behavior | When |
|---|---|
| Sends `{type:'error', message}` then closes with code `4401` | Missing/invalid/expired token |
| Sends `{type:'connected'}` | Token valid |
| Sends `{type:'subscribed', assetId}` | Client sent `{type:'subscribe', assetId}` and owns (or is `ADMIN` for) that asset |
| Sends `{type:'error', message}` (connection stays open) | `subscribe` for an asset the caller doesn't own, or any malformed client message |
| Sends `{type:'unsubscribed', assetId}` | Client sent `{type:'unsubscribe', assetId}` |
| Sends `{type:'event', assetId, event}` | Any `AssetEvent` created for an asset this connection is currently subscribed to — `event` is the exact same shape `GET /assets/:id/events` returns |

A connection may be subscribed to any number of assets at once (send one `subscribe` message per asset); there is no "subscribe to everything I own" message. Closing the connection (client- or network-initiated) implicitly unsubscribes from everything — reconnecting requires re-sending `subscribe` for each asset, since the server keeps no session state across connections. Since literally every event type in the system (`JOB_*`, `PLAN_*`/`AGENT_*`, `RESOURCE_*`/`RELATIONSHIP_*`/`GRAPH_UPDATED`, `FINDING_*`/`RECOMMENDATION_*`/`RISK_UPDATED`, `POLICY_*`/`COMPLIANCE_UPDATED`, `AI_REQUEST_*`/`AI_REPORT_*`, `COPILOT_CHAT_*`, `CONTEXT_BUILD_*`/`RETRIEVAL_COMPLETED`/`TOKEN_USAGE_RECORDED`) already flows through `EventService.createForAsset()`, subscribing to an asset delivers all of them live — there's no separate "job updates" vs. "agent progress" channel to pick between.

## Not yet implemented as routes
- No `/discover` or `/sync` standalone routes outside the per-account async endpoints above.
- No manual relationship-creation route (all edges are discovery-derived).
- No manual finding/recommendation-creation route (all findings are rule-derived from discovery).
- No manual policy-creation route, and no PATCH route to toggle `Policy.enabled` — only direct repository access (exercised in `verify-policy.ts`, not HTTP).
- No memory, RAG, vector-search, semantic-search, or natural-language-query endpoints (deferred to Phase 7B, again at Phase 7C, 7D, and 8).
- `ReportAgent` and `CopilotService` are the only two callers of `AIService`/`ContextBuilder`'s auto-grounding chain (Phases 7D/8) — `RiskAgent`/`ComplianceAgent`/`RecommendationAgent` (the `services/agents/` versions) still never call AI. The new `src/ai/orchestrator/` Discovery/Risk Agents (Phases 18/19) are a separate system and do call `aiFoundation.llmClient` for their best-effort summaries, gracefully degrading to deterministic text if no provider is configured.
- No Copilot Agent exists yet in `src/ai/orchestrator/agents/` — Discovery, Risk, Compliance, Recommendation, and Report are all implemented as of Phase 21, and `full-security-analysis` now completes end-to-end; only a workflow step invoking a Copilot Agent (none is seeded) would still fail with `AgentNotRegisteredError`. The pre-existing `POST /copilot/chat` (Phase 8) is unrelated and unaffected.
- No admin endpoint to edit `recommendation.aggregate.ts`'s cross-referencing rules or `compliance.mapping.ts`'s policy-to-control mapping at runtime — both are static, code-owned data.
- No route to acknowledge a finding (distinct from resolving it) — `RiskMemory.acknowledgeFinding()`/`getAcknowledgedFindingIds()` exist as agent-side memory (Phase 19), but nothing in `routes/risk-agent.ts` exposes it over HTTP yet.
- No route to extend framework/control coverage — `compliance.mapping.ts`'s policy-to-control mapping (Phase 20) is a static, code-owned table; there is no admin endpoint to add or edit a mapping entry at runtime.
- No route to cancel an in-flight `POST /ai/orchestrator/execute` call — `OrchestratorService.cancel()` exists and `WorkflowEngine` honors an `AbortSignal`, but nothing in `routes/orchestrator.ts` exposes it over HTTP yet.
- No conversation/session persistence for the copilot — every `POST /copilot/chat` call is stateless and independent; there is no multi-turn thread, only a single message in, single answer out.
- No streaming endpoint (`POST /ai/generate/stream` or similar) — every provider implements `stream()`, but no route calls it.
- No `GET /ai/requests` (or similar) list/search endpoint over `AIRequestLog`.
- No `GET /knowledge/context` (cached) or any way to retrieve a past `KnowledgeContext` — every `POST /knowledge/context` rebuilds fresh, unlike `GET /agents/plans/:id`'s persisted audit trail.
- No `GET /agents/plans` list/search endpoint (only lookup by a known id) and no way to cancel an in-flight `POST /agents/execute` call from outside the process.
- No webhook receiver endpoints.
- No resource-scoped risk or compliance endpoint (`RiskScore` rows at RESOURCE scope are computed and stored, and `PolicyResult` rows are per-resource, but neither is exposed via its own route yet).
- No streamed AI tokens over the WebSocket (Phase 10 explicitly excluded it) — `AI_REPORT_*`/`COPILOT_CHAT_*` events report status transitions (started/completed/failed), never partial generated text.
- No `GET /ws/connections` (or similar) introspection endpoint over active WebSocket connections — `connection-registry.ts`'s state is in-memory and process-local only, not exposed anywhere.
