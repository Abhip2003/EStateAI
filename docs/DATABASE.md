# Database

PostgreSQL via Prisma (`prisma/schema.prisma`, client generated to `src/generated/prisma`). This document mirrors the schema — if they ever disagree, the schema file is authoritative and this doc is stale and must be fixed.

## Enums

| Enum | Values | Notes |
|---|---|---|
| `UserRole` | `USER`, `ADMIN` | |
| `AssetStatus` | `ACTIVE`, `WARNING`, `INACTIVE`, `ARCHIVED` | `DELETE /assets/:id` sets `ARCHIVED`, never a hard delete |
| `Visibility` | `PRIVATE`, `SHARED`, `PUBLIC` | |
| `Severity` | `INFO`, `WARNING`, `ERROR`, `CRITICAL` | Used by `AssetEvent` |
| `JobStatus` | `QUEUED`, `RUNNING`, `COMPLETED`, `FAILED`, `RETRYING`, `CANCELLED`, `DEAD` | |
| `JobPriority` | `LOW`, `NORMAL`, `HIGH`, `CRITICAL` | Declared ascending deliberately — Postgres enums compare by declaration order, so `ORDER BY priority DESC` sorts CRITICAL first |
| `FindingSeverity` | `CRITICAL`, `HIGH`, `MEDIUM`, `LOW`, `INFORMATIONAL` | Shared by `Finding.severity` and `Recommendation.priority` |
| `FindingStatus` | `OPEN`, `RESOLVED` | |
| `RecommendationStatus` | `OPEN`, `RESOLVED`, `DISMISSED` | |
| `RiskScope` | `RESOURCE`, `ACCOUNT`, `ASSET`, `OVERALL` | Which entity a `RiskScore` row describes |
| `PolicyResultStatus` | `PASS`, `FAIL`, `WARNING`, `NOT_APPLICABLE` | FAIL is a real violation; WARNING is permitted-but-flagged; NOT_APPLICABLE means the policy has nothing to say about this resource |
| `AgentPlanStatus` | `RUNNING`, `COMPLETED`, `FAILED` | Lifecycle of one `AgentPlanExecution` audit row |
| `AIRequestStatus` | `SUCCESS`, `FAILED` | Outcome of one `AIRequestLog` row — write-once, no in-between state like `AgentPlanStatus.RUNNING` |

## Models

### `User`
`id, email (unique), passwordHash, firstName, lastName, avatarUrl?, emailVerified (default false), role (default USER), createdAt, updatedAt`
Relations: `refreshTokens RefreshToken[]`, `assets Asset[]`

### `RefreshToken`
`id, userId, tokenHash (unique), expiresAt, createdAt, revokedAt?`
Relation: `user` (onDelete Cascade). Index: `[userId]`.

### `AssetCategory`
Reference/taxonomy table, not user-owned. `id, name (unique), slug (unique), description?, icon?, createdAt, updatedAt`
Relation: `assets Asset[]`. Assets reference categories with `onDelete: Restrict` — a category can't be deleted while any asset references it.

### `Asset`
`id, userId, categoryId, name, displayName?, description?, riskScore (Int, default 0), status (default ACTIVE), visibility (default PRIVATE), createdAt, updatedAt`
Relations: `user` (Cascade), `category` (Restrict), `accounts Account[]`, `assetTags AssetTag[]`, `events AssetEvent[]`
Indexes: `[userId]`, `[categoryId]`, `[status]`
Note: `riskScore`'s 0–100 range is enforced at the service/Zod layer, not a DB `CHECK` constraint.

### `Account`
One connected external account under an asset. `id, assetId, provider (free-form string), externalId, displayName?, email?, username?, connectedAt, lastSyncedAt?, connectionStatus (String, default "connected", free-form), metadata (Json?), credentialCiphertext? (AES-256-GCM, base64 IV+ciphertext+tag)`
Relation: `asset` (Cascade)
`@@unique([provider, externalId])`, `@@index([assetId])`

### `Tag`
`id, name (unique), color?`
Relation: `assetTags AssetTag[]`

### `AssetTag`
Many-to-many join. Composite PK `@@id([assetId, tagId])`. `assetId, tagId, createdAt`
Relations to `Asset`/`Tag` both Cascade.

### `AssetEvent`
Append-only timeline. `id, assetId, type (free-form string), severity (default INFO), title, description?, metadata (Json?), createdAt`
Relation: `asset` (Cascade)
Indexes: `[assetId]`, `[assetId, createdAt]`

### `SyncJob`
Generic async job envelope (sync, discovery, and any future job type). `id, type (free-form), provider?, accountId? (soft ref, no FK), assetId? (soft ref, no FK), status (default QUEUED), priority (default NORMAL), payload (Json?), result (Json?), error?, attempts (default 0), maxAttempts (default 5), workerId?, createdAt, startedAt?, finishedAt?, nextRetryAt?, heartbeatAt?`
Indexes: `[status]`, `[priority]`, `[nextRetryAt]`, `[workerId]`, `[status, priority, createdAt]` (the hot-path "claim next eligible job" query)
`accountId`/`assetId` are soft references deliberately: not every job type has one, and deleting an asset/account must never orphan or block a job row.

