# Architecture

EstateAI's API (`apps/api`) is a single Fastify + TypeScript deployable backed by PostgreSQL (via Prisma) and Redis. One process serves the HTTP API and (unless `WORKERS_ENABLED=false`) runs an in-process async job worker pool.

## Layering

```
routes/        Fastify route handlers — thin. Zod-validate input, call one service
                method, map domain errors to HTTP status via a local mapXError().
services/      All business logic lives here. Never touch Prisma directly.
                Grouped by domain: assets, auth, oauth, sync, discovery, jobs,
                resources, graph.
repositories/  Pure data access. One per Prisma model family. No business logic,
                no authorization, no event emission — just queries.
```

Routes never call repositories directly. Repositories never call services. This is enforced by convention, not tooling.

## Cross-cutting patterns

**Registry pattern** — used everywhere a set of pluggable, provider- or type-specific handlers needs to grow without touching the dispatching code:
- `oauthProviderRegistry` (`src/services/oauth/provider-registry.ts`)
- `syncProviderRegistry` (`src/services/sync/sync-registry.ts`)
- `discoveryProviderRegistry` (`src/services/discovery/discovery-registry.ts`)
- `jobDispatcher`'s handler map (`src/services/jobs/job-dispatcher.ts`)
- `relationshipExtractorRegistry` (`src/services/graph/relationship-extractors.ts`)
- `ruleRegistry` (`src/services/analysis/rule-registry.ts`)
- `policyRegistry` (`src/services/policy/policy-registry.ts`)
- `agentRegistry` (`src/services/agents/agent-registry.ts`)

Each is a `Map<string, Handler>` (or, for rules/policies, an array filtered by `supports()`) with `register()` + a resolve method. Adding a new OAuth/sync/discovery provider, job type, relationship extractor, analysis rule, policy, or agent never requires modifying the service that consumes it — only registering a new handler. `RuleEngine`/`PolicyEngine` in particular never branch on provider or resource type; they only call `supports()`/`evaluate()` on whatever the registry currently holds. `PolicyEngine` additionally never touches the database — it receives a pre-resolved `enabledCodes: Set<string>` from `PolicyService`, so "is this policy turned on" is a service-layer concern, not an engine one. `agentRegistry`/`PlannerService` follow the same shape one level up: the planner never hardcodes which agents exist or which pipeline a request type runs — it asks the registry which agents `supports()` a request type, then asks each agent's own `plan()` for its dependencies (see "Agent Orchestration Platform" below).

**Ownership helper pattern** — every domain that's reachable from more than one route resolves-and-authorizes via an exported helper that throws `NotFoundError`/`ForbiddenError` consistently:
- `getOwnedAsset` (`src/services/assets/ownership.ts`)
- `getOwnedAccount` (`src/services/assets/account.service.ts`)
- `getOwnedResource` (`src/services/resources/resource.service.ts`)

`Finding` has no `getOwnedFinding` helper of its own — `FindingService.getById` resolves the finding's `Resource` (via `resourceRepository.findById`) and authorizes through that resource's `assetId`, the same indirection `ResourceSearchService`/`GraphService` use for anything without a direct `assetId` column. `Policy` is the one exception to the ownership pattern entirely: it's organizational/shared catalog data (like categories or tags), not per-user data, so `GET /policies` and `GET /policies/:id` have no ownership check at all — any authenticated user can read the policy catalog.

Non-admin list/search endpoints that aren't scoped to a single entity by URL param require an explicit `assetId` query param instead (mirrored across `AccountService.list`, `JobService.listJobs`, `ResourceSearchService.search`, `FindingService.list`, `RecommendationService.list`) — there is no "list everything I own across all assets" endpoint. `RiskService.getOverview`/`ComplianceService.getOverview` mirror this but reserve the no-`assetId` case for `ADMIN` only (platform-wide OVERALL scope); `ComplianceService.getOverview` additionally accepts an admin-only `provider` query param for PROVIDER-scope reports.

**Soft-reference, no-FK pattern** — `SyncJob`, `Resource`, `Relationship`, `Finding`, `Recommendation`, `RiskScore`, `Policy`, and `PolicyResult` store `accountId`/`assetId`/`resourceId`/`findingId`/`policyId`/etc. as plain `String` columns with no Prisma `@relation`. This is deliberate: it avoids cascade-delete complexity and avoids coupling these tables' lifecycles to `Asset`/`Account`/`Resource`/`Finding`/`Policy` row deletion. The tradeoff is that referential integrity for these fields is enforced only at the service layer, not the database — and that hard-deleting a `Resource` (as several older verification scripts do in cleanup) can leave orphaned `Finding`/`RiskScore`/`PolicyResult` rows behind, same as it already could for `Relationship`.

**Free-form-string vs. real-enum split** — `Account.provider`, `SyncJob.type`, `Relationship.relationshipType`, `Finding.ruleCode`, `Policy.code` are free-form strings so new values never require a migration. `JobStatus`, `JobPriority`, `FindingSeverity`, `FindingStatus`, `RecommendationStatus`, `RiskScope`, `PolicyResultStatus` are real Postgres enums because they're closed, stable sets that benefit from DB-level validation and ordering (`JobPriority` is declared `LOW, NORMAL, HIGH, CRITICAL` — ascending — specifically so `ORDER BY priority DESC` sorts CRITICAL first, since Postgres enums compare by declaration order).

**Best-effort event emission** — every `AssetEvent`-emitting method (in `ResourceService`, `RelationshipService`, `JobExecutor`, `FindingService`, `RecommendationService`, `RiskService`, `PolicyService`, `ComplianceService`, `AgentOrchestrator`, `AIService`, `ReportAgent`, `CopilotService`) wraps `eventService.createForAsset(...)` in try/catch and swallows failures. An event-write failure must never mask the real operation's outcome. `EventService.createForAsset()` itself follows the same rule one level deeper (Phase 10): publishing to `realtimeBus` after a successful DB write is also wrapped in try/catch, so a WebSocket broadcast problem can never turn a successful event write into a caller-visible failure either.

**Code-registered-but-DB-persisted catalog pattern** — `Policy` is the first model in the codebase where a code-defined registry (`policyRegistry`) and a database table both hold the same entity, deliberately: the code owns the *definition* (name, description, evaluation logic), the database owns *whether it's turned on* (`enabled`). `PolicyService.ensureRegisteredPoliciesPersisted()` syncs every registered policy's metadata into the `Policy` table on each evaluation run (idempotent upsert-by-code) but never touches `enabled` on an existing row — that field is the one thing an operator can change (via direct repository access today, no HTTP route yet) that the sync will never silently revert.

## Request flow: synchronous domains

```
Client → route (Zod validate) → service (business logic, ownership check) →
repository (Prisma) → Postgres
```
Applies to: auth, categories, tags, assets, events, accounts (CRUD), oauth, resources (read/search/graph).

## Request flow: asynchronous domains (Phase 4+)

Long-running operations (currently: sync, discovery) are never executed inline on the HTTP request. Instead:

```
POST /accounts/:id/sync|discover
  → JobService.enqueueForAccount() creates a SyncJob row (status=QUEUED) + RPUSH on Redis
  → 202 { jobId, status, priority, queueDepth }

WorkerPool (N workers, in-process)
  → each worker polls: fast-path via non-blocking Redis LPOP, falls back to
    Postgres claimNextJob() on a timer (JOB_POLL_INTERVAL_MS)
  → claim is a status-guarded UPDATE ... WHERE id=? AND status='QUEUED' — the
    row-lock re-evaluation makes this race-safe across workers without an
    explicit transaction
  → JobExecutor runs the job via JobDispatcher's registered handler
      (SYNC → SyncService, DISCOVERY → DiscoveryService)
  → on success: status=COMPLETED, result stored, AssetEvent emitted
  → on failure: PermanentJobError (or SyncProviderError /
      UnsupportedDiscoveryProviderError) → FAILED immediately, no retry;
      anything else → RetryService computes backoff (JOB_RETRY_BACKOFF_MS),
      status=RETRYING, nextRetryAt set → once maxAttempts exhausted, DEAD

Heartbeat: each worker updates SyncJob.heartbeatAt on an interval
  (JOB_HEARTBEAT_INTERVAL_MS). A separate monitor (JOB_HEARTBEAT_CHECK_INTERVAL_MS)
  reclaims jobs stuck RUNNING with a stale heartbeat (JOB_HEARTBEAT_STALE_MS) —
  this is what makes worker-crash recovery work: no job is lost, it just goes
  back to QUEUED and gets re-claimed.
```

Redis's role here is a **fast-path signal only** — Postgres remains the sole source of truth and the sole locking mechanism. If Redis is unavailable or the pushed signal is missed, the poll-interval fallback still finds the job.

Clients poll `GET /jobs/:id` until a terminal status (`COMPLETED`, `FAILED`, `CANCELLED`, `DEAD`).

## Discovery → Resource → Graph → Analysis → Policy → Compliance pipeline (Phase 5A/5B/6A/6B)

```
DiscoveryService.discover(account, requester)
  1. discoveryProviderRegistry.resolve(account.provider).discover(credential)
     → DiscoveredResource[] (provider-space identities, e.g. GitHub numeric repo id)
  2. ResourceService.persist({ accountId, assetId, resources, requester })
     a. resourceDeduplicator collapses duplicate (provider:providerResourceId)
        entries within the batch (last wins)
     b. for each: compute content hash (resource-version.service.ts,
        stableStringify over {resourceType, displayName, description,
        externalUrl, metadata}) → classify NEW/UPDATED/UNCHANGED → upsert
        keyed on (provider, providerResourceId) → emit RESOURCE_CREATED /
        RESOURCE_UPDATED / RESOURCE_DISCOVERED
     c. diff pass: any Resource previously active for this account but absent
        from this batch is soft-deleted (deletedAt set) → RESOURCE_DELETED
     d. returns { created, updated, unchanged, deleted, resources: Resource[] }
        — `resources` is every row touched this run, used in step 3
  3. RelationshipService.extractAndPersist(provider, discoveredResources,
     persistedResources, requester, assetId)
     a. builds a Map<providerResourceId, Resource.id> from step 2d's output
     b. relationshipExtractorRegistry.extract(provider, discoveredResources)
        → ExtractedRelationship[] (still in provider-space identities)
     c. translates each edge's endpoints via the map, skips edges pointing at
        an identity that wasn't actually persisted (defensive, shouldn't happen)
     d. upserts each edge keyed on (fromResourceId, toResourceId,
        relationshipType) → classify CREATED/UPDATED/UNCHANGED via
        stableStringify metadata diff (no stored hash column, unlike Resource)
     e. emits RELATIONSHIP_CREATED/RELATIONSHIP_UPDATED per edge, and one
        GRAPH_UPDATED summary event at the end only if anything changed
  4. FindingService.evaluateResources({ resources: persisted.resources,
     provider, assetId, requester })
     a. RuleEngine.evaluate(resources) → ruleRegistry.rulesFor(resource) per
        resource → Map<resourceId, RuleFinding[]>, plus rulesExecuted/
        resourcesEvaluated/durationMs stats
     b. per resource, per candidate RuleFinding: no existing row → create
        (FINDING_CREATED) → RecommendationService.generateForFinding();
        existing RESOLVED or changed → reopen/update (FINDING_UPDATED) →
        RecommendationService.reopenForFinding(); unchanged → no-op
     c. per resource, any existing OPEN finding whose ruleCode didn't
        recur this run → resolve (FINDING_RESOLVED) →
        RecommendationService.resolveForFinding()
     d. returns AnalysisResult { rulesExecuted, resourcesEvaluated,
        findingsCreated, findingsUpdated, findingsResolved,
        recommendationsGenerated, durationMs }
  5. RiskService.recalculate({ resourceIds, accountId, assetId }, requester)
     a. per resourceId: countOpenBySeverityForResourceIds([id]) → upsert
        RESOURCE-scope RiskScore
     b. accountResources = findActiveByAccount(accountId) → upsert
        ACCOUNT-scope RiskScore
     c. assetResources = findActiveByAsset(assetId) → upsert ASSET-scope
        RiskScore
     d. countOpenBySeverityAll() (platform-wide) → upsert OVERALL-scope
        RiskScore
     e. emits one RISK_UPDATED event carrying the ASSET-scope score
  6. PolicyService.evaluateResources({ resources: persisted.resources,
     provider, assetId, requester })
     a. ensureRegisteredPoliciesPersisted() — idempotent upsert of every
        policyRegistry.allMetadata() entry into the Policy table (never
        touches `enabled`)
     b. enabledCodes = policyRepository.findEnabledCodes(provider)
     c. per resource: findingRepository.findOpenByResource(id) →
        findingsByResource map
     d. PolicyEngine.evaluate(resources, findingsByResource, enabledCodes)
        → policyRegistry.policiesFor(resource) filtered by enabledCodes →
        Policy.evaluate(resource, findings) per applicable policy
     e. per result: policyResultRepository.upsert() keyed on (policyId,
        resourceId) → if status changed from the previous row (or is new):
        emit POLICY_PASSED (status=PASS) or POLICY_FAILED (status=FAIL);
        WARNING/NOT_APPLICABLE persist silently, no dedicated event
     f. returns PolicyEvaluationSummary { policiesExecuted,
        resourcesEvaluated, passed, failed, warned, notApplicable,
        durationMs }
  7. ComplianceService.recalculateAndNotify(assetId, requester)
     a. resources = findActiveByAsset(assetId)
     b. buildReport('ASSET', resources) — query-time aggregation over
        current PolicyResult/Finding/RiskScore rows for those resourceIds
        (see "Compliance reporting" below)
     c. emits one COMPLIANCE_UPDATED event carrying the fresh report's
        summary counts
  8. DiscoveryResult returned to the job executor includes { resources,
     persisted, graph, analysis, policy }
```

### GitHub relationship extraction rules (`relationship-extractors.ts`)
- `user --owns--> repo` for every repo from `/user/repos`
- `user --member_of--> org` for every org from `/user/orgs`
- `org --contains--> repo`, inferred purely from `repo.full_name` starting with `${org.login}/` — no extra API calls

### Graph traversal (`GraphService`)
- `children()` / `parents()` — directional, one hop
- `neighbors()` — one hop, both directions
- `connectedResources()` / `pathExists()` — bounded BFS (`maxDepth = 5` default), both directions
- All methods call `getOwnedResource` first for authorization

### Resource search (`ResourceSearchService`)
Filters: name (substring, case-insensitive), provider, resourceType, metadata (Prisma JSON `path`/`equals`), relationshipType, pagination/sorting. Because there's no formal Resource↔Relationship FK, filtering by `relationshipType` is a two-step query: resolve matching `Relationship` rows first, collect endpoint resource ids into a set, then constrain the resource list to that set.