### `Resource`
Discovered resource, permanent entity. Identity is `(provider, providerResourceId)`, **global**, not scoped to a specific account/asset — rediscovery by a different account upserts the same row and shifts its `accountId`/`assetId` to whoever discovered it most recently.
`id, provider, providerResourceId, accountId, assetId, resourceType, displayName, description?, externalUrl?, metadata (Json?), hash (content hash for change detection), firstSeen, lastSeen, deletedAt?, createdAt, updatedAt`
`@@unique([provider, providerResourceId])`, indexes `[provider]`, `[resourceType]`, `[assetId]`. No FK relations (soft references, same rationale as `SyncJob`).

### `Relationship`
Directed edge between two `Resource` rows. `id, fromResourceId, toResourceId, relationshipType (free-form string), provider, metadata (Json?), createdAt`
`@@unique([fromResourceId, toResourceId, relationshipType])` — additive design decision (not explicitly spec'd) to prevent duplicate edges on rediscovery.
Indexes: `[fromResourceId]`, `[toResourceId]`, `[relationshipType]`. No FK relations.
New relationship types require zero schema changes — only registering a new extractor in `src/services/graph/relationship-extractors.ts`.

### `Finding`
One row per `(resourceId, ruleCode)` — the unique constraint is what makes re-evaluation idempotent. `id, resourceId (soft ref, no FK), provider, ruleCode, severity, status (default OPEN), title, description, confidence (Int, default 100), metadata (Json?), resolvedAt?, createdAt, updatedAt`
`@@unique([resourceId, ruleCode])`, indexes `[resourceId]`, `[status]`, `[severity]`, `[provider]`. No FK relations (soft reference, same rationale as `Resource`/`Relationship`).
`confidence` is always 100 for today's deterministic rules — the field exists ahead of any future probabilistic rule/AI finding needing it.

### `Recommendation`
Exactly one row per `Finding` (`@@unique(findingId)`) — "every Finding generates one Recommendation" per the Phase 6A spec. `id, findingId (soft ref, no FK, unique), priority (FindingSeverity), title, description, estimatedImpact?, status (default OPEN), metadata (Json?), createdAt, updatedAt`
Indexes: `[status]`, `[priority]`. `priority` reuses `FindingSeverity` rather than a near-duplicate enum, since it's always derived 1:1 from the finding's own severity.

### `RiskScore`
An aggregated risk snapshot at one of four scopes (see `RiskScope`). `id, scope, assetId?, accountId?, provider?, resourceId?, overallScore (Int), criticalCount (default 0), highCount (default 0), mediumCount (default 0), lowCount (default 0), informationalCount (default 0), metadata (Json?), createdAt, updatedAt`
Indexes: `[scope]`, `[assetId]`, `[accountId]`, `[resourceId]`. Only the field matching the scope is populated (e.g. `scope=ACCOUNT` only sets `accountId`); `OVERALL` rows have none set.
No DB unique constraint enforces "one row per scope+entity" — Postgres unique constraints treat `NULL`s as distinct from each other, which would let duplicate `OVERALL`/`ACCOUNT`/`ASSET` rows slip through since most columns are null for any given scope. `RiskService`/`RiskScoreRepository` enforce one-row-per-scope+entity at the application layer instead (find existing row for that scope, update in place, else create).

### `Policy`
The persisted, configurable record of a code-registered `Policy` (see `policy-registry.ts`). `id, code (unique), name, description, enabled (default true), provider, resourceType, severity (FindingSeverity), conditions (Json?), createdAt, updatedAt`
Indexes: `[provider]`, `[enabled]`. `name`/`description`/`provider`/`resourceType`/`severity`/`conditions` are synced from the registered `Policy`'s metadata on every evaluation run (`PolicyService.ensureRegisteredPoliciesPersisted`); `enabled` is deliberately never overwritten by that sync — it's the one field an operator can change that evaluation actually respects.

### `PolicyResult`
One row per `(policyId, resourceId)` — the latest evaluation, not a history log. `id, policyId (soft ref, no FK), resourceId (soft ref, no FK), findingId? (soft ref, no FK), status (PolicyResultStatus), reason, metadata (Json?), evaluatedAt, createdAt, updatedAt`
`@@unique([policyId, resourceId])`, indexes `[resourceId]`, `[policyId]`, `[status]`. Re-evaluation upserts in place, same idempotency shape as `Finding`'s `(resourceId, ruleCode)` uniqueness. `findingId` is set when a FAIL/WARNING was driven by a specific `Finding`; null for policies that pass vacuously or inspect the resource directly (e.g. fork exclusion).

### `AgentPlanExecution`
One audit row per `POST /agents/execute` call — not a queue (unlike `SyncJob`), not a recomputed-on-read view (unlike `ComplianceReport`). `id, requestType, assetId, status (AgentPlanStatus), summary (Json?), error?, startedAt (default now), completedAt?, durationMs?, createdAt, updatedAt`
Indexes: `[assetId]`, `[requestType]`, `[status]`. Written twice: once at plan start (`status=RUNNING`, no `summary`), once at completion (`status=COMPLETED`/`FAILED`, `summary` set to the same `AggregatedPlanResult` shape returned to the HTTP caller). `id` is supplied explicitly by `AgentOrchestrator` (the plan's own generated id), not left to `@default(cuid())`, so the audit row, the `PLAN_CREATED`/`PLAN_COMPLETED` events, and the HTTP response all share one id with no translation step. No FK relations (soft reference, same rationale as every other table in this list).

### `AIRequestLog`
One write-once audit row per `AIService.generate()` call — created only after the call settles (success or exhausted retries), never updated afterward, unlike `AgentPlanExecution`'s start/complete pair. `id, provider, model, assetId? (soft ref, no FK, nullable by design), status (AIRequestStatus), promptTokens, completionTokens, totalTokens, estimatedCostUsd (Float), latencyMs, attempts (default 1), error?, createdAt`
Indexes: `[provider]`, `[assetId]`, `[status]`. `assetId` is nullable because an AI request isn't inherently tied to an asset the way `AgentPlanExecution.assetId` always is (every `/agents/execute` call requires one; `/ai/generate` does not) — a standalone utility call simply has no asset to attribute it to.

## Migrations
Run via `pnpm prisma:migrate` (dev) / `pnpm prisma:deploy` (deploy). Notable migrations in history: `add_sync_job` (Phase 4), `20260719132516_add_resource` (Phase 5A), `20260719135311_add_relationship` (Phase 5B), `20260720183923_add_analysis_platform` (Phase 6A), `20260720190616_add_policy_compliance` (Phase 6B), `20260721183220_add_agent_platform` (Phase 7A), `20260722181713_add_ai_integration_framework` (Phase 7B). Phase 7C (Knowledge Retrieval & Context Builder) added no migration — it's a stateless read pipeline over data every other phase already persists, same as `POST /ai/generate` itself. Phase 7D (AI Report Agent) also added no migration — `ReportAgent`'s AI-generated narrative is computed per-request and returned in the response, never persisted (an `AIRequestLog` row is still written per underlying `AIService.generate()` call, same as any other caller). Phase 8 (AI Security Copilot) likewise added no migration — `POST /copilot/chat` is stateless request/response, with no conversation/session model of any kind (an `AIRequestLog` row is still written per call, same as every other `AIService.generate()` caller). Phase 9 (Frontend Dashboard) added no migration either — no backend file changed. Phase 10 (Real-Time Platform) also added no migration — WebSocket connections and their subscriptions are held entirely in-memory (`connection-registry.ts`), never persisted; the `AssetEvent` rows it broadcasts are the same rows every prior phase already wrote via `EventService.createForAsset()`. Phase 11 (Production Readiness & Deployment) added no migration either, per its own explicit "do not change database schema" constraint — logs, metrics, health checks, Docker, and CI/CD are all operational concerns with no new persisted data of their own; note that neither `docker-compose.dev.yml` nor `docker-compose.prod.yml` runs `prisma migrate deploy` automatically, so a fresh container volume still needs this same `pnpm prisma:deploy` step run explicitly before the schema exists (see DECISIONS.md). Phases 12–14 (Cloud Production Readiness, Production Frontend, Production Deployment & DevOps) added no migrations either — all three were explicitly scoped to stay off the schema (observability/frontend/deployment-and-ops concerns respectively).

**Seeding**: `src/scripts/seed.ts` (Phase 14), run via its compiled output — `pnpm build && pnpm prisma:seed` (`prisma:seed` runs `node dist/scripts/seed.js`; also wired as `migrations.seed` in `prisma.config.ts`, so `prisma db seed` works too, same build prerequisite). Lives under `src/` and runs from `dist/`, not `tsx`-on-the-fly, because the production Docker image ships `dist/` only, not `src/` — `docker compose exec api pnpm prisma:seed` needs to work against that same runtime image, so the script can't depend on TypeScript source files that aren't there (see DECISIONS.md). Creates exactly one idempotent admin `User` row (`admin@estateai.local`) so a fresh database has something to log in with — deliberately does not fabricate any `Asset`/`Account`/`Resource`/etc rows, since those are only meaningful once a real GitHub OAuth connection exists (see `DEPLOYMENT.md`'s "First deploy").

## Design decisions worth remembering
See [DECISIONS.md](DECISIONS.md) for the full rationale behind: soft-reference/no-FK on `SyncJob`/`Resource`/`Relationship`/`Finding`/`Recommendation`/`RiskScore`/`Policy`/`PolicyResult`/`AgentPlanExecution`/`AIRequestLog`, global (not per-account) `Resource` identity, the `Relationship` unique constraint, `RiskScore`'s application-layer (not DB) uniqueness, why `Policy.enabled` is excluded from the code-to-DB metadata sync, why `AgentPlanExecution.id` is caller-supplied, why `AIRequestLog` is write-once with a nullable `assetId`, why Phase 7C's `KnowledgeContext` is never persisted, and why Phase 7D's AI report narrative is likewise never persisted.