### GitHub rules (`services/analysis/rules/github/`)
| Rule code | Detects | Severity |
|---|---|---|
| `PUBLIC_REPOSITORY` | `metadata.private === false` | MEDIUM |
| `ARCHIVED_REPOSITORY` | `metadata.archived === true` | LOW |
| `EMPTY_REPOSITORY` | `metadata.size === 0` (GitHub's own "nothing pushed" signal) | LOW |
| `NO_DESCRIPTION` | `resource.description` is empty/null | INFORMATIONAL |
| `NO_TOPICS` | `metadata.topics` is empty/missing | INFORMATIONAL |

All five `supports()` on `provider === 'github' && resourceType === 'repository'`; `user`/`organization` GitHub resources match no rule today. `confidence` is always 100 (deterministic, no LLM).

### Risk scoring (`RiskService`)
`overallScore` is a **capped weighted sum** of OPEN findings at a given scope, not an average — every additional finding raises risk (an average would dilute it), capped at 100 since it's presented as a percentage-like score. Weights are configurable via `RISK_WEIGHT_CRITICAL/HIGH/MEDIUM/LOW/INFORMATIONAL` env vars (`config.risk.weights`, defaults 100/70/40/20/5). A RESOURCE-scope `RiskScore` row is computed for **every** persisted resource in a discovery run, not just the ones a rule flagged — a resource with zero findings still gets a row with `overallScore: 0`.

### GitHub policies (`services/policy/policies/github/`)
Policies consume Findings, not raw provider data — each policy's `evaluate(resource, findings)` looks for a specific `ruleCode` among the resource's current OPEN findings. The one exception is `FORK_REPOSITORIES_IGNORED`, which reads `resource.metadata.fork` directly, the same way a Rule reads resource metadata — the constraint is that `PolicyEngine` itself never knows GitHub exists, not that an individual policy implementation can't.

| Policy code | Driven by | PASS | FAIL/WARNING | NOT_APPLICABLE |
|---|---|---|---|---|
| `NO_PUBLIC_REPOSITORIES` | `PUBLIC_REPOSITORY` finding | no finding | FAIL if finding present | never |
| `REPOSITORIES_MUST_HAVE_DESCRIPTION` | `NO_DESCRIPTION` finding | no finding | FAIL if finding present | never |
| `REPOSITORIES_MUST_HAVE_TOPICS` | `NO_TOPICS` finding | no finding | FAIL if finding present | never |
| `ARCHIVED_REPOSITORIES_ARE_ALLOWED` | `ARCHIVED_REPOSITORY` finding | never | WARNING if finding present (permitted, but flagged for review) | if no finding (not archived) |
| `FORK_REPOSITORIES_IGNORED` | `resource.metadata.fork` | if not a fork | never | if `fork === true` |

All five `supports()` on `provider === 'github' && resourceType === 'repository'`.

### Compliance reporting (`ComplianceService`)
Computed at query time from current `PolicyResult`/`Finding`/`RiskScore` rows — unlike `RiskScore`, there is **no persisted compliance snapshot**; every `GET /compliance*` call and every `recalculateAndNotify` re-aggregates from scratch. Scopes: `ASSET` and `ACCOUNT` (ownership-checked), `PROVIDER` and `OVERALL` (admin-only). `complianceScore` = `round(100 * (pass + warning×0.5) / (pass + fail + warning))`, capped implicitly at 100 by construction, and defined as 100 when nothing applicable was evaluated (vacuously compliant) — `NOT_APPLICABLE` results are excluded from the denominator entirely. `riskDistribution` buckets each in-scope resource's RESOURCE-scope `RiskScore.overallScore` into `low` (<25) / `medium` (<50) / `high` (<75) / `critical` (≥75) bands, reusing Phase 6A's stored risk data rather than recomputing it.

## Agent Orchestration Platform (Phase 7A)

A coordination layer over Phases 5A–6B's services — never a new source of business logic, only a registry-driven pipeline that runs existing services and merges their outputs. Deliberately **not** job-queued: every agent only reads already-persisted data (resources, findings, risk scores, policy results, compliance reports), so a plan run is expected to finish in milliseconds-to-low-seconds inside one HTTP request, unlike sync/discovery.

```
POST /agents/execute { requestType, assetId }
  → AgentOrchestrator.execute(requester, assetId, requestType)
    1. getOwnedAsset(assetId, requester) — same ownership check as every other domain
    2. new AgentContext(requester, assetId, abortSignal) — the "shared context"
    3. PlannerService.createPlan(requestType, assetId, context)
       a. agentRegistry.agentsFor(requestType) — every agent whose supports()
          returns true for this request type becomes one AgentTask
       b. each task's dependsOn comes from that same agent's plan(context) hint,
          not from any hardcoded pipeline in the planner
       c. a dependsOn referencing an agent not included in this plan is dropped
          (defensive — would otherwise stall the task graph forever)
    4. persists an AgentPlanExecution row (status=RUNNING)
    5. TaskService.buildWaves(plan.tasks) — Kahn's-algorithm-style topological
       partition; every task whose dependencies are all in an earlier wave
       runs together in the next wave
    6. per wave (sequential across waves, parallel within a wave via Promise.all):
       - a task whose dependency failed is marked SKIPPED without executing
       - otherwise agentRegistry.resolve(agentId) → TaskService.runTask():
         retries up to maxAttempts on a thrown error, each attempt bounded by
         timeoutMs (Promise.race), short-circuits to SKIPPED if the plan's
         AbortSignal was already tripped
       - AGENT_STARTED / AGENT_COMPLETED / AGENT_FAILED emitted per task
       - the task's AgentResult is stored on AgentContext.results, keyed by
         agentId, so a later-wave agent (ReportAgent) can read it directly
    7. ResultAggregatorService.aggregate() — merges every SUCCESS task's
       output into `data` (keyed by agentId), while keeping per-task
       provenance (status/timing/attempts/error) in a separate `tasks` array;
       overall status is SUCCESS / PARTIAL / FAILED depending on how many
       tasks failed
    8. AgentPlanExecution row updated to COMPLETED/FAILED + summary JSON;
       PLAN_CREATED (step 4) and PLAN_COMPLETED events bracket the whole run
  → 200 AggregatedPlanResult { planId, status, durationMs, tasks, data }
```

### Request types → agents (`services/agents/dto/execution-plan.ts`)
| Request type | Agents involved | Task graph shape |
|---|---|---|
| `DISCOVERY_SUMMARY` | `discovery` | single task |
| `RISK_SUMMARY` | `risk` | single task |
| `COMPLIANCE_SUMMARY` | `compliance` | single task |
| `RECOMMENDATIONS` | `recommendation` | single task |
| `SECURITY_REPORT` | `discovery`, `risk`, `compliance`, `recommendation`, `report` | wave 1: discovery/risk/compliance (parallel) → wave 2: recommendation (depends on risk) → wave 3: report (depends on all four) |

`SECURITY_REPORT` is the one request type that exercises both a parallel wave and a genuine sequential dependency from a single real request, per the spec's example pipeline (Risk → Compliance → Recommendation → Report — reframed here as risk/compliance running in parallel since neither depends on the other, with recommendation and report as the two sequential stages after).

### The 5 agents (`services/agents/agents/`)
Each is a thin, stateless adapter — `execute()` never duplicates a service's logic, only calls it and reshapes the result:
- **DiscoveryAgent** — resource counts by provider/type (`ResourceSearchService.search`) plus a bounded (first 5 resources) graph-connectivity sample (`GraphService.neighbors`). Deliberately does **not** call `DiscoveryService.discover()` — that method hits the live provider API and already has its own async-job entry point (`POST /accounts/:id/discover`, Phase 4); re-running it synchronously inside an agent request would duplicate that job's responsibility and add an external API call to what's supposed to be a fast, in-request read. This means `DISCOVERY_SUMMARY`/`SECURITY_REPORT` reflect the asset's state as of its last completed discovery job, not a live pull (see DECISIONS.md).
- **RiskAgent** — `FindingService.list` (open findings, top 5 by severity) + `RiskService.getForAsset`.
- **ComplianceAgent** — `ComplianceService.getForAsset`.
- **RecommendationAgent** — `RecommendationService.list` (open, sorted by priority). Declares a dependency on `risk` even though `RecommendationService` doesn't technically need `RiskService`'s data — this keeps the report's highest-priority recommendations aligned with the findings `RiskAgent` already summarized, and gives the task graph a genuine sequential edge alongside the parallel discovery/risk/compliance wave.
- **ReportAgent** — has no service of its own; reads the other four agents' already-computed `AgentResult`s off `AgentContext` (never re-queries) and reshapes them into `executive`/`technical`/`asset` report sections. A dependency that failed or was skipped is simply omitted from the report rather than failing the whole request. As of Phase 7D, it's also the one agent wired to `AIService` — see "AI Report Integration" below.

### Shared context and result aggregation
`AgentContext.getOrLoad(key, loader)` memoizes a read for the lifetime of one plan run — if two agents in the same plan both need the asset's `RiskScore`, only one query happens. `AgentContext.setResult`/`getResult` (keyed by `agentId`) is how `ReportAgent` gets at upstream agents' output without a second round of service calls. `ResultAggregatorService` keeps these two concerns — the merged, report-ready `data` and the per-task `tasks` provenance array — deliberately separate, so a caller can always see which agent produced which section and how long it took, independent of the merged payload's shape.

## AI Integration Framework (Phase 7B)

A vendor-neutral abstraction layer that sits **beside** the Agent Orchestration Platform above, not inside it — `services/ai/` is a new peer domain (like `services/policy/` sits beside `services/analysis/`). No Phase 7A agent was modified to use it at Phase 7B (reaffirmed at Phase 7C); as of Phase 7D, exactly one agent — `ReportAgent` — calls it, still through this same unmodified chokepoint (see "AI Report Integration" below). The architecture is one layer deeper than agents:

```
Agent (ReportAgent only, Phase 7D) → AIService.generate()
  1. resolve a provider: explicit `provider` param, else `aiProviderRegistry.resolveForModel(model)`,
     else config.ai.defaultProvider (AI_PROVIDER env var)
  2. if assetId was given: ContextBuilder.build({assetId, focus, requester}) → KnowledgeContext
     (Phase 7C — see "Knowledge Retrieval & Context Builder" below). Degrades gracefully: a
     failure here means generate() proceeds with no context, not a failed request.
  3. PromptBuilder.build({systemPrompt, userPrompt, knowledgeContext}) → provider-independent
     AIRequest (system prompt + rendered KnowledgeContext sections + user prompt as one message)
     — has no import from services/agents or any provider file, so it never needs to change to
     support a future agent-integrated caller
  4. AI_REQUEST_STARTED event (best-effort, only if an assetId was given)
  5. retry loop (up to AI_MAX_RETRIES): provider.generate(request)
     - a thrown AIProviderTransientError (429/5xx) is retried after AI_RETRY_BACKOFF_MS
     - a thrown AIProviderRequestError (bad key, malformed request) is NOT retried — same
       permanent-vs-retryable distinction PermanentJobError/DiscoveryProviderError draw elsewhere
  6. on success: persist one write-once AIRequestLog row (status=SUCCESS), emit
     AI_REQUEST_COMPLETED + TOKEN_USAGE_RECORDED
  7. on exhausted retries / permanent error: persist AIRequestLog (status=FAILED), emit
     AI_REQUEST_FAILED, rethrow
→ standardized AIResponse { provider, model, text, usage, finishReason, estimatedCostUsd, latencyMs }
```

`POST /ai/generate`, `ReportAgent` (Phase 7D, only when `aiMode` is `SUMMARY`/`FULL_REPORT`), and `CopilotService` (Phase 8) are the three callers of `AIService.generate()`. As of Phase 7C, every asset-scoped call through it is automatically grounded via `ContextBuilder`/`KnowledgeService` — this is exactly why neither `ReportAgent` nor `CopilotService` needed to call `ContextBuilder` itself to get a grounded prompt.

### Provider registry (`aiProviderRegistry`) and the 3 adapters
Same registry shape as `agentRegistry`/`policyRegistry`: a `Map<string, AIProvider>` with `register()`/`resolve(id)`/`resolveForModel(model)`/`list()`. Every `AIProvider` implements `id()`/`supports(model)`/`models()`/`generate()`/`stream()`/`estimateCost()`/`countTokens()`. Each of the 3 adapters (`services/ai/providers/`) is self-contained — its vendor's request/response JSON shapes never leave its own file, the same convention as the three separate GitHub oauth/sync/discovery providers:
- **`ClaudeProvider`** — Anthropic Messages API (`x-api-key`/`anthropic-version` headers). Models: `claude-opus-4-8`, `claude-sonnet-5`, `claude-haiku-4-5-20251001`.
- **`OpenAIProvider`** — Chat Completions API (`Authorization: Bearer` header, system prompt folded into the `messages` array as a `system`-role entry). Models: `gpt-4o`, `gpt-4o-mini`, `gpt-4.1`.
- **`GeminiProvider`** — `generateContent`/`streamGenerateContent` (model in the URL path, API key as a query param, `assistant` role renamed to `model`). Models: `gemini-2.0-flash`, `gemini-1.5-pro`.

Each provider's base URL (`CLAUDE_API_URL`/`OPENAI_API_URL`/`GEMINI_API_URL`) defaults to the real vendor endpoint but is overridable — exactly the `GITHUB_*_URL` pattern — so `verify-ai.ts` points all three at local mock servers instead of live vendors.

### Shared, non-duplicated utilities
- **`token-counter.ts`** (`estimateTokens()`) — a deliberate chars/4 approximation, not a real per-vendor tokenizer (tiktoken, Claude's tokenizer, SentencePiece). Every provider's *actual* usage numbers come from the vendor's own response, not this estimate; this exists only for pre-request estimation.
- **`cost-estimator.ts`** (`estimateCostUsd()`) — a static, illustrative USD-per-million-token pricing table per model, with a `DEFAULT_PRICING` fallback so an unrecognized model never throws.
- **`response-parser.ts`** (`ResponseParser.normalize()`) — the one step every provider's `generate()` calls after parsing its own vendor JSON: attaches `estimatedCostUsd` + `latencyMs` to build the final `AIResponse`. Vendor-specific parsing stays in each provider file; only this last assembly step is shared.

### Retry semantics
`AIService` retries only `AIProviderTransientError` (429/5xx/timeout), up to `AI_MAX_RETRIES` attempts with a fixed `AI_RETRY_BACKOFF_MS` delay between attempts — a synchronous, in-request retry loop (no job queue involved), matching how Phase 7A's `TaskService.runTask()` retries an agent. `AIProviderRequestError` (bad API key, malformed request) is never retried — retrying a request the vendor has already rejected outright can't succeed and would only waste `AI_MAX_RETRIES` attempts before failing anyway.

### `AIRequestLog` — write-once audit row
Unlike `AgentPlanExecution` (written at plan start AND completion), one `AIRequestLog` row is created after a `generate()` call fully settles — success or exhausted retries — and is never updated afterward. `assetId` is nullable: an AI request isn't inherently tied to an asset the way `/agents/execute` is, so a standalone utility call simply has no asset to attribute events to (and none are emitted in that case — there's no user-level or global event stream in this codebase, only per-asset).

## Knowledge Retrieval & Context Builder (Phase 7C)

Sits between agents (Phase 7A) and `AIService`/`PromptBuilder` (Phase 7B) — one layer further down than either, so future agents (and today's `AIService`) never have to manually gather context before calling AI:

```
(future) Agent → ContextBuilder.build({assetId, accountId?, focus?, requester})
  1. getOwnedAsset(assetId, requester) — same ownership check as every other domain
  2. CONTEXT_BUILD_STARTED event (best-effort)
  3. KnowledgeService.retrieveAndBuildContext(request)
     a. retrieverRegistry.retrieversFor(request) — every retriever whose supports() returns true
        (today: all 6, unconditionally — `focus` is a hint reserved for a future retriever that
        might gate on it)
     b. run every retriever in parallel (Promise.all) — no inter-retriever dependencies, unlike
        the agent task graph's wave-based sequencing
     c. per retriever: RETRIEVAL_COMPLETED event (best-effort)
     d. per bucket (resource/relationship/finding/policy/recommendation/risk):
        - dedupe by entityKey (exact-duplicate removal, first occurrence wins)
        - collapse: any groupKey with more than KNOWLEDGE_COLLAPSE_THRESHOLD items keeps only
          the (threshold - 1) highest-relevance members individually and folds the rest into one
          synthetic "N more ... items" summary item
        - sort by relevance descending
     e. trim globally (across every bucket, not per-bucket): while the estimated token cost
        (token-counter.ts's estimateTokens(), reused from Phase 7B) exceeds
        KNOWLEDGE_MAX_CONTEXT_TOKENS, drop the single lowest-relevance item across the whole
        context, repeat
     f. assemble KnowledgeContext { resources, relationships, findings, policies,
        recommendations, risk, metadata }
  4. CONTEXT_BUILD_COMPLETED event (best-effort)
→ KnowledgeContext, ready to hand to PromptBuilder
```

`POST /knowledge/context` exposes this directly; `AIService.generate()` (Phase 7B) also calls it automatically whenever `assetId` is provided, before building the prompt — see the AI Integration Framework section above.

### The 6 retrievers (`services/knowledge/retrievers/`)
Each is a thin adapter over exactly one existing service — never Prisma directly, never re-implementing what that service already computes:
- **`ResourceRetriever`** — `ResourceSearchService.search()`. Relevance = recency decay (100 at ≤1 day old since `lastSeen`, linearly down to a floor of 10 past 30 days).
- **`GraphRetriever`** — `ResourceSearchService.search()` + `GraphService.neighbors()`. Bounded to the first 10 resources, same convention as `DiscoveryAgent`'s connectivity sample (Phase 7A) — a full graph walk over every resource isn't worth the query volume here.
- **`FindingRetriever`** — `FindingService.list()` (OPEN findings). Relevance reuses `config.risk.weights` directly — the same `RISK_WEIGHT_*`-configurable scale `RiskService` scores with, not a second hardcoded severity scale.
- **`PolicyRetriever`** — `ComplianceService.getForAsset()`. Emits one item per policy failure (fixed relevance — `ComplianceReport`'s `PolicyOutcome` doesn't carry the originating `Policy`'s severity) plus one synthetic summary item for pass count.
- **`RecommendationRetriever`** — `RecommendationService.list()` (OPEN, sorted by priority). Relevance also reuses `config.risk.weights`, since `Recommendation.priority` is itself a `FindingSeverity`.
- **`RiskRetriever`** — `RiskService.getForAsset()`. One item (fixed top relevance) when a `RiskScore` exists, none otherwise.

### Merge, dedupe, and trim (`KnowledgeService`)
This is where the spec's "Token Optimization" requirements live: **duplicate removal** (`entityKey`), **priority ordering** (sort by `relevance` descending), **summaries for repeated entities** (`groupKey` collapsing), and **maximum context size** / **large context trimming** (the global lowest-relevance-first drop loop). All four operate on `RetrievedItem[]` — plain data, no service calls — so `KnowledgeService` itself never touches Prisma or any external service; every read already happened inside a retriever.

### `PromptBuilder` now renders `KnowledgeContext`
`PromptBuilder.build()` (Phase 7B) was modified to accept an optional `knowledgeContext?: KnowledgeContext` instead of Phase 7B's freeform `contextBlocks` record. This is a type-only import of the knowledge domain's DTO — `PromptBuilder` never calls `ContextBuilder`/`KnowledgeService` itself, it only renders whatever `KnowledgeContext` it's handed (risk → findings → policies → recommendations → resources → relationships, in that priority order; an empty section is omitted entirely). It stays a pure function of its inputs either way.

## AI Report Integration (Phase 7D)

The one place every prior AI-adjacent phase deliberately left undone: wiring a real Phase 7A agent to `AIService`. Scoped to exactly one agent — `ReportAgent` — leaving `RiskAgent`/`ComplianceAgent`/`DiscoveryAgent`/`RecommendationAgent` untouched, and touching nothing inside `AIService`/`PromptBuilder`/`ContextBuilder`/`KnowledgeService` themselves:

```
POST /agents/execute { requestType: SECURITY_REPORT, assetId, aiMode? }
  → AgentContext gains a 4th field, aiMode (OFF | SUMMARY | FULL_REPORT, default OFF) —
    every other agent ignores it; only ReportAgent reads it
  → ReportAgent.plan(context) widens timeoutMs to 30s when aiMode !== OFF (the default
    10s task timeout, planner.service.ts, is sized for read-only aggregation, not a
    network round trip)
  → ReportAgent.execute(context) builds the exact same executive/technical/asset
    structured report as before (Phase 7A), unconditionally
  → if aiMode === OFF: return the structured report, unchanged from Phase 7A — this is
    what makes the change additive: no existing SECURITY_REPORT caller sees any
    difference unless it explicitly opts in
  → otherwise: buildAIReport(context, structured)
     1. AI_REPORT_STARTED event (best-effort)
     2. select a prompt template — SUMMARY → executiveSummaryPrompt,
        FULL_REPORT → securityReportPrompt (services/ai/prompts/)
     3. aiService.generate({ requester, assetId, systemPrompt: template.systemPrompt,
        prompt: template.buildUserPrompt(structured), focus })
        — the exact same AIService.generate() every /ai/generate call uses; internally
        this still auto-builds a KnowledgeContext via ContextBuilder (Phase 7C) since
        assetId is set, so the AI call is grounded in the asset's real data without
        ReportAgent ever calling ContextBuilder/KnowledgeService itself
     4. parse the response's narrative text back into structured fields by splitting on
        the 5 fixed headings every template instructs the model to use (## Executive
        Summary / ## Risk Narrative / ## Recommendation Summary / ## Key Observations /
        ## Limitations) — SUMMARY mode only ever produces the first
     5. on success: AI_REPORT_COMPLETED event, return AIReport { aiStatus: SUCCESS, mode,
        <narrative fields>, metadata: {provider, model, latencyMs, tokens, cost, generatedAt} }
     6. on any failure (including AIService's own exhausted-retries case): AI_REPORT_FAILED
        event, return AIReport { aiStatus: FAILED, mode, error } — buildAIReport never
        throws, so an AI failure can never fail execute() or the whole plan run
  → data.report = { ...structured, aiReport } when aiMode !== OFF
```

### Prompt templates (`services/ai/prompts/`)
Live outside both `ReportAgent` and `PromptBuilder` — a template is just a `{ id, systemPrompt, buildUserPrompt(report) }` pair (`PromptTemplate`, `services/ai/dto/ai-report.ts`); `PromptBuilder` never imports or knows this concept exists, it only ever sees the resulting plain `systemPrompt`/`userPrompt` strings, same as any other `AIService.generate()` caller.
- **`executive-summary.prompt.ts`** — instructs a single `## Executive Summary` section. Used alone for `SUMMARY` mode.
- **`risk-summary.prompt.ts`** — instructs a single `## Risk Narrative` section. Not used standalone by `ReportAgent` today (no mode maps to it alone) — reused as a composable instruction fragment.
- **`security-report.prompt.ts`** — the `FULL_REPORT` template. Composes the executive-summary and risk-summary templates' instructions (rather than duplicating them) and adds three more: `## Recommendation Summary`, `## Key Observations`, `## Limitations`. Fixes all five headings, in order, so `ReportAgent`'s response parser can split one AI response back into five fields deterministically.

### Failure handling
`buildAIReport()`'s only job on the success path is to shape data; on the failure path, its only job is to never let an AI problem become an HTTP 500. Every branch — `aiService.generate()` throwing (permanent provider error, exhausted transient retries, a `ContextBuilder` hiccup that already degraded gracefully inside `AIService`, a task timeout under `AI_REPORT_TIMEOUT_MS`) — is caught in one place and turned into `{ aiStatus: FAILED, error }`. The structured report section is computed before any of this and is never touched by it.

## AI Security Copilot (Phase 8)

The second (and, so far, last) caller of `AIService`'s auto-grounding chain, alongside `ReportAgent` (Phase 7D) — proves the chain generalizes to a genuinely different consumer shape (a free-form question, not a fixed report template) without any change to `AIService`/`ContextBuilder`/`KnowledgeService`/`PromptBuilder`:

```
POST /copilot/chat { assetId, message }
  → getOwnedAsset(assetId, requester) — same ownership check as every other domain,
    performed explicitly by CopilotService itself (not just implicitly via AIService's
    own internal check) so an unauthorized/unknown asset never reaches an AI call at all
  → COPILOT_CHAT_STARTED event (best-effort)
  → aiService.generate({ requester, assetId, systemPrompt: <copilot persona>,
      prompt: message, focus: 'COPILOT_CHAT' })
    — the exact same AIService.generate() every /ai/generate call and ReportAgent use;
      internally this still auto-builds a KnowledgeContext via ContextBuilder whenever
      assetId is set, so CopilotService never calls ContextBuilder/KnowledgeService/
      PromptBuilder/a provider itself — "the message" is the only thing CopilotService
      contributes beyond what AIService already does
  → on success: COPILOT_CHAT_COMPLETED event, return CopilotChatResult { status: SUCCESS,
      answer: response.text, citations: response.citations, metadata: {provider, model,
      usage, estimatedCostUsd, latencyMs, generatedAt} }
  → on any failure (permanent provider error, exhausted transient retries, a
      ContextBuilder hiccup that already degraded gracefully inside AIService): catch it,
      COPILOT_CHAT_FAILED event, return CopilotChatResult { status: FAILED, error } — the
      request still returns 200; an AI failure can never fail POST /copilot/chat
```

`CopilotService` is deliberately the thinnest AI-consuming service in the codebase — it has no retrieval logic, no response parsing (unlike `ReportAgent`'s heading-based `parseNarrative()`), and no structured-output shape to assemble beyond passing `AIResponse` fields straight through. `answer` is `response.text` verbatim; `citations` is `response.citations` verbatim (currently always `undefined` since `ClaudeProvider` never populates it — the field only exists to pass through a future/other provider's citations, per Phase 7B's `AIResponse` design).

## Agentic AI Foundation (Phase 16)

`apps/api/src/ai/` is a new, independent module — the provider-agnostic infrastructure future agent phases (Orchestrator/Discovery/Risk/Compliance/Recommendation/Report/Copilot Agents) will be built on. **Phase 16 built the foundation only: no agents, no new routes, nothing wired into the existing app.** It is not a refactor of `services/ai/` and does not replace it.

**Why a second AI module instead of extending `services/ai/`.** `services/ai/` (Phase 7B) is a mature, working system already powering the live `/ai/generate` and `/copilot/chat` endpoints — its `AIProvider` interface, `AIService`, prompt builder, and Claude/OpenAI/Gemini providers are business logic this phase's own rules explicitly forbid touching ("DO NOT rewrite, replace, or refactor any existing business logic"). But the phase's actual spec — a `PromptRegistry` with versioning, a `ToolRegistry`, a `MemoryStore` abstraction, `AIContext` with tool/execution history, telemetry with retry-count/success-rate — describes a different, broader surface than `services/ai/` was built for (it has no tools, no memory, no prompt versioning; it's a single-shot "build a KnowledgeContext, call a provider, log it" pipeline). Building that surface *inside* `services/ai/` would mean either half-implementing it around code with a different shape, or quietly rewriting that code — both against this phase's rules. A new, self-contained module was the only option that satisfies "build the foundation" and "don't touch existing business logic" simultaneously. The two modules currently duplicate a few concepts by necessity (each has its own `AIProvider`/`LLMProvider` interface, its own error hierarchy, its own Prometheus metrics under different name prefixes) — a future phase that decides to migrate `services/ai/`'s callers onto `src/ai/` would retire the older one rather than run both indefinitely; that migration is out of scope here.

**Module layout** (`apps/api/src/ai/`):

```
errors/      AIError base + LLMError/ProviderError/RateLimitError/ToolExecutionError/
             ParsingError/PromptError/MemoryError — same flat `extends Error` shape as
             every other error hierarchy in this codebase (see services/auth/errors.ts)
config/      AIFoundationConfig — reuses the existing config.ai (no second env parse),
             adds foundation-only defaults (temperature/topP/streaming) and provider
             config for two providers env.ts doesn't define (Ollama, Azure OpenAI)
interfaces/  LLMProvider, MemoryStore, LongTermMemory, AITelemetryRecorder — the
             contracts everything else in this module is written against
llm/         LLMProviderFactory/LLMProviderRegistry (DI: constructor-injected config,
             not module-level singletons) + LLMClient (retry-with-backoff + telemetry
             wrapper around any provider). One concrete provider (OpenAIProvider — raw
             fetch, same hand-rolled style as services/ai/providers/*, no new SDK
             dependency) plus four interface-only placeholders (Anthropic/Gemini/Ollama/
             AzureOpenAI) that fully implement LLMProvider but reject generate()/
             stream() with a ProviderError until a future phase implements them
prompts/     PromptTemplate ({{variable}} substitution + zod validation) +
             PromptRegistry (id+version keyed; get(id) resolves latest, get(id, v) pins)
parser/      parse/tryParse/parseWithRetry — JSON-fence-stripping, zod-validated
             structured-output parsing, with a caller-supplied repair() callback for
             retry-on-malformed-response
tools/       ToolRegistry — name/description/inputSchema/outputSchema/execute()
             contract, validated at one execute() call path. No concrete tools
             registered — interfaces and the registry only, per spec
context/     buildAIContext/recordExecutionStep — the shared AIContext (user/session/
             asset/conversation metadata/workflow/tool history/execution history)
memory/      InMemoryStore (process-local, TTL-aware) + RedisMemoryStore (the existing
             cache/redis.ts singleton, namespaced ai:memory:* keys) behind one
             MemoryStore interface; ConversationMemory/SessionMemory built on top.
             LongTermMemory is declared (interfaces/memory-store.interface.ts) but not
             implemented — infrastructure only, per spec
telemetry/   AITelemetry — Prometheus counters/histograms in the existing shared
             metricsRegistry under estateai_ai_foundation_* names (distinct from
             services/ai/'s estateai_ai_* names — see the doc-debt note in
             PROJECT_PROGRESS.md about the resulting two-metric-family split), plus
             structured logs via the existing shared pino logger
types/       Shared TS types (LLMRequest/LLMResponse/LLMStreamChunk, AIContext,
             PromptTemplateDefinition, ToolDefinition, ConversationTurn, ...)
utils/       withRetry (exponential backoff) + maskSecret/maskSecretsInObject
foundation.ts  createAIFoundation() — the composition root: wires config → provider
             factory/registry → LLMClient → prompt/tool registries → Redis-backed
             memory with real dependencies, constructor-injected throughout so tests
             can pass fakes. Exported as `aiFoundation`; nothing imports it yet.
```

**Design decisions worth calling out:**
- **Dependency injection is constructor injection, not a DI container.** Every class (`LLMProviderFactory`, `LLMProviderRegistry`, `LLMClient`, `ConversationMemory`, `SessionMemory`, `AITelemetry`) takes its dependencies as constructor arguments — matching this codebase's existing convention of plain classes/singletons (no `inversify` or equivalent exists anywhere in the project) while still making every piece swappable in a test.
- **Only OpenAI is a real provider**, per the phase spec ("Only implement OpenAI initially. Other providers should have interfaces/placeholders."). This is independent of `AI_PROVIDER` in `env.ts` (which selects among `claude`/`openai`/`gemini` for the unrelated `services/ai/` system) — `src/ai/`'s default provider is hardcoded to `openai` regardless of that env var, since it's the only one this module can actually call.
- **The tool framework ships with zero tools.** `ToolRegistry` validates input/output against a tool's own zod schemas and records execution history, but no `ToolDefinition` is registered anywhere — the first future agent that needs a tool (e.g. a Discovery Agent's "list GitHub repos") registers it there.
- **`RedisMemoryStore` reuses the existing Redis connection** (`cache/redis.ts`'s singleton) rather than opening a second connection pool, namespaced under `ai:memory:*` to avoid key collisions with job queues, rate limiting, or anything else sharing that Redis instance.
- **No unit-test framework exists in this project** (no jest/vitest in `package.json`) — `scripts/verify-ai-foundation.ts` follows the same in-process `createChecker()` convention every other `verify:*` script uses, run without a live API server since this module has no HTTP routes.

## Orchestrator Agent (Phase 17)

`apps/api/src/ai/orchestrator/` is the coordination layer built on top of Phase 16's AI foundation — it understands intent, plans a workflow, executes it against registered agents, tracks state, and aggregates results. It never performs discovery/risk/compliance/recommendation/reporting itself, only coordinates: the six agent roles those tasks map to (Discovery/Risk/Compliance/Recommendation/Report/Copilot) exist only as placeholder TypeScript interfaces this phase does not implement.

**Why a third orchestrator instead of extending `services/agents/`.** This codebase already has a working orchestrator — `services/agents/` (Phase 7A): `AgentOrchestrator`, `agentRegistry`, a `planner.service.ts`/`task.service.ts` (wave-based execution), and five concrete, shipped agents behind `POST /agents/execute`. Phase 17's rules forbid touching that business logic, and forbid implementing any of the six named agents — but its spec also calls for a *different* orchestrator, one built on the Phase 16 AI-foundation primitives (`aiFoundation.llmClient`/`toolRegistry`/`conversationMemory`, none of which `services/agents/` was built to consume) with capabilities `services/agents/` doesn't have: a dynamic runtime agent registry (vs. `services/agents/`'s agents registered once at module load), Redis-persisted cross-process execution state (vs. `services/agents/`'s synchronous in-request-only execution, audited to Postgres only after the fact), and a background task queue. Building that inside `services/agents/` would mean rewriting its execution model; building it as a new, parallel module under `src/ai/` — matching Phase 16's own precedent for coexisting with `services/ai/` — was the option that satisfies both "add the new capability" and "don't touch existing business logic."

This creates a third parallel "orchestrator" concept (after Phase 16's two parallel AI stacks): `orchestratorAgentRegistry` (new, empty) alongside the pre-existing `agentRegistry` (`services/agents/`, populated), and a third Prometheus metric family, `estateai_ai_orchestrator_*`, alongside `estateai_ai_*` (legacy) and `estateai_ai_foundation_*` (Phase 16). This duplication is deliberate and documented, not accidental — see `PROJECT_PROGRESS.md`'s doc-debt list. A future migration phase, once real agents exist under `orchestratorAgentRegistry` to justify the choice, would be the natural point to consolidate all three "AI/agent" subsystems onto one.

**Module layout** (`apps/api/src/ai/orchestrator/`):

```
errors/                 OrchestratorError base (extends Phase 16's AIError) +
                         WorkflowError/PlanningError/TaskExecutionError/
                         AgentNotRegisteredError/WorkflowTimeoutError/
                         WorkflowCancelledError
agents/                 OrchestratorAgent base interface (id/description/canHandle()/
                         execute()) + six placeholder interfaces — DiscoveryAgent/
                         RiskAgent/ComplianceAgent/RecommendationAgent/ReportAgent/
                         CopilotAgent — describing each future agent's input/output
                         shape. Zero implementations, per spec.
agent-registry.ts       OrchestratorAgentRegistry — register()/unregister()/get()/
                         list()/isRegistered(). Exported as `orchestratorAgentRegistry`
                         (named apart from services/agents/'s `agentRegistry` to avoid
                         ambiguity). Empty at the end of this phase.
workflow.engine.ts      WorkflowEngine — partitions a WorkflowDefinition's steps into
                         dependency "waves" (Kahn's algorithm, reimplemented
                         independently of services/agents/task.service.ts's equivalent
                         since this module must not import from services/agents/) so
                         independent steps run in parallel (Promise.all) and dependent
                         steps wait for a later wave. Supports conditional (skip) steps,
                         per-step retry (Phase 16's withRetry, exponential backoff) and
                         timeout (Promise.race), cooperative cancellation (AbortSignal).
                         An unregistered agent fails only its own step, never the run.
                         buildWorkflowVisualization() emits a node/edge graph.
workflow.registry.ts    WorkflowRegistry — register()/unregister()/get()/list()/has().
                         Seeded with 3 default templates (full-security-analysis,
                         risk-only, compliance-only) shaped around the six placeholder
                         agent roles — configuration only.
planner.ts              Planner.createPlan() — maps a free-form intent (or a workflow
                         id passed directly) to a registered WorkflowDefinition via
                         keyword matching, not an LLM call in this phase. Only selects
                         and describes a plan; never executes business logic.
executor.ts             Executor.run() — resolves a plan's WorkflowDefinition, drives
                         WorkflowEngine, mirrors every step result into the shared
                         OrchestrationContext and StateManager, aggregates successful
                         outputs by agentId into ExecutionResult.data, records a summary
                         into ExecutionHistory.
state.manager.ts        StateManager — workflow id/current step/completed+failed
                         steps/retry count/timing/status/shared context per execution,
                         persisted through the injected MemoryStore (Phase 16's
                         RedisMemoryStore in production) so state survives restarts and
                         is cross-process-readable.
task.queue.ts           TaskQueue — background execution for orchestrator agent steps,
                         built on the existing SyncJob queue (Postgres-durable + Redis
                         fast-path), not BullMQ (confirmed zero existing usage anywhere
                         in this codebase). Adds one JobType key
                         (AI_ORCHESTRATOR_AGENT_TASK); no dispatcher handler registered
                         yet — future-phase work once a concrete agent exists to invoke.
execution.context.ts    OrchestrationContext — user/organization/connected accounts/
execution.result.ts     assets/workflow/conversation/agent outputs/tool outputs/
execution.history.ts    previous decisions/memory references; ExecutionResult/
                         AgentTaskResult; an append-only ExecutionHistory log.
telemetry.ts            OrchestratorTelemetry — Prometheus counters/histograms under
                         estateai_ai_orchestrator_* names in the existing shared
                         metricsRegistry, plus structured logs via the shared logger.
orchestrator.service.ts OrchestratorService (implements orchestrator.interface.ts) —
orchestrator.interface.ts  the public entry point: execute()/cancel()/getStatus()/
orchestrator.ts          listWorkflows()/getWorkflow()/getHistory(). orchestrator.ts is
                         the composition root (createOrchestrator()), mirroring Phase
                         16's foundation.ts pattern.
```

New routes (`apps/api/src/routes/orchestrator.ts`, registered after `aiRoutes` in `server.ts`): `POST /ai/orchestrator/execute`, `GET /ai/orchestrator/workflows`, `GET /ai/orchestrator/workflows/:id` (includes `buildWorkflowVisualization()`'s graph), `GET /ai/orchestrator/history`, `GET /ai/orchestrator/status` (optionally `?executionId=` for one run's live state).

**Design decisions worth calling out:**
- **No BullMQ.** The Phase 17 spec asked for BullMQ integration, but this codebase has zero existing BullMQ usage — job queuing here is entirely the hand-rolled `SyncJob` Postgres+Redis polling system (`workers/worker.ts`, `services/jobs/`). Introducing BullMQ fresh would add a second, parallel job-queue system with no existing convention to match; building `TaskQueue` on `SyncJob` instead reuses durable retry/priority/dead-letter semantics the project already has and keeps this phase additive rather than introducing new infrastructure duplication on top of the duplication already noted above.
- **`WorkflowEngine`'s dependency-wave partitioning is deliberately reimplemented, not imported**, even though `services/agents/task.service.ts` already does the same Kahn's-algorithm technique — this module must not depend on `services/agents/` (see the "why a third orchestrator" note above), so a few dozen lines of duplication were preferred over a cross-boundary import.
- **The Planner does not call an LLM in this phase** — intent-to-workflow mapping is simple keyword regex. `ExecutionPlan`'s shape is designed so a future LLM-driven planner (using `aiFoundation.llmClient`) can replace the matching step without changing `Executor` or anything downstream.
- **`orchestratorAgentRegistry` shipped empty in Phase 17.** `WorkflowEngine` treats an unregistered agent as a normal, recoverable per-step failure (`AgentNotRegisteredError`, surfaced as a `FAILED` step with a clear message), not a thrown exception — so `POST /ai/orchestrator/execute` against any seeded workflow returned a well-formed `FAILED` `ExecutionResult` rather than a 500. Phase 18 registered the first real agent (`discovery-agent`), Phase 19 the second (`risk-agent`), Phase 20 the third (`compliance-agent`), Phase 21 the fourth and fifth (`recommendation-agent`, `report-agent`), and Phase 22 the sixth and last (`copilot-agent`) — see "Discovery Agent (Phase 18)", "Risk Agent (Phase 19)", "Compliance Agent (Phase 20)", "Multi-Agent Collaboration (Phase 21)", and "Copilot Agent (Phase 22)" below — proving out exactly the registration path this design anticipated. All six of the original placeholder roles are now real; `risk-only`, `compliance-only`, and `full-security-analysis` all complete end-to-end.
- **No unit-test framework exists in this project** — `scripts/verify-orchestrator.ts` follows the same in-process `createChecker()` convention, registering throwaway fake agents (never any of the six named future agents) to prove the engine works end to end.

## Discovery Agent (Phase 18)

`apps/api/src/ai/agents/discovery/` is the first concrete `OrchestratorAgent` — it registers into Phase 17's `orchestratorAgentRegistry` under id `discovery-agent`, so the three workflows already seeded in `workflow.registry.ts` become runnable for their first step. It discovers digital assets only: no risk analysis, compliance evaluation, recommendations, or reporting, and it never calls another `OrchestratorAgent` directly (it has no import of, or reference to, `orchestratorAgentRegistry.get()` anywhere in its own code).

**Why every real operation goes through tools that wrap the existing `DiscoveryService`, not new GitHub API calls.** The Phase 18 spec is explicit: "DO NOT rewrite or replace any existing discovery logic. Reuse the existing Discovery Service through tools... No duplicated API logic." `services/discovery/discovery.service.ts` (Phase 4) and its one real provider, `GitHubDiscoveryProvider` (Phase 4), are untouched — the agent's tools call `discoveryService.discover()` and read already-persisted `Resource` rows, they never call `fetch()` against GitHub themselves. This does mean the agent's tool coverage is bounded by what `GitHubDiscoveryProvider` already fetches (`/user`, `/user/repos`, `/user/orgs` — no branches, contributors, releases, Actions workflows, security advisories, or secret scanning) — the spec's full example tool list (`GitHubBranchTool`, `GitHubContributorTool`, etc.) is still registered so the tool surface and its schemas exist for a future phase to implement against, but those six tools reject at call time rather than either faking data or reaching around the existing provider to add new, unreviewed GitHub API logic outside this phase's stated scope. This mirrors the precedent Phase 16 set for its four interface-only LLM provider placeholders (`AnthropicProvider`/`GeminiProvider`/`OllamaProvider`/`AzureOpenAIProvider`).

**Module layout** (`apps/api/src/ai/agents/discovery/`):

```
github.tool.ts        10 ToolDefinitions registered into aiFoundation.toolRegistry:
                       github_discover_repositories (the only tool that triggers a real
                       discovery run, via unchanged discoveryService.discover()) plus 3
                       read-only tools (github_list_organizations/
                       github_summarize_languages/github_summarize_topics) that shape
                       already-persisted Resource rows without re-triggering discovery,
                       plus 6 placeholders (branches/contributors/releases/workflows/
                       security advisories/secret scanning) that reject with a clear
                       ToolExecutionError.
provider.registry.ts  discoveryToolProviderRegistry — describes which providers the
                       AGENT's tool layer covers (github: implemented, all 10 tools;
                       gitlab/bitbucket/aws/azure/gcp/docker-hub/kubernetes: declared,
                       zero tools) — distinct from the pre-existing
                       discoveryProviderRegistry (services/discovery/), which still
                       governs real discovery execution and is unaware this registry
                       exists.
discovery.executor.ts DiscoveryExecutor — determines the provider (throws
                       UnsupportedAgentProviderError, a permanent failure, if not
                       implemented in provider.registry.ts), calls the repository tool
                       (retried via Phase 16's withRetry), calls the language/topic
                       tools (failure degrades to a warning, not a failed run),
                       computes a deterministic confidence score, generates a
                       best-effort AI summary (falls back to a deterministic string
                       with no LLM provider configured), records the outcome into
                       DiscoveryMemory/telemetry.
discovery.agent.ts    DiscoveryAgentImpl implements Phase 17's DiscoveryAgent
                       placeholder interface for real.
discovery.memory.ts   DiscoveryMemory — built on Phase 16's MemoryStore. Remembers
                       last discovery, discovery history, failed discoveries,
                       previously-discovered resource ids, provider metadata; all
                       per-account.
discovery.prompts.ts  classifyDiscoveryIntent() (keyword matching, informational only
                       — see Planner's identical philosophy in Phase 17) +
                       discoverySummaryPrompt (the PromptTemplate behind the
                       executor's best-effort AI summary).
discovery.telemetry.ts  DiscoveryAgentTelemetry — estateai_ai_discovery_agent_* metrics.
discovery.errors.ts   DiscoveryAgentError base (extends AIError) + UnsupportedAgentProviderError.
discovery.types.ts, discovery.schemas.ts, discovery.interface.ts, discovery.context.ts
                       shared types, zod schemas (also used as every tool's
                       inputSchema/outputSchema), class-level contracts, and the
                       OrchestrationContext -> AIContext bridge (the two context types
                       Phase 16 and Phase 17 each own — see "Agentic AI Foundation"
                       and "Orchestrator Agent" above for why they're distinct).
index.ts               Composition root + self-registration — mirrors
                       services/agents/agents/index.ts's established
                       side-effect-import pattern: importing this module registers
                       the tools into aiFoundation.toolRegistry and the agent into
                       orchestratorAgentRegistry.
```

New routes (`apps/api/src/routes/discovery.ts`, registered after `orchestratorRoutes` in `server.ts`): `POST /ai/discovery/start`, `POST /ai/discovery/refresh`, `GET /ai/discovery/history`, `GET /ai/discovery/status`, `GET /ai/discovery/providers` — same async-enqueue contract (202 + `{jobId}`, poll `GET /jobs/:id`) as the pre-existing `POST /accounts/:id/discover`.

**A real circular import, found and fixed during this phase.** `observability/metrics.ts` eagerly imports `workerPool` (for its job-queue gauge) → `workers/worker.ts` → `services/jobs/job-executor.ts` → `services/jobs/job-dispatcher.ts`. This phase's `AI_DISCOVERY` job handler needs to call the Discovery Agent, and the Discovery Agent's own telemetry module imports `observability/metrics.ts` directly — a static top-level `import { discoveryAgent } from '../../ai/agents/discovery/index.js'` in `job-dispatcher.ts` would therefore close a real cycle, and did: it threw `ReferenceError: Cannot access 'metricsRegistry' before initialization` at process startup, caught by this phase's own `verify:discovery-agent` run before ever reaching a route. Fixed with a dynamic `import()` inside the job handler function body instead of a static one — resolved only once the module graph has finished initializing, so it never touches the cycle. `job-dispatcher.ts`'s own top-of-file comment already documents "adding a new job type means registering one more handler here"; this is the one wrinkle worth remembering if a future agent module both ships its own Prometheus telemetry and needs to be called from `job-dispatcher.ts`.

**Design decisions worth calling out:**
- **`UnsupportedAgentProviderError` is thrown, not folded into a graceful result** — the one place this agent deviates from "always return, never throw." An unimplemented provider is a structural problem resolved before any tool call, exactly like `discoveryProviderRegistry.getProvider()`'s `UnsupportedDiscoveryProviderError` for the underlying service — so `job-executor.ts`'s `isPermanentFailure()` gained one additive `instanceof` check for it, giving an `AI_DISCOVERY` job for an unimplemented provider the same "fail immediately, don't retry" treatment the plain `DISCOVERY` job type already has.
- **Tool-call-level failures still degrade gracefully.** `discoveryService.discover()` itself already catches provider/credential/network failures into a `success: false` result rather than throwing (see "Discovery → Resource → Graph..." above) — the agent's own `github_discover_repositories` tool result reflects that faithfully, and the executor turns a `success: false` tool result into a well-formed `FAILED` `DiscoveryAgentOutput`, not a thrown exception. Only the pre-flight "is this provider implemented at all" check throws.
- **Relationship building is not reimplemented.** `discoveryService.discover()` already calls `relationshipService.extractAndPersist()` internally — the agent's output surfaces the resulting `{created, updated, unchanged}` counts, it never constructs edges itself.
- **The confidence score is a deterministic heuristic** (1.0 clean success, 0.75 with warnings, 0.5 with partial errors, 0.4 for a failure that still discovered something, 0 for total failure) — not a model-derived score. Documented as such rather than implying more sophistication than exists.
- **No unit-test framework exists in this project** — `scripts/verify-discovery-agent.ts` follows the same in-process `createChecker()` convention, reusing `verify-discovery.ts`'s exact mock-GitHub-server approach for its HTTP end-to-end part.

## Risk Agent (Phase 19)

`apps/api/src/ai/agents/risk/` is the second concrete `OrchestratorAgent` — it registers into `orchestratorAgentRegistry` under id `risk-agent`, implementing Phase 17's placeholder `RiskAgent` interface for real. It analyzes discovered resources for security risk (explains why a risk exists, estimates business impact, prioritizes findings) — no discovery, compliance evaluation, recommendations, or reporting, and it never calls another `OrchestratorAgent` directly.

**Why every score/finding comes from tools that wrap the existing `RiskService`/`FindingService`, not new calculations.** The Phase 19 spec is explicit: "DO NOT rewrite or replace any existing Risk Engine. Reuse the existing Risk Engine through AI Tools... The LLM must NOT calculate risk scores itself. Existing backend logic remains the source of truth." `services/analysis/risk.service.ts`/`finding.service.ts`/`rule-engine.ts` (Phase 6A) are untouched — the agent's tools call `riskService.getForAsset()`/`findingService.list()` and read already-persisted `RiskScore`/`Finding` rows; severity, confidence, and the overall score are always copied verbatim, never recomputed anywhere in this agent's code. This bounds the agent's tool coverage to what the existing rule engine already evaluates (`services/analysis/rules/github/`: repository visibility/archived/empty/description/topics — no secrets, branch protection, workflow permissions, dependency vulnerabilities, or security advisories yet), so the spec's fuller example tool list (`SecretsScannerTool`, `BranchProtectionTool`, etc.) is still registered for schema/name stability, but those 5 tools reject at call time — the same placeholder pattern Discovery Agent established for its own 6 GitHub tools the underlying provider doesn't fetch.

**Module layout** (`apps/api/src/ai/agents/risk/`):

```
risk.tool.ts          9 ToolDefinitions registered into aiFoundation.toolRegistry:
                       risk_engine_score/risk_asset_lookup/risk_finding_store_list/
                       risk_repository_aggregate (real, read the existing
                       RiskScore/Finding/Resource rows, never recalculate) plus 5
                       placeholders (secrets scanner/branch protection/workflow
                       risk/dependency risk/security alert) that reject with a
                       clear ToolExecutionError.
risk.finding.ts       buildFindingView() — deterministic, ruleCode-keyed
                       explanation/evidence dictionary that turns an existing
                       Finding row into the agent's structured RiskFindingView
                       (reasoning, evidence, priority, business impact); severity
                       and confidence are copied verbatim from the persisted row.
                       groupBySeverity() buckets findings into critical/high/
                       medium/low for the agent's output shape.
risk.scoring.ts       toSeverityCounts()/businessImpactFromCounts() — format the
                       existing RiskScore row and derive a deterministic
                       business-impact label (worst-severity-wins) from
                       already-computed counts; never recomputes the score.
risk.executor.ts      RiskExecutor — resolves the target asset (falls back to
                       OrchestrationContext.assets[0] when the workflow step's
                       input is empty, so risk-only's unconfigured step input
                       still works), calls risk_engine_score/
                       risk_finding_store_list (retried via Phase 16's
                       withRetry), shapes findings via risk.finding.ts,
                       optionally rephrases the top 5 findings and generates a
                       narrative summary via the LLM (graceful fallback),
                       records the outcome into RiskMemory/telemetry.
risk.agent.ts          RiskAgentImpl implements Phase 17's RiskAgent placeholder
                       interface for real.
risk.memory.ts         RiskMemory — built on Phase 16's MemoryStore. Remembers
                       last analysis, analysis history, failed analyses,
                       historical risk-score snapshots, previously-seen rule
                       codes (drives the `repeated` finding flag), and an
                       agent-side "acknowledged findings" overlay (Finding has
                       no acknowledgement column — this doesn't add one).
risk.prompts.ts        riskSummaryPrompt/riskFindingExplanationPrompt (Phase 16
risk.summary.ts        PromptTemplates) + generateRiskSummary()/
                       explainTopFindings() — the LLM's entire surface area:
                       narrate, group, prioritize in prose, summarize. Every
                       function falls back to deterministic text on any LLM
                       failure, so structured output never depends on an LLM
                       being configured.
risk.telemetry.ts      RiskAgentTelemetry — estateai_ai_risk_agent_* metrics
                       (runs, duration, findings by severity, tool calls, LLM
                       call duration/token usage, retries).
risk.errors.ts         RiskAgentError base (extends AIError) + MissingRiskTargetError.
risk.types.ts, risk.schemas.ts, risk.interface.ts, risk.context.ts
                       shared types, zod schemas (also used as every tool's
                       inputSchema/outputSchema), class-level contracts, and the
                       OrchestrationContext -> AIContext bridge (same pattern
                       Discovery Agent's discovery.context.ts established).
index.ts               Composition root + self-registration — mirrors
                       discovery/index.ts's established pattern: importing this
                       module registers the tools into aiFoundation.toolRegistry
                       and the agent into orchestratorAgentRegistry.
```

New routes (`apps/api/src/routes/risk-agent.ts`, registered after `discoveryRoutes` in `server.ts`): `POST /ai/risk/analyze`, `GET /ai/risk/history`, `GET /ai/risk/findings`, `GET /ai/risk/summary` — same async-enqueue contract (202 + `{jobId}`, poll `GET /jobs/:id`) as `/ai/discovery/*`. `/ai/risk/findings` reuses the existing `findingService.list()` and adds `risk.finding.ts`'s reasoning/evidence/priority shaping on top — it does not replace or duplicate `GET /analysis/findings`, which remains the raw, un-shaped view.

**The same circular-import shape recurred, fixed the same way pre-emptively.** `observability/metrics.ts` eagerly imports `workerPool` → `workers/worker.ts` → `services/jobs/job-executor.ts` → `services/jobs/job-dispatcher.ts`. This phase's `AI_RISK` job handler needs to call the Risk Agent, and the Risk Agent's own `risk.telemetry.ts` imports `observability/metrics.ts` directly — a static top-level import of `ai/agents/risk/index.js` in `job-dispatcher.ts` would close the exact same cycle Phase 18 hit. Fixed identically: a dynamic `import()` inside the `AI_RISK` job handler function body instead of a static one, applied from the start rather than discovered by a failing test run this time.

**Design decisions worth calling out:**
- **`MissingRiskTargetError` is thrown, not folded into a graceful result** — mirrors Discovery Agent's `UnsupportedAgentProviderError` treatment. An empty/unresolvable assetId is a structural problem resolved before any tool call, so `job-executor.ts`'s `isPermanentFailure()` gained one additive `instanceof` check, giving an `AI_RISK` job with no valid target the same "fail immediately, don't retry" treatment.
- **Tool-call-level failures still degrade gracefully.** A `risk_engine_score`/`risk_finding_store_list` failure produces a well-formed `FAILED` `RiskAgentOutput` (recorded to `RiskMemory.recordFailure()`), not a thrown exception; LLM enrichment failures degrade to a `PARTIAL` status with a warning, since the deterministic findings/score are already complete without it.
- **The business-impact label is a deterministic worst-severity-wins mapping** off of already-computed severity counts (SEVERE/HIGH/MODERATE/LOW/MINIMAL) — not a model judgment call, same "documented heuristic, not implied sophistication" precedent as Discovery Agent's confidence score.
- **LLM enrichment is bounded to the top 5 findings** (`risk.summary.ts`'s `MAX_LLM_EXPLAINED_FINDINGS`) for predictable latency/cost — every other finding still carries its full deterministic reasoning from `risk.finding.ts`'s rule dictionary, just not rephrased in prose.
- **No unit-test framework exists in this project** — `scripts/verify-risk-agent.ts` follows the same in-process `createChecker()` convention, first running a real discovery (via `POST /accounts/:id/discover`) to populate a real `PUBLIC_REPOSITORY` finding for the Risk Agent to analyze, since this phase's input is Discovery's output.

## Compliance Agent (Phase 20)

`apps/api/src/ai/agents/compliance/` is the third concrete `OrchestratorAgent` — it registers into `orchestratorAgentRegistry` under id `compliance-agent`, implementing Phase 17's placeholder `ComplianceAgent` interface for real. It evaluates discovered resources/findings against four compliance frameworks (NIST CSF, CIS Controls, ISO 27001, SOC2) — no discovery, risk scoring, recommendations, or reporting, and it never calls another `OrchestratorAgent` directly (specifically, it never calls the Recommendation Agent, matching the spec's explicit "Workflow becomes: Discovery → Risk → Compliance. No direct calls to Recommendation Agent").

**Why every compliance score comes from tools that wrap the existing `ComplianceService`/`PolicyService`, not new calculations.** The Phase 20 spec is explicit: "DO NOT rewrite any existing Compliance Engine... The LLM MUST NOT determine compliance scores itself. Existing backend logic remains the source of truth." `services/policy/compliance.service.ts`/`policy.service.ts`/`policy-engine.ts` (Phase 6B) are untouched — the agent's tools call `complianceService.getForAsset()` and read already-persisted `PolicyResult`/`Policy` rows; `complianceScore` is always copied verbatim, never recomputed anywhere in this agent's code.

**The one genuinely new capability this phase introduces: framework/control mapping.** A full-codebase search before writing any code confirmed neither the Prisma schema nor any existing service has a NIST CSF/CIS Controls/ISO 27001/SOC2 concept — `Policy`/`PolicyResult` only know about generic policy codes and pass/fail/warning/not-applicable status. `compliance.mapping.ts` is the one place this phase introduces framework/control mapping, as a static, code-owned data layer: each of the 5 existing GitHub policy codes (`services/policy/policies/github/*.policy.ts`, unchanged) maps to one control per framework, and each framework's fuller control catalog (controls with no mapped policy) surfaces as `MISSING` — an honest coverage gap, not a fabricated pass. This is documented as an illustrative mapping, not a certified auditor crosswalk. Critically, this mapping table is **read-only reshaping of already-computed PASS/FAIL data** — it never re-implements `ComplianceService`'s own score formula (`applicable === 0 ? 100 : round(100 * (pass + warning*0.5) / applicable)`); per-framework "coverage" is a distinct, clearly-separate metric (`coveragePercent` — how much of a framework's catalog has *any* policy mapped to it) from the one true `complianceScore`, which is always the top-level `ComplianceReport`'s own number, copied verbatim.

**Module layout** (`apps/api/src/ai/agents/compliance/`):

```
compliance.mapping.ts  Static framework/control catalogs (FRAMEWORK_CONTROLS) and the
                       policyCode -> controls mapping (POLICY_CONTROL_MAP), covering
                       NIST_CSF/CIS_CONTROLS/ISO_27001/SOC2. catalogForFramework(),
                       controlsForPolicy(), listFrameworks(), ALL_FRAMEWORKS. Adding a
                       fifth framework means adding one catalog array here — nothing
                       in compliance.executor.ts/compliance.agent.ts branches on a
                       specific framework name.
compliance.tool.ts    8 ToolDefinitions registered into aiFoundation.toolRegistry:
                       compliance_engine_evaluate/compliance_policy_lookup/
                       compliance_finding_lookup/compliance_asset_lookup (real, thin
                       reads over unchanged ComplianceService/PolicyService/
                       FindingService/resourceRepository) plus
                       compliance_framework_mapping/compliance_control_coverage/
                       compliance_evidence/compliance_store (real, join already-
                       persisted PolicyResult/Policy rows against the static mapping
                       table). Unlike Discovery/Risk Agents, NO tool here is a
                       call-time-rejecting placeholder — framework mapping is
                       agent-owned data, not bounded by an external provider's API
                       surface, so every framework is fully functional this phase.
compliance.executor.ts ComplianceExecutor — calls the compliance report tool
                       (retried via withRetry), then for every framework in
                       ALL_FRAMEWORKS calls the control-coverage tool to build
                       passed/failed/missing control views, optionally enriches the
                       top gaps and generates a narrative summary via the LLM
                       (graceful fallback), records the outcome into
                       ComplianceMemory/telemetry. One framework's coverage
                       computation failing degrades to a warning (PARTIAL status),
                       not a failed run — the core compliance report already
                       succeeded and remains authoritative.
compliance.agent.ts    ComplianceAgentImpl implements Phase 17's ComplianceAgent
                       placeholder interface for real, falling back to
                       OrchestrationContext.assets[0] when the workflow step's
                       input is empty (mirrors RiskAgentImpl's Phase 19 pattern).
compliance.memory.ts   ComplianceMemory — built on Phase 16's MemoryStore. Remembers
                       last assessment, assessment history, failed assessments,
                       historical compliance-score snapshots, previously-seen
                       violation policy codes; all per-asset.
compliance.prompts.ts  complianceSummaryPrompt/complianceGapExplanationPrompt +
compliance.summary.ts  generateComplianceSummary()/explainTopGaps() — the LLM's
                       entire surface area (explain gaps, summarize missing
                       controls, generate evidence summaries, explain why controls
                       fail, generate narratives). Every function falls back to
                       deterministic text on any LLM failure.
compliance.telemetry.ts ComplianceAgentTelemetry — estateai_ai_compliance_agent_*
                       metrics (runs, duration, frameworks evaluated, controls
                       checked by status, violations, tool calls, LLM
                       duration/tokens, retries).
compliance.errors.ts   ComplianceAgentError base (extends AIError) +
                       MissingComplianceTargetError.
compliance.types.ts, compliance.schemas.ts, compliance.interface.ts, compliance.context.ts
                       shared types, zod schemas (also used as every tool's
                       inputSchema/outputSchema), class-level contracts, and the
                       OrchestrationContext -> AIContext bridge (same pattern
                       Discovery/Risk Agents' own *.context.ts established).
index.ts               Composition root + self-registration — mirrors risk/index.ts's
                       established pattern: importing this module registers the
                       tools into aiFoundation.toolRegistry and the agent into
                       orchestratorAgentRegistry.
```

New routes (`apps/api/src/routes/compliance-agent.ts`, registered after `riskAgentRoutes` in `server.ts`): `POST /ai/compliance/analyze`, `GET /ai/compliance/history`, `GET /ai/compliance/summary`, `GET /ai/compliance/frameworks` — same async-enqueue contract (202 + `{jobId}`, poll `GET /jobs/:id`) as `/ai/risk/*`. `frameworks` is unscoped introspection (mirrors `GET /ai/discovery/providers`), listing every framework as fully implemented — there is no "not implemented" filter needed here, unlike Discovery's provider registry.

**The same circular-import shape recurred a third time, fixed the same way pre-emptively.** `observability/metrics.ts` eagerly imports `workerPool` → `workers/worker.ts` → `services/jobs/job-executor.ts` → `services/jobs/job-dispatcher.ts`. This phase's `AI_COMPLIANCE` job handler needs to call the Compliance Agent, and the Compliance Agent's own `compliance.telemetry.ts` imports `observability/metrics.ts` directly — a static top-level import of `ai/agents/compliance/index.js` in `job-dispatcher.ts` would close the exact same cycle Phase 18/19 hit. Fixed identically, and applied from the start rather than discovered by a failing test run.

**Design decisions worth calling out:**
- **`MissingComplianceTargetError` is thrown, not folded into a graceful result** — mirrors Risk Agent's `MissingRiskTargetError` treatment. An empty/unresolvable assetId is a structural problem resolved before any tool call, so `job-executor.ts`'s `isPermanentFailure()` gained one additive `instanceof` check.
- **`coveragePercent` is deliberately NOT a second compliance score.** It answers "how much of this framework's control catalog has at least one policy mapped to it" — a data-coverage ratio computed purely from the static catalog and the mapping table, never blended with or presented as an alternative to the one true `complianceScore` from `ComplianceReport`.
- **Tool-call-level failures still degrade gracefully.** A `compliance_engine_evaluate` failure produces a well-formed `FAILED` `ComplianceAgentOutput` (recorded to `ComplianceMemory.recordFailure()`), not a thrown exception; a single framework's `compliance_control_coverage` call failing degrades that one framework's contribution to a warning (`PARTIAL` status) rather than failing the whole run.
- **LLM enrichment is bounded to the top 5 gaps per framework** (`compliance.summary.ts`'s `MAX_LLM_EXPLAINED_GAPS`), same predictable-latency/cost reasoning as Risk Agent's `MAX_LLM_EXPLAINED_FINDINGS`.
- **No unit-test framework exists in this project** — `scripts/verify-compliance-agent.ts` follows the same in-process `createChecker()` convention, first running a real discovery against a public/undocumented/topic-less repository (triggering several existing GitHub policy failures) for the Compliance Agent to assess.

## Multi-Agent Collaboration (Phase 21)

Upgrades Discovery/Risk/Compliance from independently-invoked `OrchestratorAgent` steps into an actually-collaborating DAG, and fills in the fourth and fifth of the six `src/ai/orchestrator/agents/` placeholder roles for real: `apps/api/src/ai/agents/recommendation/` (`recommendation-agent`) and `apps/api/src/ai/agents/report/` (`report-agent`). No LangGraph package is used or introduced — the codebase's "LangGraph Router/Supervisor" terminology (used descriptively in this and prior specs) maps onto the fully custom `WorkflowEngine`/`OrchestrationContext`/`orchestratorAgentRegistry` stack Phase 17 already built; this phase extends that stack rather than forking a second orchestration system.

**Recommendation Agent never generates a recommendation.** It wraps the pre-existing `services/analysis/recommendation.service.ts`/`recommendation.repository.ts` (unchanged since Phase 6A — one `Recommendation` row per `Finding`, created as a side effect of `FindingService.evaluateResources()`), then enriches those rows with cross-agent references. Its core module, `recommendation.aggregate.ts`, is the first genuinely new *collaboration* mechanism in this codebase:

- `resolveHandoffFromContext()` reads the most recent SUCCESS `risk-agent`/`compliance-agent` entry straight off `OrchestrationContext.agentOutputs` — populated by `Executor.run()`'s `onStepComplete` between DAG waves (see `executor.ts`) — and adapts each into a shared `Finding` shape (`ai/shared/finding.types.ts`/`finding.adapters.ts`, new this phase).
- When Risk Agent didn't run live in the same workflow (or ran but failed), `recommendation.executor.ts` falls back to a direct `FindingService` read via its own `recommendation_finding_lookup` tool, so the agent still works standalone (e.g. invoked directly via `POST /ai/recommendation/analyze`, or through the new `discovery-recommendation` workflow that never runs Risk at all).
- Compliance has no equivalent standalone fallback (it would mean duplicating `ComplianceService` access this agent doesn't otherwise need) — a missing/failed Compliance step just means no compliance cross-references that run, never a failed run. `RecommendationHandoffSource.origin` (`'context' | 'fallback' | 'unavailable'`) records which path was actually taken, per source agent, in the output itself.
- `mergeRecommendations()` cross-references by shared `resourceId`: a risk finding and a compliance failure on the *same resource* compound into one recommendation with `relatedCompliancePolicyCodes` populated — the spec's S3-bucket example, translated into this codebase's GitHub-repository domain (a public, undocumented repo triggers both `PUBLIC_REPOSITORY`/Risk and `NO_PUBLIC_REPOSITORIES`/Compliance on the same `resourceId`).
- `aggregateConfidence()` averages each recommendation's source findings' `confidence`, with a small bonus when more than one distinct agent corroborates the same resource — a simple heuristic, documented as such, not a statistically principled combination.

**Report Agent is pure aggregation — no evaluation logic of its own.** For each of the four upstream agents, `report.executor.ts` (1) reads the live `OrchestrationContext` handoff if that step ran in this workflow, (2) falls back to that agent's own `*Memory.getLastRun(assetId)` for a standalone report call — Discovery's memory is keyed by `accountId`, not `assetId`, so it has no standalone fallback and can only ever come from a live handoff — or (3) marks the section `MISSING`, never failing the whole run over one missing/failed upstream agent. This mirrors the pre-existing, separate (non-orchestrator) `services/agents/agents/report.agent.ts`'s own "a partial report is more useful than no report" precedent, applied to the new orchestrator stack for the first time. `executive` (`overallRiskScore`/`complianceScore`/`openFindingsCount`/`recommendationCount`/`topRecommendations`) is read straight off whichever upstream outputs were available, via `applyToExecutive()`/`applyRecordToExecutive()` — never recomputed.

**Shared-state additions to the orchestrator layer itself** (`ai/orchestrator/`, not agent-specific):
- `AgentOutputEntry` (`execution.context.ts`) gained two additive, optional fields: `durationMs` (copied from the step's own `AgentTaskResult`) and `confidence` (read opportunistically off `output.confidenceScore`, a field every agent from Discovery onward exposes, via a small duck-typed `readConfidence()` helper in `executor.ts` — it imports no agent's types, keeping the orchestrator layer agent-agnostic).
- **A real, pre-existing gap was found and fixed**: `StateManager.finalize()` was persisting the *pre-run* `context` snapshot `create()` had stored in Redis at wave-start time, never the live, in-process object every agent actually mutates via `recordAgentOutput`/`recordToolOutput`/`recordDecision` as the workflow runs — so `GET /ai/orchestrator/status` was always returning an empty `agentOutputs` trace, for every workflow, since Phase 17. Fixed by adding an optional `context` parameter to `StateManager.finalize()`, which `Executor.run()` now passes its live context reference into; `finalize()` persists that instead of the stale snapshot when provided, falling back to the old snapshot for any other caller.
- `ai/shared/finding.types.ts`/`finding.adapters.ts` — a normalized `Finding` shape (`title`/`severity`/`category`/`description`/`resourceId`/`evidence`/`confidence`/`agent`/`timestamp`) that Risk/Compliance output adapts into at handoff time only. An in-memory projection built fresh on every read, never persisted, never replacing the real `Finding`/`PolicyResult` Prisma models.
- **`DiscoveryAgentImpl.execute()` gained the same context-fallback pattern** Risk/Compliance/Recommendation/Report already had for `assetId` — it previously required `input.accountId` with no fallback, but none of the pre-seeded workflows configure a static `input` for the discovery step, and `POST /ai/orchestrator/execute` has no way to configure one either. Without this fix, `full-security-analysis` could never actually complete its first step through the public API. Falls back to `context.connectedAccounts[0]?.id`.

**Failure isolation required no `WorkflowEngine` change.** The engine already never blocks a downstream step just because an upstream one failed (a pre-existing property, covered by `verify-orchestrator.ts`'s check 11 since Phase 17). What this phase adds is agents that behave well under that model: Recommendation/Report both defensively check `status === 'SUCCESS'` on every upstream `AgentOutputEntry` before trusting its `.output`, the same defensive pattern the legacy `report.agent.ts` already used for its four dependencies.

**Two new dynamic-handoff workflow templates** (`workflow.registry.ts`, no change to the three pre-existing ones): `discovery-recommendation` (Discovery → Recommendation, skipping Risk/Compliance entirely) and `risk-recommendation` (Discovery → Risk → Recommendation, never running Compliance) — proof the same DAG-wave machinery runs whichever subset of steps a workflow defines, with zero orchestrator-engine changes.

**Module layout** (new directories only; Discovery/Risk/Compliance's own layout is unchanged):

```
apps/api/src/ai/shared/
  finding.types.ts       Finding, FindingSeverity, FindingCategory — the normalized
                          cross-agent shape.
  finding.adapters.ts     findingsFromRiskOutput()/findingsFromComplianceOutput()/
                          findingsFromDiscoveryOutput() (a documented no-op — Discovery
                          produces an inventory, never a Finding).

apps/api/src/ai/agents/recommendation/
  recommendation.aggregate.ts  resolveHandoffFromContext(), mergeRecommendations(),
                          aggregateConfidence(), prioritizeRecommendations(),
                          handoffSource() — the core new collaboration logic.
  recommendation.tool.ts  3 tools: recommendation_engine_list (wraps
                          RecommendationService, real), recommendation_finding_lookup
                          (wraps FindingService, real, also the standalone fallback
                          path), recommendation_asset_lookup (ownership check).
  recommendation.executor.ts  Orchestrates handoff resolution -> fallback -> merge ->
                          prioritize -> LLM summary -> memory/telemetry.
  recommendation.agent.ts, recommendation.interface.ts, recommendation.types.ts,
  recommendation.schemas.ts, recommendation.context.ts, recommendation.memory.ts,
  recommendation.telemetry.ts, recommendation.prompts.ts, recommendation.summary.ts,
  recommendation.errors.ts, index.ts
                          Same file-split convention Discovery/Risk/Compliance
                          established.

apps/api/src/ai/agents/report/
  report.executor.ts     Per-source-agent context-then-memory-then-MISSING resolution,
                          applyToExecutive()/applyRecordToExecutive() for the
                          executive summary.
  report.tool.ts          1 tool: report_asset_lookup (ownership check — Report has no
                          evaluation logic of its own to wrap).
  report.agent.ts, report.interface.ts, report.types.ts, report.schemas.ts,
  report.context.ts, report.memory.ts, report.telemetry.ts, report.prompts.ts,
  report.summary.ts, report.errors.ts, index.ts
                          Same file-split convention.
```

New routes: `apps/api/src/routes/recommendation-agent.ts` (`POST /ai/recommendation/analyze`, `GET /ai/recommendation/{history,summary}`) and `apps/api/src/routes/report-agent.ts` (`POST /ai/report/generate`, `GET /ai/report/{history,summary}`), both registered in `server.ts` after `complianceAgentRoutes` — same async-enqueue contract (202 + `{jobId}`, poll `GET /jobs/:id`) as every prior agent route. New job types `AI_RECOMMENDATION`/`AI_REPORT` (free-form strings, no migration), dispatcher handlers dynamically imported (the same `observability/metrics.ts` circular-import shape recurring a fourth/fifth time, fixed identically and pre-emptively), `MissingRecommendationTargetError`/`MissingReportTargetError` added to `job-executor.ts`'s `isPermanentFailure()`.

**Design decisions worth calling out:**
- **`RecommendationHandoffSource`/`ReportSection.origin` make provenance a first-class, inspectable part of the output**, not just an internal implementation detail — a caller can tell whether a recommendation's risk data came from this exact workflow run, a fallback DB read, or wasn't available at all.
- **The `StateManager.finalize()` fix is additive and backward-compatible** — the new `context` parameter is optional; any other caller that doesn't pass it keeps the old (stale-snapshot) behavior rather than breaking.
- **No unit-test framework exists in this project** — `scripts/verify-multi-agent-collaboration.ts` follows the established in-process `createChecker()` convention in two parts: an in-process section registers synthetic fake agents (one always-failing) directly into the real `orchestratorAgentRegistry` to prove shared-state/handoff/failure-isolation at the engine level, isolated from any real agent's business logic; an HTTP section runs the real `full-security-analysis` workflow end to end against a crafted repository.

## Copilot Agent (Phase 22)

`apps/api/src/ai/agents/copilot/` is the sixth and last concrete `OrchestratorAgent` — it registers into `orchestratorAgentRegistry` under id `copilot-agent`, implementing Phase 17's placeholder `CopilotAgent` interface for real. It is EstateAI's primary conversational interface, distinct from and independent of the pre-existing `POST /copilot/chat` (Phase 8, `services/copilot/`) — that route/service is unchanged; this is a new implementation under the `src/ai/` stack Phases 16-21 built, exposed at new `/ai/copilot/*` routes.

**Intent classification is deterministic keyword matching, same reasoning `Planner` already used for workflow intent.** `copilot.intent.ts` maps a chat message to one of seven `CopilotIntent`s (`EXPLAIN_RISK`/`EXPLAIN_COMPLIANCE`/`EXPLAIN_RECOMMENDATION`/`SUMMARIZE_REPORT`/`ANALYZE`/`FOLLOW_UP`/`GENERAL`) — not an LLM call, mirroring `Planner.resolveWorkflowId()`'s own "understand intent well enough to select a path, never execute business logic itself" boundary (`ai/orchestrator/planner.ts`). `FOLLOW_UP` is special: it doesn't answer anything itself, it resolves to whatever intent the conversation's session state last recorded, letting "why?" or "explain that" work without the user repeating context.

**Conversation memory reuses two Phase 16 primitives that had been provisioned but never called until this phase.** `ConversationMemory` (append-only turn log, 1-day TTL) and `SessionMemory` (short-lived key-value scratch, 30-min TTL) both live on `aiFoundation` since Phase 16, but no route or agent had ever called either — `PROJECT_PROGRESS.md`'s doc-debt list flagged `ConversationMemory` as "exists for this, but nothing calls it yet" as recently as Phase 21. `copilot.memory.ts`'s `CopilotMemory` composes both (conversationId doubling as `SessionMemory`'s `sessionId`, a stable "this ongoing chat" identifier) plus its own longer-lived execution-trace history (a third `MemoryStore` key, matching every sibling agent's `*Memory` pattern) into one domain-facing class.

**Grounding tools wrap the same services Risk/Compliance/Recommendation Agents' own tools already wrap.** `copilot.tool.ts` registers 4 tools — `copilot_risk_lookup`/`copilot_compliance_lookup`/`copilot_recommendation_lookup` (thin reads over `RiskService`/`FindingService`, `ComplianceService`, `RecommendationService` respectively) and `copilot_asset_lookup` (ownership + resource count). None compute a score or generate a finding/recommendation — Copilot's entire job is explaining what those services already return, in prose.

**Intelligent Routing never calls another agent directly — it always goes through `OrchestratorService`/`WorkflowEngine`, the same path every multi-step run uses.** When `copilot_asset_lookup` reports zero discovered resources, or the intent is `ANALYZE` (an explicit "(re)analyze" request), `copilot.executor.ts` calls `orchestratorFoundation.service.execute({intent: <workflowId>, ...})` with a `workflowId` selected from a fixed per-intent map (`ANALYZE`/`EXPLAIN_RISK` → `risk-only`, `EXPLAIN_COMPLIANCE` → `compliance-only`, `EXPLAIN_RECOMMENDATION` → `risk-recommendation`, `SUMMARIZE_REPORT` → `full-security-analysis`) — exactly the spec's own "Analyze this asset -> Run Discovery -> Run Risk -> Return explanation" example, using `risk-only` for that case specifically. If the asset has no connected account to discover from, routing degrades to a warning rather than throwing — the conversation never crashes (goal #9).

**Every answer carries a deterministic Explanation before any LLM touches it.** `gatherExplanation()` builds `{summary, reasoning, evidence, suggestedAction, confidence}` straight from tool output — the LLM (`copilot.summary.ts`'s `generateAnswer()`) only rephrases those fields into one conversational `answer` string, and is never allowed to change them; a fallback deterministic concatenation is used on any LLM failure, same graceful-degradation pattern every other agent's summary module follows.

**Ownership errors are never swallowed into a degraded answer.** `ToolRegistry.execute()` wraps every tool failure in `ToolExecutionError` (with the original error on `.cause`) — `copilot.executor.ts`'s `callTool()` unwraps and re-throws `ForbiddenError`/`AssetNotFoundError` specifically, so "you don't own this asset" always becomes a 403/404 at the route layer; every other tool failure still degrades to a low-confidence chat answer (goal #9's actual scope).

**Module layout** (`apps/api/src/ai/agents/copilot/`):

```
copilot.intent.ts      classifyIntent()/extractRecommendationIndex() — the one file with
                        no direct equivalent in a prior agent (message-level, not
                        workflow-level, intent classification).
copilot.tool.ts         4 ToolDefinitions: copilot_risk_lookup/copilot_compliance_lookup/
                        copilot_recommendation_lookup/copilot_asset_lookup — all real,
                        thin reads over unchanged RiskService/ComplianceService/
                        RecommendationService/FindingService/resourceRepository.
copilot.executor.ts    CopilotExecutor — classifies intent, resolves session state,
                        gathers grounding data (tools, with Intelligent Routing when
                        missing), builds the Explanation, narrates via the LLM, updates
                        conversation/session memory, records the execution trace.
copilot.agent.ts       CopilotAgentImpl implements Phase 17's CopilotAgent placeholder
                        interface for real.
copilot.memory.ts      CopilotMemory — composes ConversationMemory + SessionMemory
                        (both Phase 16, newly wired up) plus its own execution-trace
                        history.
copilot.prompts.ts     copilotAnswerPrompt +
copilot.summary.ts     generateAnswer() — the LLM's entire surface area (narrate an
                        already-built Explanation into prose). Falls back to
                        deterministic text on any LLM failure.
copilot.telemetry.ts   CopilotAgentTelemetry — estateai_ai_copilot_agent_* metrics
                        (runs by status+intent, duration, workflows auto-triggered,
                        tool calls, LLM duration/tokens, retries).
copilot.errors.ts      CopilotAgentError base + MissingConversationIdError.
copilot.types.ts, copilot.schemas.ts, copilot.interface.ts, copilot.context.ts
                        shared types, zod schemas, class-level contracts, and the
                        OrchestrationContext -> AIContext bridge.
index.ts               Composition root + self-registration.
```

New routes (`apps/api/src/routes/copilot-agent.ts`, registered after `reportAgentRoutes` in `server.ts`): `POST /ai/copilot/chat` (**synchronous** — 200 with the full answer in-response, unlike every other Phase 18-21 agent's async 202+jobId contract, since a chat reply is inherently request/response), `GET /ai/copilot/history`, `DELETE /ai/copilot/history/:conversationId` (returns `200 {status:'ok'}`, not a bodyless `204` — no other route in this codebase uses 204, kept consistent rather than introducing a first exception).

**Design decisions worth calling out:**
- **`conversationId` has no ownership record tying it to a user** — `GET`/`DELETE /ai/copilot/history` trust possession of the id, the same model `GET /ai/orchestrator/status`'s `executionId` already uses. Server-generates a `randomUUID()` when the client doesn't supply one, so it's unguessable in practice, but this is a documented, deliberate simplification, not an oversight.
- **Compliance/Recommendation data needs no explicit prior agent run to answer from** — `ComplianceService`/`RecommendationService` compute/read live from `PolicyResult`/`Recommendation` rows that already exist as a side effect of Discovery's own rule/policy evaluation, so Copilot can answer "what failed compliance?" correctly even if Compliance Agent itself has never run for that asset, as long as Discovery has.
- **No unit-test framework exists in this project** — `scripts/verify-copilot-agent.ts` deliberately skips running discovery in its own setup (every other agent's verify script runs it first) specifically so the first "Analyze this asset" chat message has to exercise Intelligent Routing for real.

## Long-Term Memory & RAG (Phase 23)

Adds a persistent Knowledge Base + semantic (vector) retrieval on top of the six agents Phase 16-22 built. Three new, independent modules under `apps/api/src/ai/`, plus one integration point into `orchestrator/executor.ts` and one into Copilot — no existing agent's public contract or route shape changed.

**Vector storage: pgvector, not a separate vector database.** The local/dev/prod Postgres image (`docker-compose.yml`/`docker-compose.dev.yml`/`docker-compose.prod.yml`) switched from `postgres:16` to `pgvector/pgvector:pg16` — a drop-in image built on `postgres:16` that adds the `vector` extension, so no second datastore/deployment target is introduced. `KnowledgeDocument.embedding` is a `vector(1536)` column, declared in `prisma/schema.prisma` via Prisma's `Unsupported("vector(1536)")` type since Prisma has no native pgvector support — every read/write that touches it goes through `$queryRaw`/`$executeRaw` in `ai/knowledge/knowledge.repository.ts`, never the generated client (which has no field for an `Unsupported` column at all). The migration (`20260803063416_add_knowledge_rag`) runs `CREATE EXTENSION IF NOT EXISTS vector` and creates an `ivfflat` cosine-distance index on `embedding`.

**Embedding Service — provider-abstracted, same shape as `LLMProvider`/`LLMClient`.** `ai/embeddings/embedding-provider.interface.ts` defines `EmbeddingProvider {id, version, embed(text), batchEmbed(texts)}`; `ai/embeddings/index.ts` selects a concrete implementation once, at composition-root time, from `EMBEDDING_PROVIDER` (`local` | `openai`):
- `LocalHashEmbeddingProvider` (the default) — dependency-free and deterministic: SHA-256-hashes each token into a bucket of a fixed 1536-dim vector (a hashing-trick variant), L2-normalizes so cosine similarity behaves sensibly. Captures token overlap, not real semantic meaning, but needs no API key — the same "graceful default over a hard external dependency" precedent every agent's `*.summary.ts` LLM-narration fallback already established, applied one layer earlier so indexing/retrieval/Copilot grounding all work out of the box in dev/CI.
- `OpenAIEmbeddingProvider` — real `/v1/embeddings` calls, opt-in via `EMBEDDING_PROVIDER=openai` (reuses `OPENAI_API_KEY`).

Every provider's output is padded/truncated to the same fixed `EMBEDDING_DIMENSION` (1536) regardless of native model width, so the vector column's meaning survives a provider swap; `embeddingVersion` (e.g. `local-hash-v1-1536`, `openai-text-embedding-3-small-v1-1536`) is stored on every row so a future switch is at least *detectable*, even though nothing auto-migrates old vectors yet (see limitations).

**Knowledge Store — the indexing/storage layer.** `ai/knowledge/knowledge.store.ts`'s `KnowledgeStore.indexDocument(s)` embeds text via `EmbeddingService`, then upserts via `knowledge.repository.ts` by `(sourceId, agent)`. The upsert key is chosen per document kind, deliberately:
- **Live-entity documents** (a `Finding`, a `Recommendation`, an open compliance failure) use a stable `sourceId` (the underlying row's id, or a deterministic composite like `compliance-failure:${assetId}:${policyCode}:${index}`) — re-indexing the same entity on a re-run updates the existing document in place, never duplicates.
- **Run-level snapshot documents** (a Risk/Compliance/Report overview, a Discovery summary) key `sourceId` on that run's `metadata.finishedAt` timestamp — every run creates a *new* document rather than overwriting the previous one, so history accumulates. This is what makes "what changed since last scan?"/"what did you recommend yesterday?" answerable at all via `KnowledgeStore.getHistory(assetId, documentType)`.

**Automatic Indexing — one integration point, not five.** Rather than editing all five agent executors, indexing hooks into the single place every successful step already flows through: `orchestrator/executor.ts`'s existing `onStepComplete` callback (the same callback that already mirrors results into `OrchestrationContext.agentOutputs` and `StateManager`). A new `ai/shared/knowledge.indexing.ts` (`indexAgentOutput(agentId, output, context)`) dispatches to per-agent adapters in `ai/shared/knowledge.adapters.ts` (`documentsFromRiskOutput`/`documentsFromComplianceOutput`/`documentsFromRecommendationOutput`/`documentsFromReportOutput`/`documentsFromDiscoveryOutput`) — the same "shared adapter with locally-declared structural types, never an agent-to-agent import" pattern `ai/shared/finding.adapters.ts` established in Phase 21. It's called fire-and-forget (`void indexAgentOutput(...)`, never awaited by the workflow) and swallows its own errors internally — indexing must never affect the workflow it's observing, mirroring Phase 21's Failure Isolation precedent (a downstream step failing must never roll back an upstream one). This means every workflow — the five pre-existing ones and any future one — gets automatic indexing for free with zero per-workflow wiring; the only place a *new* agent needs new code is one more `case` in `buildDocuments()`'s switch plus a matching adapter.

**Retrieval Service — semantic search + audit trail.** `ai/retrieval/retrieval.service.ts`'s `RetrievalService.search({question, assetId, documentTypes?, agent?, tags?, topK?})` embeds the question, runs a pgvector cosine-similarity nearest-neighbor query (`<=>` operator; `1 - distance` converted to a `[0,1]` score so higher-is-better, matching every other score in this codebase), and — for every call — writes a `RetrievalTrace` row (`documentIds`, `scores`, `latencyMs`, `embeddingVersion`, optional `conversationId`/`assetId`) via `prisma.retrievalTrace.create()` (a plain-column model, no `Unsupported` type needed, unlike `KnowledgeDocument`). Trace persistence is wrapped in its own try/catch that swallows failures — observability must never affect correctness, the same precedent `ExecutionHistory` set.

**Copilot grounding.** `copilot.executor.ts` gained one new step, `retrieveGrounding()`, called right after `gatherExplanation()` succeeds and right before `generateAnswer()`: it searches the Knowledge Store scoped to `assetId` — which by this point in `run()` has already passed `copilot_asset_lookup`'s ownership check, so grounding is never run unscoped (an unscoped search would let one user's question surface another user's indexed findings/recommendations across the whole Knowledge Store). Retrieved document text is folded into `CopilotExplanation.evidence`, which `copilot.prompts.ts`'s existing "Use only the summary, reasoning, evidence, and suggested action you are given — never invent a fact" system prompt already treats as the sole source of truth — so RAG grounding required *no* prompt change, only new evidence flowing into an existing "never invent a fact" contract. Retrieved document ids surface on `CopilotAgentOutput.citations` (a field the Phase 22 interface already declared but never populated). A retrieval failure is swallowed inside `retrieveGrounding()` and degrades Copilot to its pre-Phase-23 (ungrounded) behavior rather than failing the conversation.

**New routes** (`apps/api/src/routes/knowledge-rag.ts`, registered after `knowledgeRoutes` in `server.ts`): `POST /knowledge/index` (manual indexing), `POST /knowledge/search` (manual retrieval), `GET /knowledge/document/:id`, `GET /knowledge/history/:assetId` — every route ownership-checked via `getOwnedAsset()`, same as every asset-scoped route elsewhere. **Deliberately a new file, not an addition to the pre-existing `routes/knowledge.ts`** (Phase 7C's `KnowledgeService`/`ContextBuilder`, exposing `/knowledge/context` + `/knowledge/retrievers`) — that system is untouched and unrelated; both files register under the same `/knowledge` path prefix with no overlapping routes.

**Module layout** (`apps/api/src/ai/`):

```
embeddings/
  types.ts                     EMBEDDING_DIMENSION (1536), EmbeddingResult.
  embedding-provider.interface.ts  EmbeddingProvider contract.
  embedding.service.ts         EmbeddingService — public embed()/batchEmbed(),
                                retry-on-rate-limit + telemetry, same shape LLMClient
                                wraps LLMProvider.
  embedding.telemetry.ts       estateai_ai_embedding_* metrics.
  providers/
    local-hash.provider.ts     LocalHashEmbeddingProvider (default).
    openai-embedding.provider.ts  OpenAIEmbeddingProvider (opt-in).
  index.ts                     Composition root — selects provider from config,
                                exports the process-wide embeddingService singleton.

knowledge/
  knowledge.types.ts           IndexDocumentInput, KnowledgeDocumentRecord, etc.
  knowledge.repository.ts      Raw-SQL data access (the only file that touches
                                the `embedding` column directly).
  knowledge.store.ts           KnowledgeStore — indexDocument(s)/getDocument/getHistory.
  knowledge.telemetry.ts       estateai_ai_knowledge_* metrics (write path).
  index.ts                     Composition root — exports knowledgeStore singleton.

retrieval/
  retrieval.types.ts           RetrievalQuery, RetrievalResult.
  retrieval.service.ts         RetrievalService.search() — embed + pgvector search +
                                RetrievalTrace write.
  retrieval.telemetry.ts       estateai_ai_retrieval_* metrics (read path).
  index.ts                     Composition root — exports retrievalService singleton.

shared/
  knowledge.adapters.ts        Per-agent-output -> IndexDocumentInput[] adapters.
  knowledge.indexing.ts        indexAgentOutput() — the one call site wiring every
                                agent's output into the Knowledge Store, invoked from
                                orchestrator/executor.ts.
```

**Design decisions worth calling out:**
- **`LocalHashEmbeddingProvider` is the default, and it is not a real embedding model.** It captures lexical/token overlap, not semantic meaning — good enough to make "the S3 bucket finding" rank above "the CIS compliance failure" for a storage-related question, but it will not generalize to a genuine paraphrase the way a trained embedding model would. Every Phase 23 verify script's semantic-search assertions were written to pass reliably against *this* provider's actual behavior.
- **No embedding-provider migration/backfill tool exists.** Switching `EMBEDDING_PROVIDER` after documents already exist does not re-embed them — old rows keep their original `embeddingVersion`/vector, and pgvector will still compute a (meaningless) distance between vectors from two different providers if a query ever mixes them. `embeddingVersion` makes this *detectable*, not automatically fixed.
- **`KnowledgeDocument`/`RetrievalTrace` are soft-referenced to `assetId`, no FK, no cascade** — same pattern as `Finding`/`RiskScore`/`PolicyResult`/`AIRequestLog` elsewhere in this schema (see `DECISIONS.md`). Deleting an `Asset` does not delete its indexed documents; nothing in this codebase hard-deletes an `Asset` in production code today, only verify scripts do, and every Phase 23 verify script cleans up its own `KnowledgeDocument` rows explicitly.
- **Indexing is fire-and-forget, so there is a small, expected eventual-consistency window** — a synchronous `POST /ai/orchestrator/execute` call can return its HTTP response before the last step's automatic-indexing write has committed. `verify-rag.ts` accounts for this with a short poll-with-timeout helper rather than asserting immediately after the workflow response.

## Tool-Using Agents (Phase 24)

Upgrades the six agents from Phase 16-23 into tool-using agents via a generic, reusable framework, five new agent-agnostic tools, a permission model, a persisted execution trace, and Copilot automatic tool selection. Extends the Phase 16 `ToolRegistry`/`ToolDefinition` contract additively — no existing tool registration or `ToolRegistry.execute()` call site changed behavior.

**The framework — `ToolRegistry` (Phase 16, extended) + `ToolExecutor` (new).** `ToolDefinition` gained two optional fields: `id?: string` (defaults to `name` in `ToolRegistry.register()`) and `permissions?: ToolPermission[]` (defaults to `['read']`) — every tool registered before this phase only ever set `name`, so both defaults mean zero per-file edits were needed anywhere in `ai/agents/*/`. `ToolContext` (`ai/tools/tool-context.ts`) is a type alias for `AIContext`, not a new shape — every tool's `execute(input, context)` signature is unchanged. `ToolError` (`ai/tools/tool-error.ts`) is a re-export of the existing `ToolExecutionError`. `ToolResult` (`ai/tools/tool-result.ts`) is a new envelope (`{success, toolName, output?, error?, durationMs}`) returned by the new `ToolExecutor.run()` — unlike `ToolRegistry.execute()` (throws on failure, the contract every pre-Phase-24 agent executor already depends on), `ToolExecutor` never throws, which is what makes Copilot's automatic tool selection safe to wire into a live conversation.

`ToolExecutor.run(toolName, input, context, agentId?)` does, in order: (1) checks `agentId` against `agent-tool-access.ts`'s static `AGENT_TOOL_ACCESS` allowlist, denying by default if `agentId` is given and undeclared; (2) calls `assertPermitted()` (`tool-permissions.ts`), which refuses any tool declaring `'write'` — the only permission this deployment doesn't grant, per the spec's explicit "Current implementation: read-only everywhere"; (3) delegates to `ToolRegistry.execute()` for the actual input/output-validated call; (4) records both a Prometheus metric (`estateai_ai_tool_*`, `ai/tools/tool.telemetry.ts`) and a persisted `ToolExecutionTrace` row (new Prisma model: `toolName`/`agentId`/`arguments`/`success`/`error`/`durationMs`) for every call, success or failure. `ToolRegistry.execute()` itself deliberately stays allowlist/permission-agnostic — every pre-Phase-24 internal call site (each agent's own executor calling its own tools) keeps working exactly as before; only new call sites (Copilot's automatic tool selection, every Phase 24 verify script) go through `ToolExecutor`.

**Five new builtin tools** (`ai/tools/builtin/`), agent-agnostic — not owned by any one agent's folder, shared per `agent-tool-access.ts`'s declarations:
- **Postgres Tool** (`postgres.tool.ts`) — `postgres_query`/`postgres_list_tables`/`postgres_table_info`, read-only. `postgres_query`'s `assertReadOnlySelect()` rejects anything not a single `SELECT`/`WITH ... SELECT` statement — write/DDL keywords anywhere in the text, or a second statement after a `;`, are refused before the query ever reaches `$queryRawUnsafe()`. `postgres_table_info` never interpolates the caller's raw table name into a `COUNT(*)` query — it first re-confirms that name against a fresh `information_schema.tables` read, so only a name Postgres itself just reported can reach the interpolated query.
- **GitHub Tool** (`github.tool.ts`) — `github_repository_info`/`github_repo_branches`/`github_list_files`/`github_commit_history`/`github_list_pull_requests`/`github_list_issues`. Self-contained live REST calls against `config.oauth.github.apiBaseUrl` (new env var, `GITHUB_API_BASE_URL`, overridable for mock servers same as every other `GITHUB_*_URL`), ownership-checked via the existing `getOwnedAccount()`. Distinct from Discovery Agent's own `github.tool.ts` (Phase 18, wraps `DiscoveryService`/persisted `Resource` rows, never makes a live call) — the two coexist; `github_repo_branches` is deliberately not named `github_list_branches` to avoid colliding with Discovery's own placeholder tool of that name.
- **Filesystem Tool** (`filesystem.tool.ts`) — `fs_read_file`/`fs_list_directory`/`fs_search_files`, sandboxed to `apps/api/var/fs-tool-root/`. `resolveSandboxed()` resolves every caller path against that root and rejects (via `ToolError`) if the resolved absolute path doesn't start with the root — the actual traversal guard, not a string-pattern check. No write tool exists in this file's exports.
- **Web Search Tool** (`websearch.tool.ts` + `websearch.provider.ts`) — a `WebSearchProvider` interface (`search(query, topK)`) plus `MockWebSearchProvider`, the only implementation shipped: deterministic, offline, `example.com`-placeholder results so it can never be mistaken for a real search. `createWebSearchTool(provider)` takes the provider as a parameter, so a future real provider swaps in at `registerBuiltinTools()` without touching the tool's own shape — same pattern `EmbeddingProvider` (Phase 23) established.
- **Knowledge Search Tool** (`knowledge.tool.ts`) — wraps `RetrievalService.search()` (Phase 23) as `knowledge_search`. `copilot.executor.ts`'s RAG grounding (`retrieveGrounding()`) now calls this tool via `this.callTool('knowledge_search', ...)` instead of holding a `RetrievalService` reference directly — the constructor's fourth parameter changed from `RetrievalService` to `ToolExecutor` accordingly.

All five are registered by `ai/tools/builtin/index.ts`'s `registerBuiltinTools()`, called once from `server.ts` after every agent module has already self-registered its own tools (tool names are disjoint between the two groups, so registration order never matters).

**Agent tool declarations** (`agent-tool-access.ts`) — a static map from each of the six agent ids to the tool names it may call: its own tools (always) plus whichever generic builtin tools make sense for that agent (Compliance gets the Postgres tools; Copilot gets all five builtin families; Risk/Recommendation/Report get `knowledge_search`). `isToolAllowedForAgent(agentId, toolName)` is the read side `ToolExecutor` checks.

**Copilot automatic tool selection** (spec #8) — a new `copilot.tool-selector.ts`'s `selectTool(message)`: deterministic keyword-pattern matching (same "not an LLM call" reasoning `copilot.intent.ts`/`Planner.resolveWorkflowId()` already established) from a chat message to a `ToolSelection` (`github_issues`/`github_pull_requests`/`github_branches`/`knowledge_findings`/`count_findings`). In `copilot.executor.ts`'s `run()`, a match short-circuits the whole intent-based `gatherExplanation()` flow — `runSelectedTool()` resolves the account's primary repository (for GitHub selections; a deliberate demo-scale simplification, not multi-repo disambiguation), runs the chosen tool through `this.toolExecutor.run(..., 'copilot-agent')`, and renders the result via a new generic `summarizeToolOutput()` (works for any tool's output shape — finds the first array-valued field and renders each item's first few string/number properties — rather than one formatter per tool). `count_findings` is the one selection that never touches the user's raw message text: it builds a fixed, code-authored, `assetId`-scoped `SELECT COUNT(*) ...` query, since `postgres_query` itself grants whole-database read access with no per-row authorization of its own. A message matching nothing falls through to the unchanged Phase 22 flow — tool selection is additive.

**Module layout** (`apps/api/src/ai/tools/`):

```
tool-registry.ts        ToolRegistry (Phase 16, extended) — register()/get()/has()/list()/execute().
tool-executor.ts        ToolExecutor (new) — allowlist + permission enforcement, telemetry,
                         ToolExecutionTrace; never throws, always resolves a ToolResult.
tool-context.ts          ToolContext = AIContext (alias).
tool-result.ts           ToolResult envelope.
tool-error.ts             ToolError = ToolExecutionError (alias).
tool-permissions.ts      assertPermitted() — refuses any tool declaring 'write'.
agent-tool-access.ts     AGENT_TOOL_ACCESS map + isToolAllowedForAgent().
tool.telemetry.ts        estateai_ai_tool_* metrics + ToolExecutionTrace persistence.
tool.types.ts            Re-exports of ToolDefinition/ToolPermission from ai/types/tool.types.ts.
builtin/
  postgres.tool.ts        postgres_query/postgres_list_tables/postgres_table_info.
  github.tool.ts           github_repository_info/github_repo_branches/github_list_files/
                           github_commit_history/github_list_pull_requests/github_list_issues.
  filesystem.tool.ts       fs_read_file/fs_list_directory/fs_search_files.
  websearch.provider.ts    WebSearchProvider interface + MockWebSearchProvider.
  websearch.tool.ts        web_search (provider-injected).
  knowledge.tool.ts        knowledge_search (wraps RetrievalService).
  index.ts                 registerBuiltinTools() — composition root, called once from server.ts.
```

**Design decisions worth calling out:**
- **`postgres_query` has no per-row authorization** — unlike every asset-scoped route, it reads the whole application database, not just the calling agent's own asset's data. Deliberately excluded from Copilot's free-text automatic tool selection for exactly this reason; only a fixed, code-authored query (never the raw chat message) ever reaches it via `copilot.tool-selector.ts`.
- **No manual `POST /ai/tools/execute` HTTP route exists** — every new tool is reachable in-process (by agents, and by Copilot's automatic selection) but not by an arbitrary external caller. Given `postgres_query`'s broad read access, exposing raw tool invocation over HTTP was a deliberate scope decision to defer, not an oversight.
- **`ToolRegistry.execute()` and `ToolExecutor.run()` are two different entry points on purpose** — the former is the original Phase 16 contract every agent's own executor already calls directly (no allowlist/permission check, by design, for backward compatibility); the latter is the new, checked entry point. A future phase retrofitting every agent's internal tool calls to route through `ToolExecutor` would need to thread an `agentId` through each call site — not done here, since the six existing agents' own tools were already implicitly self-permitted (an agent has always been able to call its own tools).

## Planning, Reflection & Self-Correction (Phase 25)

Upgrades EstateAI from a tool-using multi-agent platform into a reasoning-first one — goal decomposition, output/plan quality scoring, a persisted post-run reflection, a recoverable-vs-permanent retry policy, and live Plan Revision — layered entirely on top of the Phase 17 `WorkflowEngine`/`OrchestratorService`, neither of which is replaced or modified in its own public behavior.

**Two distinct "planners" coexist on purpose.** `ai/orchestrator/planner.ts`'s `Planner` (Phase 17, unchanged) still does one job: map a free-form intent to a registered `WorkflowDefinition` via keyword matching, producing a plain `ExecutionPlan` (`{planId, workflowId, intent, steps, createdAt}`) with just enough shape for `Executor`/`WorkflowEngine` to run it. The new `ai/planner/goal-planner.ts`'s `GoalPlanner` *composes* that class rather than reimplementing intent matching — it calls `workflowPlanner.createPlan()` for workflow selection, then decorates the result into a richer `ReasoningPlan` (`{planId, goal, workflowId, steps: {stepId, agentId, dependsOn, tools}[], requiredAgents, requiredTools, estimatedComplexity, estimatedDurationMs, confidence, revisionOf?, revisionReason?}`). `requiredTools` per step comes straight from Phase 24's `AGENT_TOOL_ACCESS` map — no new tool-declaration mechanism was introduced.

**Plan Revision is a live skip, not a second execution.** `ai/planner/reasoning-orchestrator.ts`'s `buildAdaptiveDefinition()` clones the `WorkflowDefinition` `GoalPlanner` selected and wraps every step that has at least one dependency in a `condition`: the step only runs if every dependency already succeeded in `context.agentOutputs` so far (composed with whatever `condition` the base definition already declared, if any). This reuses `WorkflowEngine`'s existing Phase 17 condition/skip mechanism — nothing in `workflow.engine.ts`'s `run()`/`runStep()` logic itself changed for this. The net effect: a step that throws is `FAILED`; every step that transitively depends on it is `SKIPPED` in the very same `run()` call, not retried, not left to fail with a confusing downstream error. `GoalPlanner.revisePlan(plan, result)` is called *after* the run finishes, purely to explain what happened as a `ReasoningPlan` (drops the failed step and everything doomed by it, recomputes `requiredAgents`/`requiredTools`/`estimatedComplexity`/`estimatedDurationMs`/`confidence` around the survivors) — it is never used to trigger a second execution.

**`Critic`** (`ai/critic/critic.ts`) evaluates independently of `WorkflowStatus` — `evaluateStep()` flags `FAILED`/`TIMED_OUT` as `CRITICAL`, `SKIPPED` as `WARNING`, and a `SUCCESS` step whose output's only array-valued field(s) are all empty as `WARNING` ("succeeded but returned no evidence" — the same emptiness heuristic Phase 24's `summarizeToolOutput()` uses to decide whether a tool call said anything). `evaluatePlan()` flags an empty-steps or low-confidence `ReasoningPlan`. `evaluateExecution()` combines both into a `CriticReport` (`{score, findings, missingEvidence}`), `score` being `successRatio` minus a findings-severity penalty, clamped to `[0, 1]`. `ai/critic/confidence.ts`'s `aggregateConfidence()` is a separate, reusable weighted blend of `{toolSuccessRatio, agentConfidences, retrievalConfidence?, criticScore}` into one number — any signal not available for a given run falls back to a documented neutral value (0.7), never 0 or 1, so a missing signal can't manufacture false confidence or a false alarm.

**`ReflectionEngine`** (`ai/reflection/reflection.engine.ts`) runs once per `ReasoningOrchestrator.run()` and produces a persisted `ReflectionReport` (`{executionId, planId, finalPlanId, succeededSteps, failedSteps, skippedSteps, missingEvidence, weakRecommendations, incompleteReports, criticScore, overallConfidence, notes, createdAt}`). `weakRecommendations`/`incompleteReports` check specifically for a `recommendation-agent`/`report-agent` step whose `recommendations`/`sections` array came back empty. `notes` is the explainability trail — which workflow the goal resolved to, the run's final status, which steps failed/were skipped, and (if applicable) why the plan was revised.

**Retry Policy** (`ai/utils/retry-policy.ts`) — lives outside both `ai/planner/` and `ai/orchestrator/` specifically to avoid an import cycle (`ai/planner` imports from `ai/orchestrator`; `workflow.engine.ts` needs the classifier too). `classifyError()`/`isRetryableError()` default any ordinary `Error` to `RECOVERABLE` — this preserves every pre-Phase-25 retry behavior unchanged (a generic tool-timeout/transient-API-failure/DB-timeout `Error` is retried exactly as before) — and classify a small named set (`UnauthorizedError`/`ForbiddenError`/`InvalidCredentialsError`/`InvalidRefreshTokenError`/`RefreshTokenReuseError`/`ValidationError`/`ZodError`, plus a permission/validation/auth message pattern) as `PERMANENT`, never retried. `workflow.engine.ts`'s `runStep()` wires this in with one additional `&&` clause on its existing `isRetryable` callback — the only change to that file this phase made.

**`ReasoningOrchestrator`** (`ai/planner/reasoning-orchestrator.ts`) is the new composition root tying all of the above together: `GoalPlanner.createPlan()` → build the adaptive `WorkflowDefinition` → `workflowEngine.run()` (mirroring `Executor`'s own `recordAgentOutput` wiring, independently — `ReasoningOrchestrator` does not call `Executor`, since `Executor` resolves its `WorkflowDefinition` by looking `plan.workflowId` back up in `workflowRegistry`, which would lose the adaptive per-step conditions this phase attaches) → `Critic.evaluateExecution()` → `GoalPlanner.revisePlan()` (if `PARTIAL`/`FAILED`) → `ReflectionEngine.reflect()` → persist both the plan(s) (`PlanStore`) and the reflection (`ReflectionStore`), both Redis-backed via the same `MemoryStore` pattern `ExecutionHistory`/`StateManager` already use (7-day TTL). `ai/planner/reasoning.ts` is the composition-root file (mirrors `ai/orchestrator/orchestrator.ts`), exporting the process-wide `reasoningFoundation` singleton.

**New API surface** (`routes/planner.ts`): `POST /ai/planner/plan` (plans *and* runs a goal in one call — returns `{plan, finalPlan, result, critic, reflection}` — there is no separate "execute this plan later" step in this phase, since `GET /ai/reflection/:executionId` needs a completed execution to have something to report on), `GET /ai/planner/:id`, `GET /ai/reflection/:executionId` (both 404 on an unknown/expired id). Registered in `server.ts` alongside every other route; `POST /ai/orchestrator/execute` (Phase 17) is completely untouched and still runs the plain, non-adaptive path.

**Module layout** (`apps/api/src/ai/`):

```
planner/
  plan.types.ts             ReasoningPlan/ReasoningPlanStep/PlanComplexity types.
  goal-planner.ts           GoalPlanner — createPlan() (composes ai/orchestrator/planner.ts),
                            revisePlan() (drops doomed steps, recomputes aggregate fields).
  plan-store.ts             PlanStore — Redis-backed persistence, 7d TTL.
  reasoning-orchestrator.ts ReasoningOrchestrator — plan -> adaptive execute -> critique ->
                            revise -> reflect -> persist. buildAdaptiveDefinition() lives here.
  reasoning.ts              Composition root — reasoningFoundation singleton.
  index.ts                  Barrel export (also re-exports retry-policy for convenience).
critic/
  critic.types.ts           CriticFinding/CriticReport/CriticSeverity types.
  confidence.ts             aggregateConfidence() — reusable weighted signal blend.
  critic.ts                 Critic — evaluateStep()/evaluatePlan()/evaluateExecution().
reflection/
  reflection.types.ts       ReflectionReport type.
  reflection.engine.ts      ReflectionEngine — reflect().
  reflection.store.ts       ReflectionStore — Redis-backed persistence, 7d TTL.
utils/
  retry-policy.ts           classifyError()/isRetryableError() — shared by workflow.engine.ts
                            and re-exported through ai/planner/index.ts.
```

**Design decisions worth calling out:**
- **Plan Revision only ever removes steps, never substitutes or adds** — the spec's own "Discovery failed -> skip Risk -> run Compliance -> generate partial report" example is illustrative, not literal to the real seeded `full-security-analysis` workflow, where Compliance *does* depend on Discovery (so a Discovery failure skips it too, same as everything else downstream). A genuinely dynamic re-planner that swaps in an alternative agent or inserts a new step is out of scope for this phase.
- **The real Discovery Agent doesn't produce a real `FAILED` step for a bad credential** — it catches the GitHub rejection internally and returns a business-level `SUCCESS` output with `confidenceScore: 0`/populated `errors[]` (`discovery.executor.ts`, pre-existing, unrelated to this phase). Plan Revision's adaptive skip only ever triggers on an actual thrown exception, so `verify-planning.ts`'s Plan Revision proof uses a synthetic always-throwing fake agent registered in-process, not a bad real credential — this is documented in the verify script itself and in `PROJECT_PROGRESS.md`'s doc-debt list, not a bug.
- **`ReasoningOrchestrator` duplicates a small amount of `Executor`'s bookkeeping** (`recordAgentOutput` wiring, `ExecutionResult` assembly) rather than reusing `Executor` directly, because `Executor.run()` re-resolves its `WorkflowDefinition` from `workflowRegistry` by `plan.workflowId` — which would silently discard the adaptive per-step `condition`s this phase attaches. This was a deliberate trade-off (a little duplication) over modifying `Executor` itself to accept a pre-built `WorkflowDefinition`, which would have widened Phase 17's contract for every existing caller.
- **`ai/utils/retry-policy.ts` lives in `utils/`, not `planner/` or `orchestrator/`**, purely to avoid a cycle: `ai/planner/goal-planner.ts` imports from `ai/orchestrator/planner.ts`, and `ai/orchestrator/workflow.engine.ts` needs the same classifier — putting it in either of those two directories would have made one import the other.

## Human-in-the-Loop (HITL) & Approval Workflows (Phase 26)

Adds approval gates, human review, and resumable execution on top of the Phase 17 `WorkflowEngine`/`OrchestratorService` — neither is replaced or modified in its own public behavior. Reuses the exact `condition`-based skip mechanism Phase 25's Plan Revision established, extended to a new purpose: instead of a step's dependents being skipped because it *failed*, a step's dependents are skipped because it's *waiting on a human decision* — and, once decided, the workflow resumes from exactly where it left off.

**`ApprovalPolicy`** (`ai/approval/approval-policy.ts`) decides `AUTO`/`MANUAL`/`NEVER` per agentId via a mutable registry, not a fixed table — `register(agentId, decision)` mirrors `workflowRegistry`/`orchestratorAgentRegistry`'s own register-then-read shape. No agent registers `MANUAL` by default (no destructive/write-capable action exists yet — Phase 24's `ToolExecutor` still refuses any tool declaring `'write'`); Discovery/Risk/Compliance/Report/Copilot are `NEVER` (identical to their pre-Phase-26 behavior — nothing about running them changes); Recommendation Agent is `AUTO` (a request is created and immediately self-approved — an audit trail exists, but nothing blocks). `decideForToolPermissions(permissions)` is the standing hook a future write-capable tool would call (`'write'` -> `MANUAL`), per the Phase 24 spec's own forward-looking §7.

**`ApprovalEngine`/`ApprovalStore`** (`ai/approval/`) persist the audit trail — `ApprovalRequest` (executionId/planId/workflowId/stepId/agentId/decision/status/reason/requestedAt/decidedBy?/decidedAt?/decisionReason?/comment?/editedOutput?) — via the same Redis-backed `MemoryStore` pattern `PlanStore`/`ReflectionStore` (Phase 25) already established, 30-day TTL. `requestApproval()` self-approves an `AUTO` decision inline; `decide()` is the reviewer-facing approve/reject call, carrying an optional `comment` and `editedOutput` (spec §5's "Edit recommendation").

**`HitlOrchestrator`** (`ai/approval/hitl-orchestrator.ts`) is the execution layer:
- `run(input)`: `GoalPlanner.createPlan()` (unchanged) -> request an `ApprovalRequest` for every step whose policy isn't `NEVER` -> build a *gated* `WorkflowDefinition` (`buildGatedDefinition()`) where a step currently `HOLD` (pending) or `BLOCKED` (rejected) gets a `condition` returning `false`, and every dependent step's `condition` still requires its dependency to have actually *succeeded* (same rule Phase 25's `buildAdaptiveDefinition()` uses) -> one `workflowEngine.run()` pass. If anything is left `HOLD`, the result is `WAITING_FOR_APPROVAL` and a `PausedExecutionState` (plan, `OrchestrationContext`, every step's outcome so far, and the `stepId -> ApprovalRequest id` map) is persisted to `PausedExecutionStore` for later.
- `resume(executionId)`: re-derives every step's gate fresh from the *current* `ApprovalRequest` status and runs another gated pass — a step already recorded `SUCCESS` also gets a `condition` returning `false` (via a `terminalStepIds` set), so its agent is never invoked a second time. Only the newly-unblocked steps (and now-unblocked dependents) actually run. Outcomes are merged across rounds — a multi-round resume (approve one gated step, resume, approve another, resume again) never drops an earlier round's real result.
- `cancel(executionId)`: rejects every still-`PENDING` request tied to the execution and drops its `PausedExecutionState`, so a later `resume()` correctly reports "not found."
- Reviewer-edited output (spec §5): if a decided request carries `editedOutput`, that value is recorded directly as the step's `SUCCESS` output (`recordAgentOutput` + a synthetic `AgentTaskResult`) — the agent's `execute()` is never called for that step at all.

**`HitlRunStatus`** (`WorkflowStatus | 'WAITING_FOR_APPROVAL' | 'RESUMED' | 'REJECTED'`) is `HitlOrchestrator`'s own vocabulary, not a change to `ai/orchestrator/types.ts`'s `WorkflowStatus` — `WorkflowEngine`/`ExecutionResult`/`StateManager` are all unaware Phase 26 exists. `REJECTED` is derived from an explicit `rejectedStepIds` list recorded at the exact moment each step's *true* gate is read inside `executeRound()`, not re-inferred afterward from step-count comparisons — an earlier draft conflated a real rejection with the unrelated "gate forced `BLOCKED` because we just injected an edited output" case, which silently mis-reported a clean edited-output resume as `REJECTED` (caught by `verify-resume.ts`, see the bug note below). `RESUMED` marks a `resume()` call that reached a clean terminal state, distinguishing it from a fresh `run()`'s `COMPLETED`.

**New API surface** (`routes/approval.ts`): `POST /ai/approval/request` (plans+runs a goal, gating on `MANUAL` steps as needed), `POST /ai/approval/:id/approve` / `POST /ai/approval/:id/reject` (records the decision, then automatically calls `resume()`), `GET /ai/approval/:id`, `GET /ai/approval/pending`. `routes/planner.ts`'s `POST /ai/planner/plan` (Phase 25) and `routes/orchestrator.ts`'s `POST /ai/orchestrator/execute` (Phase 17) are both completely untouched.

**Module layout** (`apps/api/src/ai/approval/`):

```
approval.types.ts          ApprovalPolicyDecision/ApprovalRequest/ApprovalDecisionInput types.
approval-policy.ts         ApprovalPolicy — register()/decideForAgent()/decideForToolPermissions().
approval-store.ts          ApprovalStore — Redis-backed persistence, 30d TTL, listPending().
approval-engine.ts         ApprovalEngine — requestApproval()/decide()/get()/listPending().
approval-error.ts          ApprovalError.
paused-execution.store.ts  PausedExecutionState/PausedExecutionStore — resume() needs this.
hitl-orchestrator.ts       HitlOrchestrator — run()/resume()/cancel(); buildGatedDefinition() lives here.
approval.ts                Composition root — approvalFoundation singleton.
```

**Design decisions worth calling out:**
- **No real agent ships a `MANUAL` policy today** — no destructive/write-capable action exists yet (Phase 24's `ToolExecutor` still refuses `'write'`), so every pause/resume/reject verify check drives a synthetic in-process fake agent through `ApprovalPolicy.register()`; there is no live HTTP path that produces a genuine `PENDING` request against a real agent yet.
- **Two real bugs found and fixed during this phase's own verification, both in `hitl-orchestrator.ts`:** (1) `resume()` originally re-derived each step's `ApprovalRequest` via `ApprovalStore.listPending()` — which by definition excludes anything already decided, so the moment a request was approved or rejected it fell out of the "pending" list and `resume()`'s lookup found nothing, silently defaulting that step's gate back to `RUN` as if no policy applied at all. Fixed by persisting the `stepId -> ApprovalRequest id` map once in `PausedExecutionState` at the initial `run()`, never re-derived. (2) `'BLOCKED'` was overloaded for both a real rejection and "we just injected the edited output, don't also run the agent" — `rejectedStepIds` computed by re-scanning the gate map afterward couldn't tell them apart. Fixed by recording `rejectedStepIds` at the moment each step's true gate is read, before the edited-output path overwrites it.
- **`ApprovalStore` has no `(executionId, stepId)` index** — `HitlOrchestrator` sidesteps needing one by persisting the id map directly in `PausedExecutionState` (see above); `GET /ai/approval/pending` still does a full scan, fine at this project's scale.
- **`HitlOrchestrator` reuses `Executor`'s `recordAgentOutput` wiring pattern independently, the same way `ReasoningOrchestrator` (Phase 25) does** — not by calling `Executor`/`ReasoningOrchestrator` directly, for the same reason Phase 25 documented: those re-resolve their `WorkflowDefinition` from `workflowRegistry`, which would silently discard the gated per-step `condition`s this phase attaches.

## LangGraph Execution Engine (Phase 27)

Adds the official `@langchain/langgraph` package as a second, additive way to run the same six agents — `WorkflowEngine`/`OrchestratorService`/`HitlOrchestrator` are untouched, and every existing route/agent/API keeps working exactly as before. A LangGraph node's only job is to call `orchestratorAgentRegistry.get(agentId).execute(input, context)` — the exact call `WorkflowEngine.runStep()` already makes — so no agent's business logic is reimplemented.

**`GraphStateAnnotation`** (`ai/langgraph/state.ts`) is a strongly typed `Annotation.Root` carrying every field the spec named (goal/intent/messages/asset/connectedAccounts/discovery/risk/compliance/recommendations/report/knowledge/memory/toolResults/reflection/approval/executionTrace/metadata). `executionTrace: AgentOutputEntry[]` is the graph-native equivalent of `OrchestrationContext.agentOutputs` — replayed into a real `OrchestrationContext` on every node call (`nodes.ts`'s `buildContextFromState()`), which is what lets `recommendation.aggregate.ts`'s existing risk/compliance handoff logic work unmodified inside a graph. `metadata` doubles as the plumbing bag (executionId/user/organization/planId/workflowId/conversationId) since the spec's field list has no dedicated slot for orchestration identity. `messages` holds plain `ConversationTurn` objects, not LangChain `BaseMessage` instances — every channel in this state must round-trip through JSON untouched for `graph.checkpoint.ts`'s durable snapshotting, and a class instance doesn't.

**`nodes.ts`**'s `makeAgentNode(config)` wraps one `OrchestratorAgent`:
1. Idempotent replay guard — skip if `executionTrace` already has a terminal (`SUCCESS` or `FAILED`) entry for this step.
2. Approval gate — `ApprovalPolicy.decideForAgent()` (Phase 26, unchanged); if not `NEVER`, request/reuse an `ApprovalRequest` under a **deterministic id** (`appr-graph-{executionId}-{stepId}`, not `ApprovalEngine`'s usual random id) and, if still `PENDING`, call LangGraph's own `interrupt()` — this is the graph-native alternative to `HitlOrchestrator`'s condition-based gating (spec's own pause/resume primitive, reused directly rather than reimplemented). The deterministic id matters because `interrupt()` pauses by *throwing*: a gated node's `return` never runs before the pause, so `state.approval` is never updated with the request id before that happens — every replay (including the one that finally resumes past the interrupt) re-runs the whole node function from the top, so approval-request creation has to be idempotent from data durable *outside* GraphState (the `ApprovalStore` itself), not from a state field that was never written.
3. Call the real agent (or, for an `APPROVED` request carrying `editedOutput`, use that directly and never call the agent).

`discoveryNode`/`riskNode`/`complianceNode`/`recommendationNode`/`reportNode` are the five pre-built wrappers used by every default graph; `copilotNode` exists for parity (Copilot's real entry point stays conversational, not a DAG step, same as pre-Phase-27). `reflectionNode` runs Phase 25's `Critic`+`ReflectionEngine` as the graph's actual last node before `END` — LangGraph has no literal "after END" hook — persisting into the *same* `reasoningFoundation.reflectionStore` Phase 25's `GET /ai/reflection/:executionId` already reads, so a graph-executed run's reflection is retrievable through that unchanged route.

**`graph-builder.ts`** has two graph constructors:
- `buildWorkflowGraph(definition)` — generic: one node per step (via a mutable `agentId -> node` map, `registerGraphNode()`/`unregisterGraphNode()`, mirroring `orchestratorAgentRegistry`'s own register-then-read shape), a static edge per `dependsOn`. Every step's node is wrapped again by `withDependencyGate()`, which checks `executionTrace` for a `SUCCESS` entry per dependency before calling the real node — necessary because a plain LangGraph `addEdge(dep, step)` only encodes topology: it runs `step` the moment `dep` *completes*, regardless of whether `dep` actually succeeded, unlike `WorkflowEngine`'s `condition`-based dependency-success gating. This is what converts *any* registered `WorkflowDefinition` into a runnable graph with zero per-workflow hardcoding, and `full-security-analysis`'s own shape (Risk and Compliance both depending only on Discovery) gives real, concurrent execution within one Pregel superstep for free — no special-casing needed for "parallel execution."
- `buildConditionalGraph()` — a second, hand-built graph (`security-conditional`) demonstrating genuine `addConditionalEdges` value-based routing matching the spec's own diagram: Discovery's reported resource count decides whether Risk runs at all; Risk's reported score decides whether Compliance runs. Both predicates live in `edges.ts` and never recompute a value another agent already reported.

Every graph node name is suffixed `-node` (`discovery-node`, not `discovery`) — LangGraph forbids a node name identical to a state channel name, and `workflowRegistry`'s own stepIds (`discovery`/`risk`/`compliance`/`report`) collide with four of `GraphState`'s channel names.

**`graph.ts`**'s `graphRegistry` lazily builds and caches one compiled graph per graphId. Caching is required, not an optimization: a compiled graph's `MemorySaver` checkpointer lives inside that object, so `run()` and `resume()` for the same execution must resolve to the exact same instance or LangGraph's interrupt/resume story breaks immediately. `resolveGraphId(goal, workflowId)` routes a goal mentioning "conditional" to `security-conditional`; everything else uses whichever workflow `ai/orchestrator/planner.ts` (Phase 17, unchanged) already resolved the goal to.

**`executor.ts`**'s `GraphExecutor` (`graphExecutor` singleton) is the composition root:
- `run(input)`: `GoalPlanner.createPlan()` (unchanged) -> resolve/build the graph -> `compiled.invoke(initialState, {configurable: {thread_id: executionId}})`.
- `resume(executionId)`: reads `compiledGraph.getState(config)`. If it shows a pending task, extracts the live `interrupt()` payload, fetches the *current* `ApprovalRequest` status, and resumes via `new Command({resume: {status, editedOutput}})` — LangGraph's own native mechanism, not a bespoke one. If `getState()` comes back empty (this process's in-memory `MemorySaver` has nothing for that thread — a genuine restart), it falls back to the durable `GraphCheckpointStore` snapshot and replays `values` back in as a fresh `invoke()` input on the same thread; every node's idempotent replay guard is what makes that a correct "fast-forward to where it left off" rather than a full re-run.
- Reads the *authoritative* final state from `compiledGraph.getState()` after every `invoke()`, not `invoke()`'s own return value — a round where every node's return is an empty patch (a fully idempotent replay with nothing left to do) can leave `invoke()` resolving `undefined`.

**`graph.checkpoint.ts`**'s `GraphCheckpointStore` persists `{executionId, graphId, values, next, pendingApprovals, updatedAt}` after every `invoke()`, via the exact same `MemoryStore`/JSON convention every other store in this codebase uses (Redis in production, 7d TTL). Deliberately does **not** attempt to serialize LangGraph's own internal `Checkpoint` format (`channel_versions`/`versions_seen`/pending writes) — `GraphState` is plain, JSON-safe domain data by construction, so persisting `values` directly is sufficient and far simpler than reimplementing `BaseCheckpointSaver`'s chaining semantics. This is a deliberate scope cut: `MemorySaver` (official, in-process) gives real interrupt/resume correctness *within* one process lifetime; this store is what survives a restart, via replay rather than checkpoint-internals fidelity.

**`graph.memory.ts`** wires Phase 16's `ConversationMemory`/`SessionMemory` and Phase 23's `KnowledgeStore` into the graph verbatim — no duplicate memory implementation, per spec.

**`graph.telemetry.ts`** adds `estateai_ai_langgraph_*` Prometheus metrics (runs total, duration, nodes visited, a structural "widest parallel wave" gauge computed once per graph definition, checkpoints persisted, retries). Per-node retries go through LangGraph's own official `RetryPolicy.retryOn` (passed to `addNode()`), reusing `ai/utils/retry-policy.ts`'s `isRetryableError` classifier unchanged — the same RECOVERABLE/PERMANENT rule `WorkflowEngine.runStep()` already applies.

**New API surface** (`routes/langgraph.ts`): `POST /ai/langgraph/execute` (plans+runs a goal, same "no separate execute step" shape Phase 25/26 established), `POST /ai/langgraph/:executionId/resume` (continues a paused graph — approval decisions still go through the *existing*, unchanged `POST /ai/approval/:id/approve|reject`), `GET /ai/langgraph/:executionId`, `GET /ai/langgraph/:executionId/state`.

**Module layout** (`apps/api/src/ai/langgraph/`):

```
state.ts             GraphStateAnnotation — the shared graph state schema.
graph.types.ts        GraphRunInput/GraphExecutionResult/GraphRunStatus/interrupt payload types.
graph-error.ts         GraphError.
nodes.ts               makeAgentNode() + the 6 pre-built node wrappers + reflectionNode.
edges.ts                hasDiscoveredResources()/riskScoreExceedsThreshold() — pure predicates.
graph-builder.ts        buildWorkflowGraph()/buildConditionalGraph(); registerGraphNode().
graph.ts                graphRegistry (lazy build+cache) + resolveGraphId().
graph.checkpoint.ts     GraphCheckpointStore — durable, Redis-backed snapshot persistence.
graph.memory.ts         Wires ConversationMemory/SessionMemory/KnowledgeStore into the graph.
graph.telemetry.ts      estateai_ai_langgraph_* Prometheus metrics.
executor.ts             GraphExecutor — run()/resume()/getExecution()/getState(); graphExecutor singleton.
index.ts                Barrel export.
```

**Design decisions worth calling out:**
- **Native LangGraph HITL over a custom pause mechanism.** `interrupt()`/`Command({resume})` are the official library's own human-in-the-loop primitives — using them (rather than porting `HitlOrchestrator`'s `condition`-gating trick into graph form) is both less code and a more faithful "use the official library" implementation. The two HITL mechanisms (Phase 26's condition-based one for `WorkflowEngine`, Phase 27's `interrupt()`-based one for LangGraph) coexist deliberately — both read the same `ApprovalPolicy`/`ApprovalEngine`/`ApprovalStore`, so a decision made via `POST /ai/approval/:id/approve` is visible to whichever execution path is waiting on it.
- **`ApprovalEngine.requestApproval()` gained an optional `id` parameter** (Phase 27 addition to Phase 26's engine — additive, every existing caller keeps its random-id default) specifically so `nodes.ts` could mint a deterministic id and stay replay-safe across `interrupt()`'s throw-to-pause semantics (see above).
- **Four real bugs found and fixed during this phase's own verification** (chronological): (1) node names colliding with state channel names (`discovery`-the-node vs. `discovery`-the-channel) — fixed with a `-node` suffix. (2) `invoke()`'s return value can be `undefined` on an all-empty-patch round — fixed by always reading `getState()` as the source of truth. (3) a plain static edge doesn't skip a dependent whose dependency was rejected/failed, since it only encodes topology, not outcome — fixed with `withDependencyGate()`. (4) the idempotent-replay guard checked `state[stateKey] !== undefined`, which a `FAILED` attempt never sets (only `SUCCESS` does) — a restart-replay silently re-invoked an already-failed agent; fixed by checking `executionTrace` for *any* terminal entry, not just the output slot.
- **`buildWorkflowGraph()` throws `GraphError` at build time for an unmapped agentId**, unlike `WorkflowEngine.runStep()`, which fails that one step at runtime (`AgentNotRegisteredError`, a `FAILED` `AgentTaskResult`) while every other step still runs. A deliberate difference: a graph's topology is fixed at compile time, so an unmapped node is a configuration error worth catching immediately rather than letting the graph partially run.

## LLM Planner — Dynamic Workflow Generation (Phase 28)

Adds a third, additive planning path alongside `GoalPlanner` (Phase 25, deterministic keyword matching to a *registered* workflow) and LangGraph's `resolveGraphId()` (Phase 27, same deterministic selection): an LLM-driven planner that reasons freely about a goal and produces a structured, validated step list, which becomes a LangGraph graph with **no registered workflow required at all**. `GoalPlanner`/`WorkflowEngine`/`GraphExecutor`/every existing route are untouched; every actual agent invocation still goes through `orchestratorAgentRegistry.get(agentId).execute(...)`, the exact same call every other execution path already makes.

**`planner.types.ts`** fixes the planner's whole vocabulary: `PLANNER_AVAILABLE_AGENTS` (the same six ids LangGraph's `nodeByAgent` map knows), `PLANNER_AVAILABLE_TOOLS` (five categories — `knowledge-search`/`github`/`postgres`/`filesystem`/`web-search` — mirroring `ai/tools/builtin/index.ts`'s five families), `LLMPlanStep`/`LLMPlan` (the validated shape), and `LLMPlanRecord` (what's cached/persisted/returned — folds spec #10's telemetry fields directly onto the record rather than a separate lookup, since every field is scoped to one planning call).

**`planner.prompt.ts`**'s `buildPlannerPrompt()` renders spec #3's exact section list (available agents, available tools, approval rules, memory summary, current graph state, user goal) as plain `LLMMessage[]` — not a `PromptTemplate` like every per-agent prompt (`ai/agents/*/*.prompts.ts`), since this prompt's shape is fixed code, not natural-language copy a non-engineer would tune. `buildRevisionPrompt()` re-prompts with the previous plan's own reasoning/confidence plus a feedback string for the reflection loop (spec #8); `buildRepairPrompt()` feeds a parse/validation failure back for a retry turn.

**`planner.parser.ts`** is a thin zod schema (`llmPlanDraftSchema`) over `ai/parser`'s existing `tryParse()` (strips ```json fences, reports schema-mismatch issues) — agent/tool *membership* isn't checked here, only shape, so a "not valid JSON" failure and a "valid JSON, unknown agent" failure produce distinctly worded errors.

**`planner.validator.ts`**'s `validatePlan()` is spec #5's exact rejection list — unknown agents, unknown tools, cycles (DFS-based `detectCycle()`), duplicate ids, missing dependencies, empty plans, invalid confidence (any value outside `[0,1]`, per-step and overall) — thrown as one `PlanValidationError` carrying every reason found, never a partial accept. A missing step `id` is auto-assigned (`step-N`); an agent/tool alias (`"Discovery"` → `discovery-agent`, `"web search"` → `web-search`) is normalized rather than rejected.

**`planner.memory.ts`**'s `gatherPlannerContext()` is spec #7's "must read ConversationMemory, SessionMemory, KnowledgeStore, ReflectionStore before planning" — reuses Phase 16's `ConversationMemory`/`SessionMemory` and Phase 23's `KnowledgeStore` verbatim (new instances, same underlying Redis store/keyspace as `ai/langgraph/graph.memory.ts`'s own singletons — this module has no dependency on `ai/langgraph`, since the planner is independent of, and precedes, whichever executor eventually runs its plan). `ReflectionStore` only supports get-by-executionId (no scan/query-by-goal), so "read reflection before planning" is honored for the one case that has an executionId to look up: `metadata.previousExecutionId`. Also computes `knowledgeVersion` — a cheap, deterministic proxy (`{docCount}:{latestUpdatedAt}`) for "has this asset's knowledge changed," used by the cache key.

**`planner.cache.ts`**'s `PlannerCache` keys on `sha256(goal|assetId|knowledgeVersion|model)` (spec #9), backed by the same injected `MemoryStore` pattern every other store in this codebase uses, TTL configurable via the constructor (default 15 minutes). `LLMPlanner.revise()` deliberately never reads/writes this cache — a revision is a direct response to *this run's* execution feedback, not something a later identical goal should reuse.

**`planner.telemetry.ts`** adds `estateai_ai_llm_planner_*` Prometheus metrics — prompt/completion tokens, latency, cache-hit counter, iterations, confidence, reasoning length (spec #10), mirroring `ai/langgraph/graph.telemetry.ts`'s own registration convention.

**`planner.ts`**'s `LLMPlanner` (`llmPlanner` singleton) coordinates the whole flow: gather context → check cache → prompt → generate (`aiFoundation.llmClient`) → parse+validate, with up to two repair turns feeding the failure back to the model → record telemetry → cache + persist to history. If the LLM path is unavailable (no real `OPENAI_API_KEY` — the expected state of most environments running this codebase, same graceful-degradation every agent's own LLM call site already has) or the response never validates within the repair budget, `fallbackPlan()` derives a plan from the existing, deterministic `GoalPlanner` instead — the LLM Planner **always** returns a usable, validated `LLMPlan`, it just isn't LLM-authored that time. `fallbackPlan()` only keeps steps whose agent is one of `PLANNER_AVAILABLE_AGENTS` (every real registered workflow already only uses these, so this is a no-op in practice — but `workflowRegistry` is general-purpose and mutable, so a step naming an outside agent is dropped rather than silently mistyped through). `PlannerHistoryStore` (append-only, same `MemoryStore` pattern) backs `GET /ai/planner/history` — kept inside `planner.ts` rather than a dedicated store file, since the spec's own file list doesn't name one.

**`planner.executor.ts`**'s `LLMPlannerExecutor` (`llmPlannerExecutor` singleton) is spec #6+#8: `execute()` calls `llmPlanner.plan()`, converts the validated `LLMPlanStep[]` into `GraphStepLike[]` and hands them to `ai/langgraph/graph-builder.ts`'s `buildDynamicGraph()` — **no predefined workflow id required**, unlike `ai/langgraph/graph.ts`'s `graphRegistry`, which always looks a graph id up in `workflowRegistry`. Runs the graph, then loops the Reflection Loop: if the reflected `overallConfidence` stays below a configurable threshold (default 0.6) and the iteration cap (default, and spec's own max, 3) hasn't been reached, calls `llmPlanner.revise()` with the failure feedback and re-runs on a fresh dynamic graph. Every step's `id` is translated onto the one *canonical* stepId its agent's pre-built LangGraph node already uses internally (`discovery` for `discovery-agent`, etc.) — `nodes.ts`'s pre-built nodes each bake their own stepId into every `executionTrace` entry they write, so an LLM-chosen arbitrary id (`"step-1"`) would otherwise break `withDependencyGate`'s `entry.stepId === dep` check; this also means a plan naming the same agent twice only actually runs it once (the idempotent replay guard treats the second as already attempted — a documented, deliberate limitation, not a crash).

**New API surface** (`routes/llm-planner.ts`): `POST /ai/planner/dynamic` (plans via the LLM, with the automatic revision loop, AND executes the resulting dynamic graph — same "no separate execute step" shape every prior phase's entry point uses), `POST /ai/planner/explain` (plans only — returns reasoning/steps/confidence without running anything, for a caller that wants to preview a plan first), `GET /ai/planner/history`.

**Module layout** (`apps/api/src/ai/llm-planner/`):

```
planner.types.ts        Agent/tool catalogs, LLMPlan/LLMPlanStep/LLMPlanRecord shapes.
planner.prompt.ts        buildPlannerPrompt()/buildRevisionPrompt()/buildRepairPrompt().
planner.parser.ts        Zod draft schema + tryParsePlan() (thin wrapper over ai/parser).
planner.validator.ts     validatePlan() — spec #5's rejection list; PlanValidationError.
planner.memory.ts        gatherPlannerContext() — Conversation/Session/Knowledge/Reflection.
planner.cache.ts         PlannerCache — goal+assetId+knowledgeVersion+model keyed, TTL'd.
planner.telemetry.ts     estateai_ai_llm_planner_* Prometheus metrics.
planner.ts               LLMPlanner + PlannerHistoryStore; llmPlanner singleton.
planner.executor.ts      LLMPlannerExecutor — dynamic graph + reflection loop; PlannerGraphInputError.
index.ts                 Barrel export.
```

**Design decisions worth calling out:**
- **`ai/langgraph/graph-builder.ts` gained `buildDynamicGraph(graphId, steps)`**, factored out of `buildWorkflowGraph()`'s own shared assembly logic (`buildGraphFromSteps()`) rather than duplicated — both now build off a minimal structural `GraphStepLike` shape, and `nodeByAgent` gained a `copilot-agent` entry (no pre-Phase-28 registered workflow references Copilot as a step, so this changes nothing for `buildWorkflowGraph()`'s existing callers).
- **A real bug found and fixed during this phase's own verification**: `fallbackPlan()` originally cast `step.agentId as PlannerAgentId` without checking it was actually one of the six known ids. A workflow using an outside agent id (a legitimate, general-purpose `workflowRegistry` registration) would silently produce a plan whose steps all failed to map onto a canonical stepId in `planner.executor.ts`'s `toGraphSteps()`, reaching `buildDynamicGraph()` with zero nodes and failing with LangGraph's own opaque `"reflection-node is not reachable"` error instead of a clear one. Fixed two ways: `fallbackPlan()` now filters to `PLANNER_AVAILABLE_AGENTS` only, and `planner.executor.ts` now throws a clear `PlannerGraphInputError` if that filtering ever leaves zero runnable steps, before ever calling `buildDynamicGraph()`.
- **Reflection Loop reuses execution, not just critique.** Spec #8 asks for Critic/Reflection to drive a revised plan on low confidence — rather than scoring the *plan* in isolation, `LLMPlannerExecutor` actually runs the dynamic graph first (so `reflectionNode`, unchanged from Phase 27, produces a real `overallConfidence` from actual agent outputs, not just the LLM's own self-reported `overallConfidence`), and only asks for a revision if that real, executed confidence is still too low.
- **No new memory implementation.** `planner.memory.ts` is Phase 16/23's stores wired in a second time (a new instance, same Redis keyspace as `ai/langgraph/graph.memory.ts`'s own singletons), not a parallel one — deliberate, since the LLM Planner must be usable independently of whichever executor (LangGraph's default graphs, or its own dynamic one) eventually runs the plan it produces.

## Multi-Agent Debate & Consensus (Phase 29)

Adds a fourth, additive execution path — alongside `WorkflowEngine`, LangGraph, and the LLM Planner's dynamic graphs — where four *existing* agents (Risk/Compliance/Recommendation/Copilot) run against the same asset and a new, independent layer cross-checks their outputs for disagreement before accepting them. No agent is modified, no agent's business logic is duplicated, and no agent's output is ever mutated: `DebateEngine` only ever calls `orchestratorAgentRegistry.get(agentId).execute(input, context)` — the exact call every other execution engine in this codebase already makes — and reads back exactly what each agent returned.

**The "critique" problem.** Spec #3's flow names who critiques whom ("Recommendation Agent critiques Risk output", "Compliance Agent critiques Recommendation"), but no agent's fixed `execute()` contract accepts "here is another agent's output, critique it" as input, and the phase's own IMPORTANT constraints forbid adding that. The resolution: every participant still just runs its own, existing, unmodified analysis over the same asset (`{assetId}`) — Recommendation Agent already reads Risk's output out of `OrchestrationContext.agentOutputs` for its own cross-referencing (Phase 20/21, unchanged), so recording each output into the shared context before calling the next agent is what makes that agent's own pre-existing logic naturally "aware of" the previous one. The actual critiquing — detecting where two agents' structured outputs disagree — is done by this phase's own new, allowed code (`consensus.scoring.ts`), never inside an agent. `critiques` on a `DebateTurn` is purely a documentation/telemetry label matching spec #3's diagram; it never drives control flow.

**Debate flow** (`debate.engine.ts`'s `DebateEngine.run()`):
1. Risk Agent runs (`{assetId}`), recorded into a shared `OrchestrationContext`.
2. Recommendation Agent runs — its own existing handoff logic already reads Risk's recorded output.
3. Compliance Agent runs.
4. `evaluateTrigger()` (spec #5): overall confidence < 0.6 (`LOW_CONFIDENCE`), OR `consensus.scoring.ts`'s `deriveConflicts()` finds a structural disagreement (`DISAGREEMENT`), OR Risk's `businessImpact` is `HIGH`/`SEVERE` (`HIGH_RISK`). If none apply, the debate stops here — `triggered: false`, the three analytical outputs are still returned, "execution continues normally" per spec.
5. If triggered: Copilot Agent runs with a plain-English message containing "summarize" (`debate.prompt.ts`'s `buildDebateSummaryMessage()`) — Copilot's own, unmodified `copilot.intent.ts` classifies this as `SUMMARIZE_REPORT`, an existing path that re-derives a fresh summary from the very Risk/Compliance/Recommendation state the debate just produced. No new business logic; Copilot decides how to answer exactly as it already does for any other caller.
6. `ConsensusEngine.compute()` assembles a `ConsensusReport` from the four participants' already-computed structured fields.

**`consensus.scoring.ts`** — pure, deterministic heuristics (same "documented heuristic, never an LLM judgment call" spirit as `ai/critic/confidence.ts`/`ai/planner/goal-planner.ts`):
- `classifyFindings()` — a Risk finding is "accepted" (corroborated) if the Recommendation Agent's own cross-referencing actually cited it (`RecommendationView.findingId`); everything else is "rejected."
- `computeAgreementScore()` — the accepted/total ratio (1.0 when Risk raised nothing at all).
- `deriveConflicts()` — four structural cross-checks: high/severe risk vs. a high compliance score; critical/high findings with zero recommendations; compliance failures with zero recommendations; any rejected (uncorroborated) finding. Reused verbatim by both the trigger check (step 4 above) and the final `ConsensusReport.conflicts`.
- `computeConsensusConfidence()` — a weighted blend of participant confidences and the agreement score (60/40).

**Reflection Integration (spec #6).** `ReflectionReport` (`ai/reflection/reflection.types.ts`) gained three optional fields — `debateSummary?`, `disagreements?`, `consensusConfidence?` — populated only when `ReflectionEngine.reflect()` is called with an optional new `DebateReflectionSummary` parameter (mirrors Phase 26's own additive `ReasoningPlan.approvalRequired?`). The type lives in `ai/reflection`, not `ai/debate`, so `ai/reflection` has zero dependency on `ai/debate` — `ai/debate` depends on `ai/reflection`, the same direction every later phase already depends on earlier foundational modules. `DebateEngine` builds a synthetic `ExecutionResult`/fallback `ReasoningPlan` from its own turns (mirroring `ai/langgraph/nodes.ts`'s `reflectionNode`/`toExecutionResult` pattern, but self-contained — `ai/debate` has no dependency on `ai/langgraph` either) and calls the existing `Critic` + `ReflectionEngine` + `reasoningFoundation.reflectionStore` unchanged; `GET /ai/reflection/:executionId` (Phase 25, unchanged) already reads a debate's reflection back using the `debateId` as the executionId.

**Memory (spec #7).** `debate.memory.ts`'s `DebateMemory` and `consensus.ts`'s `ConsensusStore` both use the same injected-`MemoryStore` (Redis-backed) pattern every prior store in this codebase already uses — no new memory tier. `DebateMemory` additionally maintains a per-asset history list (`store.append`/`getList`) for a future "past debates for this asset" query, alongside get/set-by-id for `GET /ai/debate/:id`.

**Telemetry (spec #8).** `estateai_ai_debate_*` Prometheus metrics — runs total (by triggered/not), duration, participants, messages exchanged, agreement %, confidence delta (`ConsensusReport.confidence` minus the pre-debate average participant confidence) — mirroring `ai/langgraph/graph.telemetry.ts`'s/`ai/llm-planner/planner.telemetry.ts`'s own registration convention.

**New API surface** (`routes/debate.ts`): `POST /ai/debate/start` (runs the debate — and, if triggered, computes consensus — in one call, same "no separate execute step" shape every prior phase's own entry point uses), `GET /ai/debate/:id`, `GET /ai/consensus/:id`.

**Module layout** (`apps/api/src/ai/debate/`):

```
debate.types.ts        DebateParticipantId/DebateTurn/DebateRecord/trigger reasons.
debate.prompt.ts        buildDebateSummaryMessage() — the message handed to Copilot.
debate.memory.ts        DebateMemory — get/set-by-id + per-asset history.
debate.telemetry.ts     estateai_ai_debate_* Prometheus metrics.
debate.engine.ts        DebateEngine — the whole flow; debateEngine singleton.
debate.ts               Composition root (mirrors ai/planner/reasoning.ts); debateFoundation.
consensus.types.ts      ConsensusReport/ConsensusConflict.
consensus.scoring.ts    Pure heuristics: classifyFindings/computeAgreementScore/deriveConflicts/...
consensus.engine.ts     ConsensusEngine — assembles scoring.ts's output into one ConsensusReport.
consensus.ts            ConsensusStore — persistence for GET /ai/consensus/:id.
index.ts                Barrel export.
```

**Design decisions worth calling out:**
- **Debate participants are read-only, unmodified agents.** All four calls go through `orchestratorAgentRegistry`, identical to every other execution engine — this phase adds zero new agent classes and zero new prompts calling `aiFoundation.llmClient` directly (Copilot's own existing LLM call, if any, is unchanged).
- **The trigger check and the final consensus conflicts share one function** (`deriveConflicts()`) rather than two separate implementations that could drift — a disagreement worth triggering a full debate over is, by construction, also worth reporting in the final `ConsensusReport`.
- **No resume/checkpoint story.** Unlike `GraphExecutor`/`LLMPlannerExecutor`, a debate run is short and stateless-per-call (no `interrupt()`/pause point) — there is nothing to resume. If a future write-capable, `MANUAL`-gated agent were ever added as a fifth participant, this would need revisiting.

## Long-Term Episodic Memory & Continuous Learning (Phase 30)

Adds a persisted "episode" per completed execution, indexed for semantic retrieval and read back before the next plan is made — so a similar goal on the same asset is planned with the memory of what happened last time. Existing planner, RAG, LangGraph, and reflection engine all keep their public behavior unchanged; every new piece is additive, and no new vector database is introduced.

**Where "completed execution" means.** There are four distinct places in this codebase where an execution actually finishes: `orchestrator/executor.ts` (the plain `WorkflowEngine` path), `planner/reasoning-orchestrator.ts` (the reasoning-first path behind `POST /ai/planner/plan`), `langgraph/nodes.ts`'s `reflectionNode` (LangGraph's own last node, also used by `LLMPlannerExecutor`'s dynamic graphs), and `debate/debate.engine.ts` (both the triggered and not-triggered paths). Each of these now calls `captureEpisodeSafely(input)` — a fire-and-forget wrapper (`void episodeExtractor.capture(input).catch(() => undefined)`) — with whatever it already has on hand (`ExecutionResult` always; `plan`/`criticReport`/`reflection`/`debate`/`consensus` when that call site produces them). This mirrors Phase 23's `indexAgentOutput` precedent exactly: capture must never delay or fail the execution it's observing.

**Episode Extraction** (`episode.extractor.ts`'s `EpisodeExtractor.capture()`): derives `agentsInvolved`/`failedSteps`/`retryCount` from `ExecutionResult.steps` (retry count sums each step's `attempts - 1`, the same formula `StateManager.finalize()` already uses elsewhere), takes `confidence` from the most authoritative source available (`reflection.overallConfidence` > `consensus.confidence` > an average of steps' own `confidenceScore`), and calls `episode.summary.ts`'s `deriveLessons()` for the Reflection Learning fields.

**Reflection Learning (spec #6)** (`episode.summary.ts`'s `deriveLessons()`): deterministic, heuristic derivation of What Worked / What Failed / Lessons Learned / Future Suggestions straight from data every execution already produces (`ExecutionResult.steps`' statuses/errors, `ReflectionReport.missingEvidence`/`weakRecommendations`/`overallConfidence`, `DebateRecord.triggerReasons`, `ConsensusReport.conflicts`/`agreementScore`) — no new LLM call, and `ReflectionEngine`/`ReflectionReport` themselves are not modified by this phase (the same "keep the earlier phase's own output shape untouched, do the extra derivation in the new module" pattern Phase 29 used for its own `debateSummary`/`disagreements`/`consensusConfidence` additions).

**Episode Indexing (spec #3)** (`episode.indexer.ts`): reuses the *existing* `KnowledgeStore`/`EmbeddingService`/pgvector storage — episodes are indexed as `documentType: 'EPISODE'`, a new value added to the `KnowledgeDocumentType` Postgres enum via an additive migration (`ALTER TYPE ... ADD VALUE`), with `sourceId: episode.episodeId` so a retrieved `KnowledgeDocument` can be resolved back to its full `Episode`. Episodes with no `assetId` (e.g. a goal with no asset in scope) are still captured and stored, just never indexed — `KnowledgeDocument` requires one.

**Episode Search (spec #3/#4)** (`episode.search.ts`'s `EpisodeSearch.search()`): calls the *existing* `RetrievalService.search()` filtered to `documentTypes: ['EPISODE']`, then resolves each hit back to its `Episode` via `KnowledgeStore.getDocument(id).sourceId` → `EpisodeStore.get()`. No second search implementation.

**Planner Integration (spec #4)** (`llm-planner/planner.types.ts`/`planner.memory.ts`/`planner.prompt.ts`, modified, additive): `PlannerContextSummary` gained a fifth summary field, `episodeSummary`, populated by a new `summarizeEpisodes()` in `planner.memory.ts` that calls `EpisodeSearch.search({goal, assetId, topK: 3})` alongside the four existing Phase 28 summaries (conversation/session/knowledge/reflection) in the same `Promise.all`, then appended into `buildPlannerPrompt()`'s memory section — the LLM Planner sees "similar past episodes: … lesson: …" the same way it already sees prior reflections.

**Tool Selection & Confidence Calibration (spec #5/#7)** (`episode.relevance.ts`): `computeToolReliability()`/`computeAgentReliability()` aggregate success rate, average latency/confidence straight out of stored episodes; `calibrateConfidence()` blends a base confidence with historical success rate/similarity/agent/tool reliability (weighted, gracefully degrading to the base confidence when a signal is missing). These are exposed as plain functions over `Episode[]`, not wired into any agent's live decision-making — the only existing "tool selector" in the codebase is Copilot's own stateless regex classifier (`copilot.tool-selector.ts`), which this phase deliberately does not modify (no general-purpose tool-selection facility exists yet to wire reliability data into).

**Episode Pruning (spec #8)** (`episode.store.ts`/`episode.pruner.ts`): `EpisodeStore` follows the same injected-`MemoryStore`/Redis pattern as `DebateMemory`/`ConsensusStore`, but keeps its per-asset history as a plain, rewritable JSON array under `set` (not a Redis list via `append`) specifically so `EpisodePruner` can delete arbitrary ids from the middle of a history — something `MemoryStore.append`/`getList` has no primitive for. TTL is passive (every record/history write carries a 7-day expiry, same convention as `DebateMemory`); `EpisodePruner.pruneAsset(assetId, {maxCount, archive})` is the active cap — once an asset's episode count exceeds `maxCount`, the oldest overflow is deleted, optionally first compressed into a longer-lived (30-day) `CompressedEpisode` (goal/outcome/confidence/lessons only, everything else dropped) so a pruned episode's lessons aren't lost outright. Pruning must be triggered explicitly; there is no background job that runs it automatically yet.

**Telemetry (spec #9)** (`episode.telemetry.ts`): `estateai_ai_episode_*` Prometheus metrics — captured total (by outcome), retrieval latency, reuse count (a search that found at least one match), learning hit rate (matches/requested), and a planner-improvement gauge (calibrated minus base confidence) — same registration convention as every other phase's own telemetry file.

**New API surface** (`routes/episodes.ts`): `POST /ai/episodes/search`, `GET /ai/episodes/:id`, `GET /ai/episodes/history`, `GET /ai/episodes/statistics` (per-asset agent/tool reliability). There is no manual "create episode" route — episodes only ever come from automatic capture, matching Phase 23's Knowledge Store precedent (automatic indexing is the primary path, not a manual one).

**Module layout** (`apps/api/src/ai/episodic-memory/`):

```
episode.types.ts        Episode/EpisodeCaptureInput/EpisodeSearchInput/reliability types.
episode.store.ts        EpisodeStore — get/set-by-id + rewritable per-asset history (Redis-backed).
episode.indexer.ts      EpisodeIndexer — indexes an Episode into the existing KnowledgeStore.
episode.search.ts       EpisodeSearch — semantic search via the existing RetrievalService.
episode.relevance.ts    computeAgentReliability/computeToolReliability/calibrateConfidence.
episode.summary.ts      deriveLessons()/buildEpisodeSummaryText() — Reflection Learning + indexed text.
episode.extractor.ts    EpisodeExtractor — turns an EpisodeCaptureInput into a persisted, indexed Episode.
episode.pruner.ts       EpisodePruner — max-count eviction + optional compressed archive.
episode.telemetry.ts    estateai_ai_episode_* Prometheus metrics.
episode.ts              Composition root (mirrors ai/debate/debate.ts); episodicMemoryFoundation.
index.ts                Barrel export + captureEpisodeSafely() fire-and-forget wrapper.
```

**Design decisions worth calling out:**
- **Capture is fire-and-forget everywhere.** None of the four call sites `await` `captureEpisodeSafely()` — an execution's own response/return is never delayed by episode capture or indexing, and a capture failure is swallowed (recorded via telemetry only), the same failure-isolation rule `indexAgentOutput` already established in Phase 23.
- **History lists are JSON arrays, not Redis lists**, specifically to make `EpisodePruner` possible — every other store in this codebase (`DebateMemory` included) uses `MemoryStore.append`/`getList`, which has no way to remove an item from the middle; `EpisodeStore` reads-modifies-writes its history under `set` instead.
- **`EPISODE` is a real Postgres enum value, not a free-form string** — added via an additive migration (`ALTER TYPE "KnowledgeDocumentType" ADD VALUE 'EPISODE'`), consistent with the existing `KnowledgeDocumentType` enum shape; no other document type's storage or query path changed.
- **No background pruning job yet.** `EpisodePruner.pruneAsset()` exists and is fully tested but nothing calls it on a schedule — a future phase (or a cron-style job) would need to wire it up.

## Python AI Service (`apps/ai-service`, Phase 31)

A standalone Python service (FastAPI + Pydantic + LangChain + LangGraph) that reimplements the six-agent AI layer — Discovery, Risk, Compliance, Recommendation, Report, Copilot — as real LangChain agents orchestrated by a real LangGraph `StateGraph`. Everything else in EstateAI stays in TypeScript. Full detail: [`apps/ai-service/README.md`](../apps/ai-service/README.md) and [`architecture-diagrams/phase-31-python-ai-service.md`](architecture-diagrams/phase-31-python-ai-service.md).

**`AI_SERVICE_MODE` (env, default `typescript`).** The one switch. `typescript`: the in-process TS agents run exactly as in Phases 18–22 — zero behavior change, the Python service need not even be running. `python`: the five `AI_*` job handlers in `job-dispatcher.ts` and `POST /ai/copilot/chat` delegate over HTTP to `apps/ai-service`. The TS agents are never removed — flipping the env var back is the entire rollback. The Fastify build, routes, request/response schemas, and `apps/web` are unchanged either way.

**Trust boundary — deterministic code stays the source of truth.** Fastify's `services/ai-service/verified-bundle.ts` reads the real `Finding` / `RiskScore` / `PolicyResult` / `Resource` rows (via the existing repositories, no new business logic) and ships them in the `RunRequest.verified` field. The Python security agents (Risk/Compliance/Recommendation/Report) reason *only* over that bundle — severities and scores are copied verbatim, never recomputed, and an agent that is handed no bundle fails rather than inventing one. The Recommendation agent additionally drops any generated item that does not cite a real upstream finding id / policy code. Copilot is the only agent that pulls data at runtime, and only through `tools/fastify_client.py`'s fixed GET-only path allowlist, forwarding the caller's bearer token so Fastify's ownership checks still apply.

**Contract.** `POST /v1/agents/{agent}/run` with generic `RunRequest`/`RunResponse` envelopes (`app/models/contract.py`). `RunResponse.output` mirrors the existing TS `*AgentOutput` interfaces 1:1, so `job-dispatcher` maps it straight into the same `JobExecutionResult` shape and `GET /jobs/:id` / the frontend see no difference. Every `/v1` route requires `X-Service-Token` (constant-time compare, never logged); `X-Correlation-Id` flows through to every log line and response.

**LangGraph.** `app/graph/` — typed `GraphState` with additive reducers; `discovery → (risk ∥ compliance) → recommendation → report`; Risk and Compliance run in one parallel superstep, Recommendation has two incoming edges and waits for both, Report is last. Checkpointing via `langgraph-checkpoint-postgres` (`AsyncPostgresSaver`, tables auto-created on startup, reuses the existing database — the project's `redis:7` lacks the RedisJSON module the redis saver needs). HITL is `interrupt_before=["report"]` when `requireApproval` is set, resumed by `POST /v1/graph/{id}/resume`. Graph endpoints: `execute`, `{id}/resume`, `{id}`, `{id}/state`.

**RAG.** `app/rag/` — `LocalHashEmbeddings` is a byte-for-byte port of Fastify's `LocalHashEmbeddingProvider` (same sha256-bucket-and-sign algorithm, same 1536 width, same `local-hash-v1-1536` version string), so query vectors are directly comparable to the ones the TS indexer already wrote to `KnowledgeDocument.embedding`. Retrieval runs the same `1 - (embedding <=> $vec::vector)` cosine query as `KnowledgeRepository.search`. Read-only; no schema change; no re-indexing.

**Persistence.** Python owns exactly two new tables, `AiPyRun` and `AiPyTrace` (Prisma migration `add_ai_py_traces`), plus the LangGraph checkpoint tables. It is never granted write access to `AIRequestLog` / `RetrievalTrace` / `ToolExecutionTrace` or any domain table. Redis keys are all under the `ai:py:` namespace (conversation history + session state), disjoint from the TS AI subsystem's keys.

**Memory / planning / reflection / HITL / debate.** Conversation + session memory: Redis, `ai:py:` namespace, degrades to in-process on Redis loss. Planning is expressed as the LangGraph DAG itself. Reflection: the Recommendation agent's grounding filter (verify-then-drop). HITL: LangGraph interrupt/resume. Debate/consensus is **not** re-implemented in Python for Phase 31 — it remains available via `AI_SERVICE_MODE=typescript` and is listed under "What does not exist yet".

## Python AI Service — LangGraph orchestration (`apps/ai-service/app/graph`, Phase 32)

Phase 32 makes LangGraph a real orchestration layer. `app/graph/` is split into `state.py`, `nodes.py`, `routing.py`, `errors.py`, `checkpointer.py`, `telemetry.py`, `security_graph.py`, `copilot_graph.py`, `runtime.py`. Diagrams: [`architecture-diagrams/phase-32-langgraph-orchestration.md`](architecture-diagrams/phase-32-langgraph-orchestration.md).

**Typed state + reducers.** `SecurityGraphState` / `CopilotGraphState` are `TypedDict`s. Append-only lists (`completed_nodes`, `warnings`, `errors`) use `operator.add`; keys several concurrent nodes touch (`node_timings`, `retry_counts`, `metadata`) use a `merge_dict` reducer; display scalars concurrent nodes may both set (`current_node`) use a `take_last` reducer — so a parallel superstep never raises `InvalidUpdateError`. **No secret is ever a state field** — the security agents work purely from `verified_context` and never call back out; the Copilot bearer token lives in a non-persisted per-request registry (`runtime.py`). State stays JSON-serializable for the checkpointer, and `/state` strips `verified_context` from what it returns.

**Node adapters.** `make_agent_node(...)` is one reusable adapter: pull the right verified bundle → `agent.execute()` (which already validates its Pydantic output) → classify any failure (`errors.py`, 7 categories) → **bounded** retry only for `transient_infra` / `llm_failure` / `invalid_output` / `tool_failure` (never `authorization` / `missing_context` / `permanent`) → wall-clock timing + telemetry + a partial state update. Three non-agent control nodes: `await_approval`, `finalize_no_resources`, `revise`.

**Graph shape.** `discovery → [conditional] → (risk ∥ compliance) → recommendation → [conditional] → (await_approval | report) → [conditional] → (report | revise)`. Risk ∥ Compliance is a real fan-out (the conditional edge returns `["risk","compliance"]`); Recommendation has two static incoming edges so LangGraph waits for both (`test_graph_parallel.py` proves overlap with timed stand-ins). **Every routing condition is deterministic** — a resource count, a severity count, or the human decision — never LLM text.

**HITL.** LangGraph's dynamic `interrupt()` inside `await_approval`, reached only when `counts.critical > 0` or the API caller set `requireApproval`. The `ApprovalRequest` (execution id, requested action, reason, severity counts, timestamp, correlation id) is checkpointed; resume is `Command(resume={"approved": bool, "note": str})`. Approve → `report`; reject → `revise` (no report; recommendations retained). `test_integration.py` runs the full `execute → interrupt → inspect → resume → complete` lifecycle across three simulated cold service processes (fresh pool + `AsyncPostgresSaver` each time), keyed only by the execution id.

**Copilot graph.** A dedicated `StateGraph`: `understand_intent → retrieve_knowledge → decide_tools → (run_tools | generate_answer)`. `decide_tools` is deterministic; `run_tools` is a LangChain ReAct loop over the unchanged Phase 31 read-only tool allowlist. Redis (`ai:py:`) carries conversation continuity; the graph uses an in-process `MemorySaver`. `/v1/agents/copilot/run` and `CopilotAgent` are thin adapters over it.

**Observability.** `telemetry.py` reuses the Phase 31 tables — one `AiPyRun` per graph execution (`agent = "graph:security-analysis"`, keyed by the execution id) plus one `AiPyTrace` per node (`kind = "node"`, carrying duration + retry count + error class). No new schema, no second logging system; the secret-redaction processor is unchanged.

## Python AI Service — final AI capabilities (Phase 33)

Phase 33 completes the Python AI layer: a real dynamic planner, real debate/consensus, an explicit reflection loop, the full security graph reachable from Fastify, and the removal of redundant LLM calls. Diagrams: [`architecture-diagrams/phase-33-final-ai-layer.md`](architecture-diagrams/phase-33-final-ai-layer.md).

**Claude provider (`app/llm/provider.py`).** `get_chat_model()` returns `ChatAnthropic` when `LLM_PROVIDER=anthropic` and `ANTHROPIC_API_KEY` is set, otherwise the `DeterministicFakeChat`. Model id is `ANTHROPIC_MODEL` (falls back to `LLM_MODEL`, default `claude-sonnet-4-5`). `verify_anthropic_config()` constructs the client without a network call (used by tests / the live-check script). `structured_output(schema, …)` wraps `with_structured_output` with **bounded** Pydantic-validation retry (`STRUCTURED_OUTPUT_MAX_RETRIES`) then a caller-supplied fallback — an LLM can never push malformed data downstream. **No live Claude inference was executed in this environment (no API key available).**

**Dynamic planner (`app/planner/`).** `DynamicPlanner.plan()` asks the LLM for a structured `Plan` (via `with_structured_output`), then `validate_plan()` rejects — never repairs — a plan that names an unknown agent/tool, has a cycle, a missing/duplicate/mis-shaped dependency, or an out-of-range confidence (`PLANNER_MAX_REPAIR_ATTEMPTS` re-asks, then a deterministic full-analysis fallback plan is used). `PlanExecutor` compiles the *validated* plan into a real LangGraph `StateGraph` — one node per step, edges from `depends_on` — run on the Postgres checkpointer with an `interrupt()` HITL gate before any `report` step when `require_approval` is set. The executor only ever instantiates the six registered agents; no arbitrary callables, SQL, or HTTP. Endpoints: `POST /v1/planner/{plan,execute,{id}/resume}`, `GET /v1/planner/{id}`.

**Debate / consensus (`app/debate/`).** A LangGraph: `risk ∥ compliance → recommendation → aggregate → consensus → [conflicts && round < DEBATE_MAX_ROUNDS] → reconsider → aggregate …`. Participants give independent grounded opinions (verified findings/scores copied verbatim). `aggregate` / `consensus` are a direct port of the deterministic TS `consensus.scoring.ts` heuristics — agreement score, conflict list, accepted/rejected findings, blended confidence. `reconsider` is a bounded LLM round that restates *interpretation* only. Endpoint: `POST /v1/debate/run`.

**Reflection / verification (`app/reflection/`).** `ReflectionRunner.run(agent, run_once, …)` is a bounded verify→revise loop (`REFLECTION_MAX_ITERATIONS`). `verify_output()` is deterministic: schema completeness, grounding (recommendations cite the verified set; findings have reasoning/evidence), and **fact-consistency** with the verified bundle (risk score / counts, compliance score). A verified-fact mismatch is *flagged and returned* — never "fixed" by looping. The Copilot graph gained a `verify_answer` node applying the same idea to a chat answer. Also exposed as a LangGraph via `build_reflection_graph()`.

**Full security graph from Fastify (33.7).** New `JobType.AI_FULL_ANALYSIS` + `POST /ai/graph/analyze` (202 + `{jobId}`, same async contract as every AI route). Fastify assembles all three verified bundles and `delegateFullAnalysisJob` calls `POST /v1/graph/execute` — the complete `discovery → risk ∥ compliance → recommendation → (HITL) → report` LangGraph runs as one checkpointed workflow. The individual `AI_*` agent jobs are unchanged. Under `AI_SERVICE_MODE=typescript` the route returns `409` (no in-process TS equivalent of the whole graph).

**No redundant recomputation (33.8).** `delegateRecommendationJob` / `delegateReportJob` now pass the **raw deterministic rows** (`findings` / `policyResults`) instead of running the Risk and Compliance *agents* first. The Python Recommendation/Report agents synthesize a minimal, **LLM-free** upstream context from those rows (`app/agents/synthesize.py`) — removing two LLM round trips per recommendation/report job. Inside the security graph the true node outputs are still used.

**RAG (33.9).** `KnowledgeRetriever.search()` gained `tags` metadata filtering, per-query `min_score`, and near-duplicate collapsing (`RAG_DEDUPE`, over-fetch then dedupe by normalized text). `format_context()` is capped at `RAG_MAX_CONTEXT_CHARS`; `citations_for()` returns structured citations (id, source type, score, snippet) preserved verbatim. pgvector / `KnowledgeDocument` unchanged; no new vector store.

**Tools (33.10).** The five read-only tools are unchanged in scope. Error handling now distinguishes an *authorization* failure (path allowlist / Fastify ownership) from a transient callback failure, and never raises into the ReAct loop. The `FastifyCallbackClient` still issues only `GET` to an explicit path allowlist.

**Memory (33.11).** `history()` trims to a char budget (`_CONTEXT_WINDOW_CHARS`) and turn count so a long conversation can't blow the model context; every stored turn is secret-scrubbed (bearer/API-key regex) and length-capped; every Redis read/write is wrapped so a memory failure degrades to empty rather than failing the request. Session state rejects any key containing "token".

## Frontend (`apps/web`, Phase 9)

A separate deployable — Next.js (App Router, Turbopack) + TypeScript + Tailwind CSS — that consumes `apps/api` purely as an HTTP client, over the existing Bearer-token contract. No backend file changed to support it; every request this app makes goes through a route documented in `docs/API_REFERENCE.md` before this phase started.

```
Page (client component)
  → useApiQuery(fetcher, deps) — loading/error/success state machine
  → <QueryBoundary query={...}> — renders LoadingState / ErrorState / EmptyState / children
  → lib/api/<domain>.ts — one thin module per backend domain (assets, accounts, jobs,
     resources, analysis, policies, agents, copilot), each just a typed wrapper over:
  → lib/api/client.ts — apiRequest(): attaches `Authorization: Bearer <token>` from
     localStorage, retries exactly once on 401 after a single-flight
     POST /auth/refresh, throws ApiError (any other non-2xx) or SessionExpiredError
     (401 that survives a refresh attempt)
```

`AuthProvider` (`lib/auth/AuthProvider.tsx`) is the top-level client-side auth context: on mount, if a token exists in `localStorage` it's resolved via `GET /auth/me`; `login()`/`logout()` wrap `POST /auth/login`/`POST /auth/logout`. `AuthGuard`/`AppShell` (`components/layout/`) redirect to `/login` whenever `AuthProvider`'s status is `unauthenticated` — every protected page renders through `AppShell`, which composes `Sidebar` + `Topbar` + the guard.

### Pages (`src/app/`)
`/login` (public) · `/dashboard` · `/assets` (list + inline create form) · `/assets/[id]` (Overview — asset info, connected accounts with connect/sync/discover/disconnect, recent activity) · `/assets/[id]/discovery` (resources + discovery job history) · `/assets/[id]/findings` (severity/status-filterable) · `/assets/[id]/risk` (risk score + severity distribution + open recommendations) · `/assets/[id]/compliance` (compliance score + risk distribution + policy failures) · `/assets/[id]/report` (AI Report — `OFF`/`SUMMARY`/`FULL_REPORT` mode selector calling `POST /agents/execute`) · `/assets/[id]/copilot` (AI Copilot Chat calling `POST /copilot/chat`) · `/settings` (read-only profile — no update-profile endpoint exists to back an edit form). The 6 asset-scoped pages are tabs (`AssetTabs`/`AssetPageShell`) under one asset, not top-level routes — every one of their backing endpoints is itself asset-scoped in the API, so there's no "all findings across every asset" view to build.

### Shared components (`src/components/`)
`layout/` (`Sidebar`, `Topbar`, `AppShell`, `AuthGuard`, `AssetTabs`, `AssetPageShell`), `ui/` (`StatsCard`, `DataTable`, `DistributionBarChart` — a thin `recharts` wrapper, `SeverityBadge`/`RiskScoreBadge`/`StatusBadge`, `Card`, `Button`, `LoadingState`/`EmptyState`/`ErrorState`, `QueryBoundary`), `copilot/ChatPanel` (no conversation persistence, matching Phase 8's own stateless `POST /copilot/chat` — messages live only in component state), `report/ReportViewer` (renders a `SecurityReportData`, including its optional `aiReport` narrative or a FAILED-status message, mirroring Phase 7D's graceful-degradation contract).

### Types (`src/lib/types.ts`)
Hand-kept TypeScript mirrors of the shapes documented in `docs/API_REFERENCE.md` — not generated from an OpenAPI spec (none exists) and not shared via `packages/shared` (an empty placeholder, unused by this phase). Verified by hand against the real running API for every shape this frontend actually consumes (register → promote to admin via direct repository access → create category/asset/account → call every consumed endpoint), not assumed from documentation alone.

## Real-Time Platform (Phase 10)

Adds a `GET /ws` WebSocket upgrade endpoint broadcasting live `AssetEvent`s to subscribed clients — no existing REST route was modified, and no business service (`services/assets`, `services/jobs`, `services/agents`, `services/ai`, `services/copilot`, etc.) imports anything from the WebSocket layer. This works because every event type the system has ever emitted, across every phase, already flows through one function:

```
Any service (JobExecutor, AgentOrchestrator, AIService, ReportAgent, CopilotService, ...)
  → eventService.createForAsset(assetId, requester, {type, severity, title, metadata})
    1. getOwnedAsset(assetId, requester)
    2. eventRepository.create(...) — the AssetEvent row, exactly as before Phase 10
    3. realtimeBus.publishAssetEvent({assetId, event}) — NEW, best-effort, wrapped in try/catch
  → returns the created AssetEvent, exactly as before Phase 10
```

`realtime-bus.ts` (`services/realtime/`) is a generic, protocol-agnostic in-process pub/sub primitive built on Node's `EventEmitter` — deliberately not "WebSocket logic". This is the one dependency `EventService` gained; it has no knowledge that a WebSocket layer (or anything) is listening. `services/websocket/websocket-gateway.ts` is the only subscriber, registered once at module load:

```
services/websocket/
  connection-registry.ts   — pure in-memory bookkeeping: connections by id, and a reverse
                              index (assetId -> connection ids) for O(subscribers) broadcast
  websocket-auth.ts        — authenticateSocket(token): reuses verifyJwtService +
                              userRepository, the same two pieces src/plugins/auth.ts composes
                              for REST, just without a request/reply pair — the one departure
                              from Bearer-header auth (forced by the WebSocket transport: a
                              browser WebSocket can't set custom headers, so the token travels
                              as ?token=... instead)
  websocket-gateway.ts      — the Fastify route + protocol: on connect, authenticate or close
                              (4401); on 'subscribe'/'unsubscribe', getOwnedAsset() (the same
                              ownership check every other asset-scoped endpoint uses) then
                              update the registry; on realtimeBus's assetEvent, fan out to
                              every connection subscribed to that assetId
  dto/messages.ts           — ClientMessage ({subscribe|unsubscribe, assetId}) and
                              ServerMessage ({connected}|{subscribed}|{unsubscribed}|
                              {event, assetId, event: AssetEvent}|{error, message}) — `event`
                              reuses the exact AssetEvent shape GET /assets/:id/events returns
```

No session state persists across connections — closing a socket drops all its subscriptions, and a reconnecting client must re-send `subscribe` for each asset it still cares about (this is deliberate, not a gap: see DECISIONS.md).

### Frontend real-time layer (`apps/web`, Phase 10)
`RealtimeProvider` (`lib/realtime/`) owns one WebSocket connection per authenticated session — connects once `AuthProvider`'s status is `authenticated`, reconnects with exponential backoff (capped at 15s) on any close, and resubscribes to every asset any component still cares about immediately after each `{type:'connected'}`. `useAssetEvents(assetId, onEvent)`/`useMultiAssetEvents(assetIds, onEvent)` are the two hooks every page uses to listen — ref-counted under the hood, so five components subscribing to the same asset still only sends one `subscribe` message. `AssetPageShell` is wired to push terminal/attention-worthy events (failures, warnings, `*_COMPLETED`) into `ToastProvider`'s toast stack ("live notifications"); `Topbar` shows a global connected/reconnecting indicator; `DashboardPage` debounce-refetches on any event for any listed asset ("auto-refresh dashboard/cards"); `DiscoveryView`/`AssetOverview` refetch jobs/resources/accounts live on `JOB_*`/`RESOURCE_*`/etc ("live job status"); `ReportView` renders a live `PLAN_*`/`AGENT_*`/`AI_REPORT_*` progress log while a report is generating ("agent progress in real time").

## Production Readiness (Phase 11)

Cross-cutting operational concerns — logging, metrics, health, Docker, a reverse proxy, and edge security — layered on top of the platform built in Phases 1–10 without touching any existing route contract, business service, or the database schema.

### Observability (`src/observability/`, `src/plugins/observability.ts`)
```
src/observability/
  logger.ts    — pino config (level, redaction, dev-only pretty transport) shared by
                 both Fastify's own request logger (passed as the `logger` option to
                 Fastify(), so every request/response line is already structured JSON
                 with a requestId attached — Phase 11 adds no separate HTTP-request
                 logging of its own) and a standalone `logger` export for code with no
                 request context: job-executor.ts, ai.service.ts, connection-registry.ts
  metrics.ts   — one shared prom-client Registry + every estateai_* metric definition
```
`plugins/observability.ts` (called directly on the root Fastify instance, same convention as `authPlugin`) adds the two concerns every request needs regardless of route: an `x-request-id` response header plus a spliced-in `requestId` field on any 4xx/5xx JSON body (via an `onSend` hook — no individual route's local `mapXError` needed to change), and per-request HTTP metrics (`onResponse` hook, labeled by method/matched-route-template/status — never the raw URL, to avoid unbounded label cardinality on e.g. `/assets/:id`).

**Metrics** (`estateai_*` prefix, `GET /metrics`, Prometheus text format):
| Metric | Kind | Wired from |
|---|---|---|
| `http_requests_total`, `http_request_duration_seconds` | Counter, Histogram | `plugins/observability.ts` |
| `ai_requests_total`, `ai_request_duration_seconds`, `ai_tokens_total` | Counter, Histogram, Counter | `AIService.recordAndEmitSuccess/Failure` |
| `websocket_active_connections`, `websocket_active_subscriptions` | Gauge | `connection-registry.ts` (`register`/`unregister`/`subscribe`/`unsubscribe`) |
| `job_queue_size` | Gauge (async `collect()`) | `jobRepository.countPending()`, read fresh at scrape time |
| `job_execution_duration_seconds`, `jobs_failed_total` | Histogram, Counter | `job-executor.ts`'s `execute`/`handleFailure` |

Plus `collectDefaultMetrics()` (Node process/event-loop/GC metrics) for free. No new business service was modified to add these — `AIService` and `job-executor.ts` were touched (they already own the exact success/failure branches these metrics need), and `connection-registry.ts` (already the sole place WebSocket connection/subscription state changes) gained a few counter/gauge calls, the same "hook the one chokepoint, not every caller" pattern Phase 10 used for `EventService.createForAsset()`.

### Health (`src/routes/health.ts`)
`GET /health/ready` gained a third check, `ai: {provider, configured}` — a config-only check (does the configured default provider have an API key set), never a live vendor call, and it never affects the 503/200 status. This is deliberate: `config.ai`'s own doc comment already establishes that API keys are optional at the env layer and providers fail per-request, not at startup — the readiness check surfaces *why* AI-mode requests might fail without taking non-AI traffic out of rotation over it.

### Security middleware (`src/server.ts`)
`@fastify/helmet` (CSP disabled — this is a pure JSON API with a separate frontend deployable, not an HTML-rendering server), `@fastify/cors` (origin from `CORS_ORIGIN`), `@fastify/rate-limit` (`RATE_LIMIT_MAX`/`RATE_LIMIT_WINDOW_MS`, `/health*` and `/metrics` on an `allowList` since they're polled by infra, not real traffic), and Fastify's own `bodyLimit` constructor option (`BODY_LIMIT_BYTES`) — registered first, before every route, same ordering reasoning as `authPlugin`/`observabilityPlugin`.

### Configuration (`src/config/env.ts`)
New Zod-validated vars: `LOG_LEVEL` (optional — when unset, derived from `NODE_ENV`: `debug` in development, `warn` in test, `info` in production), `METRICS_ENABLED`, `CORS_ORIGIN`, `RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW_MS`, `BODY_LIMIT_BYTES`. Every other Phase 11 concern reuses `NODE_ENV`'s existing three-way `development`/`test`/`production` split (introduced at Phase 1) rather than adding a second environment axis.

### Docker (`apps/api/Dockerfile`, `apps/web/Dockerfile`, `docker-compose.{dev,prod}.yml`, `.dockerignore`)
Both Dockerfiles are multi-stage (`deps` → `build` → `runtime`, plus a `dev` stage for hot-reloading), built with the repo root as context (`docker build -f apps/api/Dockerfile .`) since this is a pnpm workspace and both apps' installs need the workspace's `pnpm-lock.yaml`. `apps/api`'s `runtime` stage installs only production dependencies (a separate `deps-prod` stage) and ships `dist/` — no source, no devDependencies, no Prisma CLI. `apps/web`'s `runtime` stage uses Next's `output: 'standalone'` (added to `next.config.ts`); the standalone output for a pnpm workspace mirrors the monorepo's own directory nesting (a root `node_modules` with the pnpm store, `apps/web/node_modules` full of symlinks pointing back into it) because pnpm's `node_modules` are symlinks — the runtime image preserves that same `/repo/apps/web` nesting rather than flattening it into `/app`, otherwise every symlink's relative target breaks (see DECISIONS.md). Both images were built and run end-to-end during this phase's verification, not just written and assumed correct.

`docker-compose.yml` (pre-existing, Phase 0.5) stays infra-only (Postgres + Redis) for `pnpm dev` on the host. `docker-compose.dev.yml` is a self-contained superset — Postgres + Redis + both apps built to their Dockerfiles' `dev` target, source bind-mounted for hot reload. `docker-compose.prod.yml` is the full production stack — Postgres + Redis + both apps' `runtime` images + nginx — self-contained, not extending the other two files, since a production compose shouldn't silently inherit a dev-infra file's assumptions. Neither compose file runs `prisma migrate deploy` automatically on container start (a deliberate omission, see DECISIONS.md) — migrations are a separate, explicit deploy step.

### Reverse proxy (`nginx/nginx.conf`)
Fronts `docker-compose.prod.yml`'s `api`/`web` services: routes `/ws` (with the `Connection`/`Upgrade` header forwarding nginx's WebSocket proxying needs, plus long `proxy_read_timeout`/`proxy_send_timeout` since these connections are intentionally long-lived) and every REST path prefix (`/auth`, `/assets`, `/health`, `/metrics`, etc. — no path rewriting, since `apps/api`'s routes were never namespaced under `/api`) to `api:3000`; everything else to `web:3001`. Also owns gzip compression and the browser-facing security headers (`X-Frame-Options`, `X-Content-Type-Options`, etc.) — belt-and-suspenders alongside `@fastify/helmet`, since nginx is the edge every browser request actually reaches first in this topology.

### CI/CD (`.github/workflows/ci.yml`)
Three jobs: `install-lint-build` (lint + build both apps), `regression` (Postgres + Redis service containers, builds and starts `apps/api`, then runs every `verify:*` script — the exact same suite this phase's own regression run used), `docker-build` (builds both Dockerfiles' `runtime` target, no push). Mirrors the local dev/verification workflow exactly rather than inventing a CI-specific test suite.

### `verify-production.ts`
Exercises Phase 11+12's own surface (health/ready incl. every field, `/metrics` content and key series, `x-request-id`/`x-correlation-id` on success and error responses, security headers/CORS/compression, Docker compose validity + both images actually building) plus a live regression check that Phase 10's WebSocket delivery, Phase 7B's AI generation, and Phase 4's job worker pool all still function unchanged — not by re-running their own dedicated verify scripts, but by exercising each through the running server directly, the same way an operator's own smoke test would.

## Cloud Production Readiness (Phase 12)

Extends Phase 11's observability/security/Docker foundation — no new REST route contract changed, no database migration, no business logic touched. Where a Phase 12 requirement already had a Phase 11 answer (Docker, `docker-compose.*.yml`, `.dockerignore`, `GET /metrics`, `verify-production.ts` itself), this phase extended the existing artifact rather than duplicating it; genuinely new pieces are called out below.

### Structured logging: one unified request log line, not Fastify's automatic pair
`plugins/observability.ts` was rewritten to replace Fastify's own automatic "incoming request"/"request completed" log lines (`disableRequestLogging: true`, `server.ts`) with a single structured line per request, emitted from the same `onResponse` hook that already recorded HTTP metrics:
```
{ requestId, correlationId, userId, assetId, method, route, statusCode, responseTimeMs,
  err?: { message, stack } }   // err only present when the request errored (5xx)
```
- `requestId` — `request.id` (Fastify's `genReqId`, `server.ts`): an inbound `x-request-id` or `x-correlation-id` header wins if present, else a fresh `randomUUID()`.
- `correlationId` — the inbound `x-correlation-id` header if the caller supplied one, else falls back to `requestId`. Echoed back on every response via an `x-correlation-id` header (`onSend` hook), same as `x-request-id` already was.
- `userId`/`assetId` — best-effort: `userId` from `request.user` (set by `plugins/auth.ts`'s `authenticate`, so absent on unauthenticated routes); `assetId` from a route param (`:assetId`/`:id`), query string, or body, whichever has it — a logging convenience, not a contract.
- `err.stack` — captured via a new `onError` hook (the only lifecycle point that receives the thrown error) and stashed on the request for the `onResponse` line to read; log level is `error` (5xx), `warn` (4xx), or `info` (2xx/3xx) accordingly.

Job logs (`job-executor.ts`, already structured at Phase 11) already carry `jobId`/`jobType`; their own `correlationId` is the job's own `id` (see "Correlation ID scoping" in DECISIONS.md for why this isn't threaded from the originating HTTP request).

### New metrics
| Metric | Kind | Wired from |
|---|---|---|
| `http_errors_total` | Counter | `plugins/observability.ts`'s `onResponse` hook, alongside the existing `http_requests_total` |
| `ai_failures_total` | Counter | `AIService.recordAndEmitFailure()` — same data as `ai_requests_total{status="FAILED"}`, exposed as its own series per the spec's explicit "AI failures" tracking item |
| `worker_utilization_ratio` | Gauge (`collect()`) | `WorkerPool.stats()` (new — `{total, running, busy, utilization}`, itself built on a new `Worker.isBusy` getter) |
| `discovery_duration_seconds` | Histogram, labeled `provider`/`success` | `DiscoveryService.discover()` directly — isolates discovery's own cost from `job_execution_duration_seconds{type="DISCOVERY"}`'s job-framework overhead (see DECISIONS.md) |

Memory/CPU usage were already covered by Phase 11's `collectDefaultMetrics()` (`estateai_process_resident_memory_bytes`, `estateai_process_cpu_seconds_total`, `estateai_nodejs_*`) — no new instrumentation needed there.

### Readiness: worker/queue/memory/disk
`GET /health/ready` gained four more informational fields (see "What does not exist yet" → extends Phase 11's AI-check precedent, DECISIONS.md):
- `workers` — this process's own `WorkerPool.stats()`, `status: 'disabled'` if `WORKERS_ENABLED=false`, `'degraded'` if enabled but zero workers are actually running.
- `queue` — `JobService.getQueueHealth()` (new): queue size (`jobRepository.countPending()`) plus the age of the oldest **QUEUED** (never-yet-attempted) job — deliberately excludes RETRYING jobs, which can legitimately wait out a long backoff (`JOB_RETRY_BACKOFF_MS`) without indicating a real problem. `status: 'degraded'` past `QUEUE_UNHEALTHY_AGE_MS`.
- `memory` — `process.memoryUsage()` compared to `MEMORY_WARNING_BYTES`.
- `disk` — `fs.promises.statfs(process.cwd())` compared to `DISK_WARNING_BYTES`; `status: 'unknown'` if `statfs` isn't available on the host/filesystem, rather than failing the check.

### Security: compression + trusted proxy support
- `@fastify/compress` (`server.ts`, gated by `COMPRESSION_ENABLED`) — gzip/brotli response compression at the app level, complementing nginx's own edge-level gzip in production (so compression still applies when the API is hit directly, e.g. in dev or by verify scripts).
- `trustProxy` (Fastify constructor option, driven by `TRUSTED_PROXIES`) — `docker-compose.prod.yml` sets it to `'true'` for `api` (exactly one nginx hop in front); the default `'false'` (no proxy trusted) is correct for any topology without one in front. This is what makes `request.ip` — and therefore `@fastify/rate-limit`'s per-IP bucketing — reflect the real client instead of nginx's own container address.

### nginx: rate limiting + caching
`nginx/nginx.conf` gained a `limit_req_zone` (20r/s, `burst=40 nodelay`) applied to both the API and frontend locations — a coarser, defense-in-depth complement to `apps/api`'s own `@fastify/rate-limit`, not a replacement (see DECISIONS.md for why the two aren't unified). A `proxy_cache_path` + `location /_next/static/` block caches Next.js's content-hashed static assets aggressively (`Cache-Control: immutable`, 7-day nginx cache) — nothing else is cached, since every other route is either per-user/JWT-authenticated (the API) or needs to stay live (the app shell HTML).

### Deployment documentation (`docs/DEPLOYMENT.md`, new)
One consolidated guide (matching this docs/ directory's existing one-file-per-concern pattern) covering: deployment steps (first deploy, subsequent deploys, TLS, using a managed database), the production environment variable reference (the subset of `.env.example` that actually matters for a real deploy, with why), scaling (vertical, horizontal HTTP behind nginx, horizontal job workers via `WORKERS_ENABLED`, and the two things that explicitly don't fan out yet — WebSocket and `/metrics`, both already documented gaps from Phase 10/11), backup/restore (Postgres via `pg_dump`/`psql`; Redis deliberately excluded since it holds no durable state; `CREDENTIAL_ENCRYPTION_KEY` must be backed up separately from the DB), and monitoring (which `/health/ready` fields to alert on vs. just read, the full `/metrics` series table, and structured-log-based request tracing via `requestId`/`correlationId`).

## Production Frontend (`apps/web`, Phase 13)

A frontend-only phase — no `apps/api` file changed, no new backend route. Rebuilds Phase 9's functional-but-plain UI into a fuller design system and a much larger page surface, still consuming only routes already documented in `API_REFERENCE.md`.

### Design system (`src/components/ui/`)
Hand-authored shadcn/ui-style primitives (Radix UI primitives + `class-variance-authority` + `tailwind-merge`, the same approach the shadcn CLI itself generates) rather than running the CLI generator: `Button`, `Card`, `Badge`, `Input`/`Textarea`/`Label`/`FormField`, `Dialog`, `Sheet` (mobile nav drawer), `DropdownMenu`, `Tabs`, `Select`, `Switch`, `Tooltip`, `Separator`, `Avatar`, `ScrollArea`, `Skeleton`/`LoadingSkeleton`, `DataTable`, `Pagination`, `ConfirmationDialog`, `SearchBox`, `FilterBar`, `Timeline`, `Chart` (now `DistributionBarChart`/`DistributionPieChart`/`TrendLineChart`). `RiskBadge.tsx` gained `ComplianceBadge` (an alias over `StatusBadge`, same visual language, distinct name per the spec's component list). Theme tokens live in `globals.css` as CSS variables (`--background`/`--foreground`/`--primary`/etc.), consumed via Tailwind v4's `@theme` block — `.dark` overrides every variable, toggled by `next-themes` (`lib/theme/ThemeProvider.tsx`) via a `class` attribute strategy.

### State layers
Three deliberately distinct tools, each used where the spec calls for it:
- **TanStack Query** (`lib/query/QueryProvider.tsx`, `hooks/queries.ts`) — every new page built this phase fetches through `useQuery`/`useMutation` hooks that wrap the existing `lib/api/*` functions (the reusable API layer Phase 9 already built — no duplicated request logic). A `QueryCache`-level `onError` redirects to `/login` on `SessionExpiredError`, mirroring what `useApiQuery` (Phase 9) already did for its own callers.
- **`useApiQuery`** (Phase 9) — kept, not migrated, for the pages that already used it (Dashboard, Assets, the original Findings/Risk/Compliance/Discovery views, AssetPageShell). Two data-fetching patterns now coexist deliberately; see DECISIONS.md for the scope call.
- **Zustand** (`lib/store/uiStore.ts`, `lib/store/notificationsStore.ts`) — only for state that's genuinely global and client-only: mobile nav open/closed, sidebar collapse, the last-picked asset (persisted to `localStorage`, `zustand/middleware`'s `persist`), and the notification-bell history. Server data never lives in a Zustand store.
- **React Hook Form + Zod** (`app/login/page.tsx`) — the login form's validation. Other forms (asset creation, account connection) were left on their pre-existing `useState`-per-field pattern rather than migrated, a scope cut given the phase's size (see DECISIONS.md).

### Layout
`Sidebar`/`MobileSidebar` (`components/layout/Sidebar.tsx`) share one `NAV_ITEMS` list (`lib/nav.ts`) — 15 entries, icons via `lucide-react`. `MobileSidebar` is a `Sheet` driven by `useUIStore`'s `mobileNavOpen`. `Topbar` gained: `Breadcrumbs` (derived from the URL path + `NAV_ITEMS` labels, no per-page config), a search button linking to `/search`, a `ThemeToggle`, a notification bell (`DropdownMenu` over `useNotificationsStore`, fed by the same `ToastProvider.push()` every live WebSocket-driven toast already calls), and a `DropdownMenu`-based user profile menu (replacing the old bare "Log out" button). `ToastProvider` itself now renders via `sonner` (`<Toaster/>`) instead of a hand-rolled stack, same `push(title, tone)` call-site API so no caller changed.

### Pages — asset-scoped landing pattern
Most of the spec's new top-level pages (`/discovery`, `/findings`, `/recommendations`, `/compliance`, `/reports`, `/accounts`, `/resources`, `/activity`) are one shared `AssetScopedLanding` component (`components/shared/AssetPicker.tsx`): pick an asset from `GET /assets`, then navigate into that asset's existing (or newly added) tab route. `/policies` is a true global list (`GET /policies` has no ownership scoping). `/knowledge` and `/copilot` embed their asset picker inline rather than redirecting, since neither is one of the spec's Asset Details tabs. `/risk` adds an admin-only platform-wide `GET /analysis/risk` (no `assetId`) card above its own picker. See DECISIONS.md for why this is the shape these pages take, not true cross-asset dashboards.

### Asset Details — 12 tabs
`AssetTabs` now lists Overview, Accounts, Resources, Relationships, Discovery, Findings, Recommendations, Risk, Compliance, Events, AI Reports, AI Copilot. `AccountsView`/`EventsView` are Phase 9's `AccountsSection`/`EventsSection` extracted out of `AssetOverview` into their own routes (not duplicated); `ResourcesView`, `RelationshipsView` (one-resource-at-a-time neighbor explorer over `GET /resources/:id/neighbors`), and `RecommendationsView` are new. `AssetOverview` itself is now a summary card plus quick links into every tab.

### AI Copilot (`components/copilot/ChatPanel.tsx`)
A full rebuild: a conversation sidebar (`lib/copilot/useConversations.ts` — `localStorage`-backed, per-asset, client-only; never sent back to the API as prior turns, see DECISIONS.md), Markdown rendering with syntax-highlighted code blocks and a copy button (`components/shared/Markdown.tsx`, shared with `ReportViewer`), a per-message copy button, suggested-prompt chips on an empty conversation, and a typewriter-style reveal of each assistant response (`useTypewriter` — a client-side animation over the already-fully-received response, not real token streaming; `CopilotService` still only ever calls `AIService.generate()`, never `stream()`). `POST /copilot/chat` itself is unchanged.

### Report Viewer (`components/report/ReportViewer.tsx`)
Narrative sections now render through the shared `Markdown` component instead of plain `<p>` tags. New export affordances — JSON download (the raw `SecurityReportData`), Markdown download (the AI narrative, reconstructed client-side from the same five fixed headings `ReportAgent`'s prompt templates instruct the model to use), and browser print-to-PDF — since no backend export endpoint exists (reports are computed per-request, never persisted).

### Global search (`/search`, `hooks/useGlobalSearch.ts`)
Composes `GET /assets?search`, `GET /policies?search` (both global) with `GET /resources?name=`/`GET /analysis/findings?search=` scoped to the last-picked asset (`useUIStore`'s `lastAssetId`) — there is no single cross-domain search endpoint, so this is "search across what's reachable from already-search-capable list endpoints," not a true global index. `resourcesApi`/`analysisApi`'s param types gained `name`/`search` fields to support this (both already accepted server-side per `API_REFERENCE.md`, just not yet typed on the frontend).

### Dashboard
Extended beyond Phase 9's asset list + risk distribution: Connected Accounts / Open Findings / Compliance Score cards (sampled over the 10 most-recently-updated assets, labeled "(sample)" — see DECISIONS.md for why not the full list), a Top Risks card, and a Recent Events card (`Timeline` component). Compliance Trend and Discovery Trend charts from the spec were deliberately not built — no backing time-series data exists on the backend for either, and fabricating chart data was rejected (see DECISIONS.md).

### What Phase 13 left unmigrated
`FindingsView`/`RiskView`/`ComplianceView`/`DiscoveryView`/`NewAssetForm` (all Phase 9) still use the original hardcoded `slate-*` Tailwind palette rather than the new CSS-variable theme tokens — they render correctly in light mode but don't follow the dark-mode toggle. Migrating them was deprioritized given this phase's overall size; see TODO.md.

## Deployment & DevOps (Phase 14)

Deployment/ops-only phase — no business logic or API change. Most of the Docker/nginx/compose foundation was already in place from Phases 11–12 (see those sections above); Phase 14's actual contribution was closing documentation gaps (`docs/DEPLOYMENT.md` — see its own changelog for the new sections) and, more importantly, *running the documented deploy flow for real for the first time* — a full `docker-compose.prod.yml` stack built, migrated, seeded, and served traffic through nginx end-to-end. That surfaced three real bugs in the Docker artifacts that no prior phase's (documentation-only) verification had caught:

- **`apps/api/Dockerfile`'s runtime stage now `COPY`s the root `package.json`** — needed purely for its `packageManager` field, so `pnpm` invoked via `docker compose exec api pnpm ...` (which corepack resolves by walking up from the working directory looking for that field) pins the same version everywhere instead of fetching latest, which requires a newer Node than this image ships.
- **`prisma`/`tsx` moved from `apps/api/package.json`'s `devDependencies` to `dependencies`** — a `--prod` install never included them, so `pnpm prisma:deploy`/`pnpm prisma:seed`, documented since Phase 12, would have failed the first time anyone actually ran them against a real production container.
- **Every `COPY --from=...` in the runtime stage now uses `--chown=node:node`** — previously root-owned (the `COPY` default) while the container runs as `USER node`; `prisma migrate deploy` needs to write a small engine-cache file at invocation time and failed with `EACCES` without this.

**Seeding**: `src/scripts/seed.ts` — compiled and run from `dist/scripts/seed.js` (not `tsx`-executed from a standalone location), specifically because the runtime image ships `dist/` only, never `src/`; a script depending on TypeScript source at runtime would fail in the one place it's meant to run (see DECISIONS.md). One idempotent seed admin user, nothing else fabricated.

**Environment files**: `apps/api/production.env.example`/`development.env.example` (and the `apps/web` equivalents) split the previously-generic `.env.example` into fully-commented, environment-specific variants — every placeholder in the production variant is marked "replace" to force a conscious decision before deploying.

**CI** (`.github/workflows/ci.yml`): gained `actions/upload-artifact` steps producing a downloadable `api-dist` (compiled `dist/`+`package.json`+`prisma/`) and `web-standalone` (Next.js standalone build output) per run — not consumed by anything else in the workflow (the `docker-build` job still rebuilds from source), but available for inspection or a non-Docker manual deploy.

See "What does not exist yet" below for what's still explicitly out of scope (TLS, OpenTelemetry, Grafana/Alertmanager, zero-downtime multi-replica deploys).

## Startup sequence (`src/server.ts`)
1. Import `config` (env.ts validates `process.env` with Zod at import time; exits process on failure)
2. Create Fastify instance — `logger: pinoOptions` (structured JSON, level from config, redaction), a real `genReqId` (an inbound `x-request-id`/`x-correlation-id` header wins, else `randomUUID()`), `disableRequestLogging: true` (Phase 12 — superseded by `observabilityPlugin`'s own unified log line), `bodyLimit: config.security.bodyLimitBytes`, `trustProxy: resolveTrustProxy(config.trustedProxies)` (Phase 12)
3. `authPlugin(app)` called directly (not `app.register`) so `app.authenticate` is visible to sibling route plugins rather than scoped to an encapsulated child context
4. `observabilityPlugin(app)` called directly (same reasoning as `authPlugin`) — requestId/correlationId header/body-splicing, HTTP metrics, and (Phase 12) the unified structured request log line
5. Register `@fastify/helmet`, `@fastify/cors`, `@fastify/rate-limit`, then `@fastify/compress` if `COMPRESSION_ENABLED` (Phase 12) — before every route, so they apply uniformly
6. Register routes in order: health, metrics, auth, categories, assets, tags, accounts, oauth, jobs, resources, analysis, policies, agents, ai, orchestrator, discovery, risk-agent, compliance-agent, recommendation-agent, report-agent, copilot-agent, knowledge, knowledge-rag, copilot, planner, approval, langgraph, llm-planner, debate, episodes, ai-graph (Phase 33 — `POST /ai/graph/analyze` + `/ai/graph/:id/resume`)
7. `registerBuiltinTools()` (Phase 24) — called directly (not a route), after every agent module above has already self-registered its own tools via its route's transitive import
8. Register `@fastify/websocket`, then `registerWebSocketGateway(app)` (called directly, same reason as `authPlugin`) — adds `GET /ws` last, after every REST route
9. Register `onClose`: disconnect Prisma, close Redis
10. `start()`: `app.listen()`, then if `config.jobs.workersEnabled`: start `workerPool`, start heartbeat monitor, register graceful shutdown

## What does not exist yet
- **Phase 33 — Python debate/consensus + dynamic planner exist but the TS versions are still the ones Fastify routes hit.** `apps/ai-service` now has its own debate (`/v1/debate/run`) and dynamic planner (`/v1/planner/*`), ported from `ai/debate` and `ai/llm-planner`. However `POST /ai/debate/*`, `POST /ai/planner/*`, `POST /ai/orchestrator/*`, `POST /ai/langgraph/*` on Fastify still run the in-process TS implementations regardless of `AI_SERVICE_MODE` — only the `AI_*` agent jobs, `AI_FULL_ANALYSIS`, `POST /ai/graph/*` and `POST /ai/copilot/chat` delegate. Wiring those extra Fastify routes to the Python service was left out of scope to avoid touching more Fastify surface; the Python endpoints are reachable directly and fully tested.
- **Phase 33 — no live Anthropic inference was executed.** No `ANTHROPIC_API_KEY` is available in this environment, so every LLM call runs against `DeterministicFakeChat`. `verify_anthropic_config()` proves the `ChatAnthropic` construction path is correct, and `structured_output()`'s validation-retry is unit-tested with a failing fake — but **the real model has not been called end-to-end.** Set `ANTHROPIC_API_KEY` + `ANTHROPIC_MODEL` and the service switches automatically.
- **Phase 33 — the plan executor's cold-process resume rebuilds a canonical plan shape.** `PlanExecutor.resume()` from a fresh process reconstructs the standard `discovery → risk ∥ compliance → recommendation → [gate] → report` graph (the fallback plan). Resume in the same process (the common case, right after the interrupt) uses the exact plan. A non-standard LLM-authored plan interrupted and resumed from a *different* process would resume against the canonical shape, not its own.
- **Phase 33 — Copilot graph checkpoints use an in-process `MemorySaver`.** Conversation continuity is Redis-backed and durable; the LangGraph checkpoint for one chat turn is not (a turn is short and independent, unlike the security workflow which can pause for hours at HITL).
- **Phase 31 — the Python↔Fastify contract is kept in sync by hand + a contract test** (`tests/test_contract.py` asserts the OpenAPI surface), not by generated types. A hand-written `RunResponse` consumer lives in `ai-service.client.ts`; a drift in field names would be caught by that test plus the TS build, not at the type level across the boundary.
- No real write-capable tool or agent (Phase 26/27/28/29/30) — `ApprovalPolicy` supports registering a `MANUAL` decision, but nothing does by default; every `MANUAL`/pause/resume/reject verify check (`HitlOrchestrator`'s, `GraphExecutor`'s, and — if a future plan ever named a `MANUAL` agent — `LLMPlannerExecutor`'s/`DebateEngine`'s) exercises a synthetic in-process fake agent, since Phase 24's `ToolExecutor` still refuses to run any tool declaring `'write'`. No ownership check ties a `HitlOrchestrator`/`GraphExecutor`/`LLMPlannerExecutor`/`DebateEngine`/episode `executionId`/`debateId`/`episodeId`/`ApprovalRequest` id to the user who started it.
- No background job runs `EpisodePruner` (Phase 30) — `pruneAsset()` is fully implemented and tested but must be called explicitly; nothing schedules it, so an asset with continuous execution activity will accumulate episodes up to Redis's own 7-day TTL with no active cap unless something calls it.
- Confidence calibration and tool/agent reliability (Phase 30, `episode.relevance.ts`) are computed but not wired into any agent's live decision-making — there is no general-purpose tool-selection facility in the codebase to plug reliability data into (Copilot's own `selectTool()` is a stateless regex classifier, deliberately left unmodified).
- `DebateEngine` has no HITL/approval gating and no resume/checkpoint story (Phase 29) — a debate is a single, short synchronous call with no `interrupt()`-style pause point; if a fifth, write-capable, `MANUAL`-gated participant were ever added, this would need a pause/resume design of its own.
- Debate participants only ever analyze the *current* state of an asset — `DebateEngine` does not re-run Discovery first, so a debate on an asset with stale or no discovered resources reflects whatever Risk/Compliance/Recommendation currently compute (which, for an empty asset, is a clean "no findings" result — not an error, but not necessarily an up-to-date one either).
- Consensus's finding corroboration (`classifyFindings()`, Phase 29) is a single signal — "did any Recommendation cite this finding" — not a weighted multi-factor score; a finding a human would consider well-corroborated by Compliance evidence alone (with no matching Recommendation) is still classified "rejected" today.
- No real LLM provider is configured in this environment (Phase 28) — `OPENAI_API_KEY` is a placeholder, not a real key, so `LLMPlanner.plan()`/`revise()` always exercises the deterministic `GoalPlanner`-derived fallback path in practice; the real prompt/parse/repair/validate pipeline is implemented and covered by `verify-plan-validation.ts`'s unit tests, but has never been exercised against a real model response end to end in this codebase.
- `LLMPlannerExecutor.execute()` has no resume/checkpoint-recovery entry point of its own — `runOnce()` persists a `GraphCheckpointStore` snapshot per iteration (so `GET /ai/langgraph/:executionId`/`:state` can read a dynamic-plan execution back), but there's no `POST /ai/planner/:executionId/resume` equivalent to Phase 27's `POST /ai/langgraph/:executionId/resume` — moot today (no agent in `PLANNER_AVAILABLE_AGENTS` is `MANUAL` by default) but would need adding if one ever were.
- No durable `BaseCheckpointSaver`-compatible checkpointer (Phase 27) — `GraphCheckpointStore` persists plain `GraphState` JSON snapshots for its own resume-after-restart story, not LangGraph's internal `Checkpoint` format; it can't be swapped for a different official checkpointer package without a translation layer. `GraphExecutor.resume()` also only supports a single concurrently-pending `interrupt()` per execution.
- No LLM-driven planner or critic (Phase 25) — `GoalPlanner`'s workflow selection and `Critic`'s scoring are both deterministic heuristics, same "not an AI call" spirit as `Planner.resolveWorkflowId()`/`copilot.intent.ts`. Plan Revision only ever removes doomed steps; it never substitutes an alternative agent or inserts a new one.
- All six of the six Phase 17 placeholder `src/ai/orchestrator/agents/` roles are now registered as of Phase 22 — none remain. The pre-existing, separate `POST /copilot/chat` (Phase 8, `services/copilot/`) is unaffected by the new `copilot-agent`/`/ai/copilot/*` and still fully functional; the two are independent implementations that happen to share a domain name
- Recommendation Agent's cross-referencing (Phase 21) is by exact shared `resourceId` only — no correlation across different resources of the same asset, and no LLM-driven correlation of "conceptually related" findings/failures
- `ReportAgent` (the legacy `services/agents/` one, Phase 7D) is the only agent wired to `AIService` — `RiskAgent`/`ComplianceAgent`/`DiscoveryAgent`/`RecommendationAgent` (the legacy versions) still never call it, and no agent calls `ContextBuilder`/`KnowledgeService` directly (only `AIService` does, internally). The new `src/ai/agents/report/` Report Agent (Phase 21) is a separate, unrelated implementation that uses `aiFoundation.llmClient` directly (Phase 16's foundation), not `AIService`/`ContextBuilder`
- Persistent memory, RAG, and vector search now exist as of Phase 23 (`ai/embeddings/`, `ai/knowledge/`, `ai/retrieval/`, pgvector) — but only for the `src/ai/` agent stack (Discovery/Risk/Compliance/Recommendation/Report/Copilot); the legacy `services/ai/`/`services/copilot/` system (Phase 7B-8, `/ai/generate`, `/copilot/chat`) is untouched and still has none of it. No autonomous agent loops exist either way.
- `ReportAgent`'s AI narrative is generated synchronously in-request per call, with no caching — two identical `aiMode: FULL_REPORT` calls back-to-back make two full AI round trips
- No conversation memory/threading for the copilot (Phase 8) — every `POST /copilot/chat` call is a single, independent message; there is no multi-turn conversation state, and no streaming (`CopilotService` always calls `aiService.generate()`, never `stream()`)
- No streaming HTTP endpoint — every AI provider implements `stream()` (exercised directly by `verify-ai.ts`), but no route calls it
- No job-queued path for an AI call — `AIService.generate()` always runs synchronously in-request, even though `AI_DISCOVERY`/etc. job types are already reserved
- No `GET /ai/requests` list/search endpoint over `AIRequestLog` — write-only via HTTP today
- No persisted or cached `KnowledgeContext` — every `POST /knowledge/context` and every asset-scoped `POST /ai/generate` rebuilds fresh, unlike `AgentPlanExecution`'s persisted audit trail
- No streamed AI tokens over WebSocket (Phase 10 explicitly excluded it) — `AI_REPORT_*`/`COPILOT_CHAT_*` events are status transitions, never partial generated text
- No persisted WebSocket session/subscription state — `connection-registry.ts` is in-memory and process-local; a server restart drops every connection and every client must reconnect + resubscribe (acceptable at this deployment's single-process scale, see DECISIONS.md)
- No horizontal WebSocket fan-out (Redis pub/sub, etc.) — `realtime-bus.ts` is a single-process `EventEmitter`, so broadcasting only works within the one process that received the originating event. Fine today since `apps/api` is a single deployable; would need a shared bus if ever scaled to multiple instances
- No route to cancel an in-flight `POST /agents/execute` call — `AgentContext.signal`/`TaskService` already honor an `AbortSignal`, but nothing outside the process ever calls `abort()` today
- No `GET /agents/plans` list/search endpoint (only `GET /agents/plans/:id`), and no retention policy on `AgentPlanExecution` rows
- No webhooks (deferred at Phase 4)
- Relationship extraction is GitHub-only; other providers' discovered resources produce zero edges until an extractor is registered for them
- Rule evaluation is GitHub-only (5 rules, `repository` resources only); other providers/resource types produce zero findings until rules are registered for them
- Policy evaluation is GitHub-only (5 policies, `repository` resources only); same shape as the rule/relationship coverage gaps
- No manual/HTTP-driven relationship creation route — all edges are discovery-derived
- No manual/HTTP-driven finding or recommendation creation route — all findings are rule-derived from discovery
- No manual/HTTP-driven policy creation route, and no HTTP route to toggle `Policy.enabled` — only direct repository access today
- No persisted compliance snapshot/history — `ComplianceReport` is always computed fresh from current data, there is no "compliance over time" view
- No shared cross-route error-mapping helper — each route file defines its own local `mapXError`
- No automatic migration step in either Docker Compose file (Phase 11) — `prisma migrate deploy` is a deliberate separate step (`pnpm --filter api prisma:deploy`, or `docker compose -f docker-compose.prod.yml exec api pnpm prisma:deploy`), never run automatically on container start, to avoid a migration race if a prod deployment ever scales `api` to more than one replica
- No horizontal Prometheus/metrics aggregation — `/metrics` reflects only the one process that answers the request; a multi-instance deployment needs a scraper that hits every instance (or a push-gateway), not implemented here
- No TLS termination in `nginx/nginx.conf` — it listens on plain HTTP (port 80) only; a real deployment would add a `listen 443 ssl` server block (certs are deployment-specific, out of scope for a config file meant to be generic)
- No log shipping/aggregation (e.g. to a hosted log service) — structured JSON logs go to stdout only, ready for a log collector to pick up, but no collector is configured here
- No alerting on top of the new metrics — `/metrics` is scrape-ready, but no Alertmanager/Grafana config ships with this phase
- No end-to-end correlation id — an HTTP request's `correlationId`, the job it enqueues, and any AI call that job (or the request itself) triggers each get their own independent id, not one shared id threaded across all three (Phase 12, see DECISIONS.md)
- `/metrics` still has no horizontal aggregation across replicas (unchanged from Phase 11) — Phase 12's new series inherit the same single-process-only limitation
- No zero-downtime rolling deploy in `docker-compose.prod.yml` — one replica per service, `docker compose up -d --build` briefly recreates `api`/`web`; a multi-replica setup (see `docs/DEPLOYMENT.md`'s Scaling section) is the way around this, not provided as a ready-made compose file
- No real cross-asset dashboards for discovery/findings/recommendations/compliance/resources/accounts/activity (Phase 13) — the top-level sidebar pages for these are asset-scoped landing pages (pick an asset, then see that one asset's data), not aggregate views, because no bulk cross-asset endpoint exists for any of them (see DECISIONS.md)
- No real AI token streaming in the Copilot UI (Phase 13) — `useTypewriter` reveals an already-complete response progressively on the client; `CopilotService` still never calls `provider.stream()`
- No server-side Copilot conversation memory (Phase 13, same as Phase 8) — conversation history is `localStorage`-only, per browser, per asset; it's never sent back to the API as prior turns and doesn't sync across devices
- No Compliance Trend / Discovery Trend charts on the Dashboard (Phase 13) — no persisted compliance history or discovery-duration time series exists on the backend to chart; fabricating data was rejected rather than shipped as a placeholder
- No true global search index (Phase 13) — `/search` composes existing search-capable list endpoints (`GET /assets?search`, `GET /policies?search`, plus the last-picked asset's resources/findings), not a dedicated cross-domain search endpoint
- `FindingsView`/`RiskView`/`ComplianceView`/`DiscoveryView`/`NewAssetForm` (Phase 9) were not migrated to Phase 13's CSS-variable theme tokens — they don't follow the dark-mode toggle
- No OpenTelemetry (Phase 14) — no OTel SDK, trace spans, or OTLP exporter anywhere in `apps/api`; `docs/DEPLOYMENT.md` documents what adding it would take, but none of it exists today
- No Grafana dashboard or Alertmanager config ships with this repo (Phase 14 only added documentation of which `/metrics` series to build them from and starting-point alert thresholds — `docs/DEPLOYMENT.md`'s Monitoring guide)
- No Docker log-driver rotation configured in `docker-compose.prod.yml` (Phase 14 documented the fix in `docs/DEPLOYMENT.md`, didn't apply it to the compose file)
- `GET /health/ready` throws an unhandled 500 (not a graceful 503) when the database is reachable but the schema hasn't been migrated yet — found during Phase 14's own smoke test; not fixed, since fixing route error-handling is a business-logic change outside this phase's scope (see TODO.md). Note this is a *different* case from the one Phase 15 fixed (Postgres unreachable entirely, not reachable-but-unmigrated) — that fix didn't cover this one.
- No jest/vitest or any unit-test framework in `apps/api` (unchanged since Phase 1) — every `verify:*` script, including Phase 16's `verify-ai-foundation.ts`, is a hand-rolled `createChecker()`-based check script, not a framework-driven test suite
- No concrete tool in `src/ai/tools/ToolRegistry` and no `LongTermMemory` implementation (Phase 16) — both are interfaces/registries only, empty until a future agent phase needs them
- No streaming route or WebSocket integration for `src/ai/llm/LLMProvider.stream()` (Phase 16) — `OpenAIProvider.stream()` is fully implemented and unit-verified, same "implemented but nothing calls it" shape as `services/ai/`'s existing providers' `stream()` methods (see the Phase 10/13 bullets above)
- `src/ai/` and `services/ai/` are two independent AI provider layers coexisting in the same codebase (Phase 16) — no migration path has been built yet to move `services/ai/`'s callers (`/ai/generate`, `/copilot/chat`, `ReportAgent`) onto the new foundation; see this doc's "Agentic AI Foundation" section for why they were kept separate rather than merged
- Only `DiscoveryAgent`/`RiskAgent`/`ComplianceAgent` are registered under `orchestratorAgentRegistry` (Phase 18/19/20) — `RecommendationAgent`/`ReportAgent`/`CopilotAgent` are still just placeholder interfaces (`src/ai/orchestrator/agents/*.interface.ts`), zero implementations; every seeded workflow's steps after Risk/Compliance still fail with a clean, non-throwing `AgentNotRegisteredError` per step until a future phase registers them
- No real GitLab/Bitbucket/AWS/Azure/GCP/Docker Hub/Kubernetes discovery (Phase 18) — `provider.registry.ts` declares all seven as future targets with zero tools; only `github` is implemented
- 6 of the Discovery Agent's 10 registered tools are placeholders (Phase 18) — `github_list_branches`/`_contributors`/`_releases`/`_workflows`/`_security_advisories`/`_secret_scanning_alerts` all reject at call time, since `GitHubDiscoveryProvider` itself never fetches that data; implementing any of them for real requires extending the provider first, not just the tool wrapper
- No LLM-driven discovery-intent classification (Phase 18) — `classifyDiscoveryIntent()` is keyword-regex matching only, informational (request logging), never a control-flow branch
- 5 of the Risk Agent's 9 registered tools are placeholders (Phase 19) — `risk_secrets_scanner`/`_branch_protection`/`_workflow_risk`/`_dependency_risk`/`_security_alert` all reject at call time, since the existing rule engine has no rule for those categories yet; implementing any of them for real requires adding a new rule under `services/analysis/rules/github/` first, not just the tool wrapper
- No real "acknowledge finding" feature (Phase 19) — `RiskMemory.acknowledgeFinding()`/`getAcknowledgedFindingIds()` exist as agent-scratch state, but no route calls them; the `Finding` model itself has no acknowledgement column, only `OPEN`/`RESOLVED`
- Compliance Agent's framework coverage is bounded by the 5 existing GitHub policies (Phase 20) — `compliance.mapping.ts` maps them across all 4 frameworks, but most catalog controls per framework have no mapped policy and surface as `MISSING`; extending real coverage requires adding a new rule/policy first (out of this phase's scope), then one more mapping entry
- `compliance.mapping.ts`'s framework/control mapping is illustrative, not a certified auditor crosswalk (Phase 20) — documented as such in the file's own header comment; no framework beyond the 4 named in the spec (NIST CSF, CIS Controls, ISO 27001, SOC2) is implemented
- No `job-dispatcher.ts` handler for `AI_ORCHESTRATOR_AGENT_TASK` (Phase 17) — `TaskQueue.enqueue()` works, but a worker dequeuing one today fails immediately with `UnsupportedJobTypeError`; wiring a real handler is future-phase work, once a concrete agent exists to invoke
- No LLM-driven planning (Phase 17) — `Planner.createPlan()` is keyword-regex intent matching only, not an `aiFoundation.llmClient` call
- No durable delayed task scheduling (Phase 17) — `TaskQueue`'s `delayMs` is an in-process `setTimeout`, lost on a process restart; no `scheduledAt` column exists on `SyncJob`
- No cancellation route (Phase 17) — `OrchestratorService.cancel()` exists and `WorkflowEngine` honors an `AbortSignal`, but nothing in `routes/orchestrator.ts` calls it yet (only `execute`/`workflows`/`history`/`status` are exposed over HTTP)
- `src/ai/orchestrator/` and `services/agents/` are two independent orchestrators coexisting in the same codebase (Phase 17) — no migration path has been built yet to move `services/agents/`'s five concrete agents (or `POST /agents/execute`'s callers) onto the new one; see this doc's "Orchestrator Agent" section for why they were kept separate rather than merged
- `LocalHashEmbeddingProvider` (the Phase 23 default) is not a real embedding model — it captures token overlap, not semantic meaning; retrieval quality is meaningfully better with `EMBEDDING_PROVIDER=openai`, which is opt-in and requires `OPENAI_API_KEY`
- No embedding-provider migration/backfill tool (Phase 23) — switching `EMBEDDING_PROVIDER` after documents already exist does not re-embed them; old rows keep their original `embeddingVersion`/vector, silently incomparable to new ones
- No reranking or hybrid (keyword + vector) search (Phase 23) — `RetrievalService.search()` is pure cosine-similarity nearest-neighbor, one pass, no second-stage reordering
- No automatic indexing for the legacy `services/agents/` orchestrator or `services/ai/`'s `ReportAgent`/`CopilotService` (Phase 23) — the Knowledge Store only receives output from the `src/ai/orchestrator/` stack's six agents, via `executor.ts`'s `onStepComplete`; the legacy systems produce no `KnowledgeDocument` rows
- No cascade delete from `Asset` to `KnowledgeDocument`/`RetrievalTrace` (Phase 23) — same soft-reference pattern as `Finding`/`RiskScore`/`PolicyResult`; deleting an asset elsewhere in the app leaves its indexed documents orphaned unless a caller explicitly cleans them up (as every Phase 23 verify script does for its own test data)
- No manual `POST /ai/tools/execute` HTTP route (Phase 24) — every new tool is reachable in-process by agents/Copilot's automatic selection, never by a direct external caller; deferred deliberately given `postgres_query`'s broad, unscoped read access
- No real (non-mock) web search provider (Phase 24) — `MockWebSearchProvider` is the only implementation, and no Copilot tool-selection pattern triggers `web_search` yet either
- No write-capable tool of any kind (Phase 24) — the permission model supports declaring `'write'`, but `ToolExecutor.assertPermitted()` refuses to run any tool that does; genuinely absent, not just policy-blocked at the route layer
- `ToolRegistry.execute()` (every pre-Phase-24 agent's own internal tool-call path) has no allowlist/permission enforcement — only calls through the new `ToolExecutor` are checked; retrofitting every agent's internal calls to route through `ToolExecutor` (threading an `agentId` into each) is future-phase work, not done here
- `agent-tool-access.ts`'s `AGENT_TOOL_ACCESS` is a static, hand-maintained map — no dynamic capability negotiation; a new tool or agent needs a manual edit, and a missed one denies silently rather than erroring at registration time
