# Phase 31 — Python AI Service + Agents: Migration Plan

**Status:** Proposed — awaiting approval. No code written yet.
**Author:** Architecture pass, 2026-09-06
**Principle:** Deterministic TypeScript remains the source of truth for security facts.
The Python layer explains, retrieves, plans, and orchestrates over *verified* data only.

---

## 1. What exists today (inspection findings)

### 1.1 The TypeScript AI subsystem
Location: `apps/api/src/ai/` — ~19,800 LOC. Structure:

| Area | Path | Role |
|---|---|---|
| Foundation | `ai/foundation.ts`, `ai/config/` | Composition root: LLM providers → `LLMClient`, prompt registry, tool registry/executor, Redis-backed memory |
| LLM providers | `ai/llm/providers/` | anthropic, openai, azure-openai, gemini, ollama, placeholder |
| 6 agents | `ai/agents/{discovery,risk,compliance,recommendation,report,copilot}/` | Each: `*.agent.ts`, `*.executor.ts`, `*.memory.ts`, `*.prompts.ts`, `*.schemas.ts` (zod), `*.telemetry.ts`, `*.context.ts`, `*.tool.ts`, `*.interface.ts`, `*.types.ts` |
| Orchestration | `ai/orchestrator/`, `ai/langgraph/` | Workflow engine, agent registry, LangGraph graph builder/nodes/edges/state/checkpoint (`@langchain/langgraph@^1.4.9`) |
| RAG / knowledge | `ai/knowledge/`, `ai/retrieval/`, `ai/embeddings/` | pgvector over `KnowledgeDocument`, embedding providers (openai + local-hash) |
| Memory | `ai/memory/`, `ai/episodic-memory/` | Redis conversation/session memory; episodic memory with pgvector |
| Reasoning | `ai/planner/`, `ai/llm-planner/`, `ai/reflection/`, `ai/critic/`, `ai/debate/` | Goal planner, reflection engine, confidence/critic, debate/consensus engine |
| HITL | `ai/approval/` | Approval engine, paused-execution store, HITL orchestrator |
| Tools | `ai/tools/builtin/` | `github`, `postgres`, `knowledge`, `websearch`, `filesystem` |

### 1.2 How agents are invoked
Two entry paths, both through Fastify:

1. **Async (jobs).** Routes like `POST /ai/discovery/start` (`src/routes/discovery.ts`) enqueue a
   BullMQ job (`JobType.AI_DISCOVERY`, `AI_RISK`, `AI_COMPLIANCE`, `AI_RECOMMENDATION`, `AI_REPORT`).
   `src/services/jobs/job-dispatcher.ts` registers a handler per job type that **dynamically imports**
   the agent (`const { discoveryAgent } = await import('../../ai/agents/discovery/index.js')`) and calls
   `agent.execute(input, orchestrationContext)`. Result is polled via `GET /jobs/:id`.
2. **Sync (copilot).** `POST /ai/copilot/chat` (`src/routes/copilot-agent.ts`) builds a one-off
   `OrchestrationContext` and runs `copilotAgent.execute()` in-request.

### 1.3 Agent I/O contracts (already well-defined)
Inputs are **small identifiers**, not data blobs — the agent fetches verified data itself:

| Agent | Input | Output type (`*.interface.ts`) |
|---|---|---|
| Discovery | `{ accountId, refresh? }` | `DiscoveryAgentOutput` (resources, repositories, languages, topics, relationships, summary, confidenceScore) |
| Risk | `{ assetId }` | `RiskAgentOutput` (overallScore, businessImpact, findings + severity buckets, summary, confidenceScore) |
| Compliance | `{ assetId }` | `ComplianceAgentOutput` (complianceScore, frameworks, policyFailures/passes, summary) |
| Recommendation | `{ assetId }` | `RecommendationAgentOutput` (recommendations, prioritized, handoffSources) |
| Report | `{ assetId }` | `ReportAgentOutput` (summary, sections, executive) |
| Copilot | `{ assetId?, conversationId?, message }` | chat result (answer, citations, conversationId) |

Every output carries `status`, `metadata {startedAt, finishedAt, durationMs}`, `confidenceScore`,
`warnings[]`, `errors[]`. **These shapes are the contract we must preserve.**

### 1.4 Verified data sources (stay in TypeScript — source of truth)
- `services/discovery/discovery.service.ts` — GitHub resource discovery
- Deterministic security analysis → `Finding`, `RiskScore` Prisma models
- `services/policy/` → `Policy`, `PolicyResult` Prisma models
- `Recommendation`, `Resource`, `Relationship` models
- Prisma schema: `Finding`, `Recommendation`, `RiskScore`, `Policy`, `PolicyResult`,
  `AgentPlanExecution`, `AIRequestLog`, `KnowledgeDocument` (pgvector), `RetrievalTrace`,
  `ToolExecutionTrace`, `Resource`, `Relationship`.

### 1.5 Frontend coupling
Thin clients in `apps/web/src/lib/api/` (`copilot.ts`, `agents.ts`, `jobs.ts`, …) call Fastify only.
**The frontend never needs to know the Python service exists** if Fastify keeps its routes stable.

---

## 2. Target architecture

```
Next.js  →  Fastify / TS API  →  Python FastAPI AI Service  →  LangChain + LangGraph
                  │                        │                        6 agents
   (unchanged routes)         (new AiServiceClient)          RAG / tools / memory / planning
                  │                        │
       deterministic services       pgvector (read) + Redis
       = verified data provider
```

### 2.1 Division of responsibility

| Concern | Owner | Notes |
|---|---|---|
| Auth, OAuth, sessions | Fastify (TS) | unchanged |
| Prisma / migrations / domain tables | Fastify (TS) | Python gets **read-only** pooled access for RAG + its own observability tables only |
| Deterministic security analysis, discovery, policy eval | Fastify services (TS) | unchanged — produce the verified facts |
| BullMQ jobs, scheduling, retry | Fastify (TS) | unchanged; job handlers now call Python over HTTP |
| LLM reasoning: 6 agents, prompts, structured output | **Python** | LangChain |
| Graph orchestration: state/nodes/edges/routing/checkpoint/interrupt | **Python** | LangGraph |
| RAG retrieval over `KnowledgeDocument` | **Python** | pgvector, read-only |
| Agent conversation/session memory + graph checkpoints | **Python** | Redis (separate key prefix `ai:py:`) |
| Agent run traces / AI request logs | **Python** writes its own tables | new tables `ai_py_*`, or reuse `AIRequestLog`/`RetrievalTrace`/`ToolExecutionTrace` via read-only-plus-insert grant |

### 2.2 Who fetches verified data?
**Fastify assembles a "verified context bundle" and passes it in the request body.**
This is the key decision that enforces the core principle: the LLM never queries security facts
itself; it receives them pre-verified.

- `job-dispatcher` handler for `AI_RISK`: calls existing TS `RiskService`/Prisma to load the asset's
  `Finding[]` + `RiskScore`, packages them into `RiskRunRequest.verified`, POSTs to Python.
- Python's Risk agent reasons over `request.verified.findings` — it **cannot invent findings** because
  it has no other source of them.
- Copilot is the one agent allowed to *pull* data — via **whitelisted read-only tools** that call back
  into Fastify's own REST endpoints (`GET /assets/:id`, `GET /ai/risk/status`, …) with a service token,
  never raw SQL against domain tables.

---

## 3. Service-to-service contract

### 3.1 Transport
- Python exposes `POST /v1/agents/{agent}/run` and `POST /v1/copilot/chat` + `GET /health`, `GET /ready`.
- JSON over HTTP. Fastify → Python only (Python does not call Fastify except via Copilot's
  whitelisted read tools).
- **Auth:** shared secret in `X-Service-Token` header (env `AI_SERVICE_TOKEN`), constant-time compare.
  Upgrade path noted for mTLS later.
- **Correlation:** `X-Correlation-Id` propagated from the job/request; returned in every response and
  every log line on both sides.
- Timeouts: Fastify client 60s default (configurable per agent); Python enforces its own hard cap.

### 3.2 Contract shape (Pydantic ⇄ zod, kept in sync manually + contract test)
```
RunRequest (generic envelope)
  correlation_id: str
  principal: { user_id: str, role: str }
  agent_input: <agent-specific>          # {account_id} | {asset_id} | {message, conversation_id}
  verified: <agent-specific bundle>      # findings, risk_scores, policy_results, resources...
  options: { refresh?: bool, ai_mode?: str }

RunResponse (generic envelope)
  status: "COMPLETED" | "PARTIAL" | "FAILED"
  correlation_id: str
  output: <mirrors existing *AgentOutput>
  confidence_score: float
  warnings: list[str]
  errors: list[str]
  metadata: { started_at, finished_at, duration_ms, model, tokens }
```
The `output` field mirrors the existing TS `DiscoveryAgentOutput` / `RiskAgentOutput` / … so Fastify
passes it through to `GET /jobs/:id` unchanged. **No frontend or Fastify route schema changes.**

### 3.3 Contract artifacts
- `apps/ai-service/app/models/contract.py` — Pydantic source of truth.
- Python emits OpenAPI at `/openapi.json`.
- `apps/api/src/ai-service/contract.ts` — hand-written TS types + a runtime zod validator that the
  contract test checks against Python's OpenAPI (fails CI on drift).

---

## 4. New service layout — `apps/ai-service/`

```
apps/ai-service/
├── app/
│   ├── main.py                 # FastAPI app, lifespan (pools), routers, middleware (auth, correlation)
│   ├── config.py               # pydantic-settings; reads DATABASE_URL (RO), REDIS_URL, AI_SERVICE_TOKEN, ANTHROPIC_API_KEY, model config
│   ├── api/
│   │   ├── health.py           # /health, /ready (checks pgvector + redis)
│   │   ├── agents.py           # POST /v1/agents/{discovery,risk,compliance,recommendation,report}/run
│   │   └── copilot.py          # POST /v1/copilot/chat
│   ├── agents/
│   │   ├── base.py             # shared: run envelope, telemetry, error→RunResponse mapping
│   │   ├── discovery.py risk.py compliance.py recommendation.py report.py copilot.py
│   ├── graph/
│   │   ├── state.py            # TypedDict/Pydantic graph state
│   │   ├── builder.py          # LangGraph StateGraph assembly, conditional edges, checkpointer
│   │   ├── nodes.py edges.py
│   │   └── checkpint.py        # Redis checkpointer (langgraph-checkpoint) for interrupt/resume
│   ├── rag/
│   │   ├── retriever.py        # pgvector similarity search over knowledge_documents (read-only)
│   │   └── embeddings.py       # LangChain embeddings (OpenAI or local fallback), must match TS dim
│   ├── memory/
│   │   └── redis_memory.py     # conversation/session memory, prefix ai:py:
│   ├── tools/
│   │   ├── registry.py
│   │   ├── knowledge_tool.py   # RAG retrieval as a LangChain tool
│   │   └── estateai_api_tool.py # Copilot's whitelisted read-only callbacks into Fastify REST
│   ├── services/
│   │   ├── llm.py              # LangChain ChatAnthropic factory + structured-output helpers
│   │   ├── db.py               # asyncpg / SQLAlchemy read-only pool
│   │   └── trace.py            # writes ai_py_run / ai_py_trace rows
│   ├── models/
│   │   ├── contract.py         # RunRequest/RunResponse envelopes
│   │   └── agents/*.py         # per-agent input + verified-bundle + output schemas
│   └── utils/                  # logging, correlation context, retries
├── tests/
│   ├── unit/                   # per-agent, graph routing, retriever (mocked LLM)
│   ├── contract/               # OpenAPI ⇄ TS types
│   └── conftest.py             # fake LLM, in-memory redis, test pg
├── pyproject.toml              # uv/pip; pytest, ruff, mypy
├── Dockerfile                  # python:3.12-slim, non-root, uvicorn
├── .env.example
└── README.md
```

### 4.1 Python dependencies (all pinned)
`fastapi`, `uvicorn[standard]`, `pydantic`, `pydantic-settings`, `httpx`,
`langchain`, `langchain-core`, `langchain-anthropic`, `langchain-openai` (embeddings only),
`langgraph`, `langgraph-checkpoint-redis`,
`asyncpg` + `pgvector` (or `sqlalchemy[asyncio]`), `redis`,
`structlog`, `tenacity`.
Dev: `pytest`, `pytest-asyncio`, `respx`, `ruff`, `mypy`.

---

## 5. Agent implementations (real, not demo)

| Agent | LangChain use | LangGraph use | Grounding rule |
|---|---|---|---|
| **Discovery** | structured-output prompt to organize/label resources | single graph node (validate → summarize) | operates only on `verified.resources`; output `resources` must be a subset of input |
| **Risk** | prompt per finding cluster, structured `RiskFindingView` | node graph: bucket → explain (parallel over severities) → prioritize → summarize | `findings` come only from `verified.findings`; agent adds `reasoning`/`businessImpact`, never new findings |
| **Compliance** | structured explanation per framework control | graph: group by framework → explain failures (parallel) → score narrative | consumes `verified.policy_results`; explanations cite the policy id |
| **Recommendation** | synthesis prompt | graph: ingest Risk+Compliance outputs → dedupe/cross-ref → prioritize | recommendations must reference a risk finding id or policy id (`handoffSources`) |
| **Report** | long-form narrative + section templating | graph: gather upstream outputs → section writers (parallel) → executive summary → assemble | aggregation only; every claim traces to an upstream verified value |
| **Copilot** | tool-calling agent, RAG, conversation memory | ReAct-style graph with tool node + `interrupt` for HITL | answers from RAG chunks + whitelisted read tools; refuses when unsupported; citations required |

Checkpointing/interrupt-resume: Copilot and Report use the Redis checkpointer so a long run (or an
HITL pause) can resume by `thread_id` (= correlation id).

---

## 6. Fastify-side changes (small, reversible)

1. **New:** `apps/api/src/ai-service/client.ts` — `AiServiceClient` (httpx-equivalent via `undici`),
   methods `runDiscovery/Risk/Compliance/Recommendation/Report(bundle)`, `copilotChat(...)`.
   Handles token header, correlation id, timeout, typed errors.
2. **New:** `apps/api/src/ai-service/bundles.ts` — builds the verified bundle for each agent by calling
   existing TS services/repositories (no new business logic).
3. **Change:** `src/services/jobs/job-dispatcher.ts` — each `AI_*` handler, behind
   `env.AI_SERVICE_MODE` (`'typescript' | 'python'`, default `'typescript'` until Phase 31 sign-off):
   - `typescript` → existing dynamic-import path (untouched, kept as fallback).
   - `python` → build bundle → `aiServiceClient.run*()` → map `RunResponse.output` into the same
     `JobExecutionResult` shape.
4. **Change:** `src/routes/copilot-agent.ts` — same feature-flag switch for the sync path.
5. **Config:** `src/config/env.ts` — add `AI_SERVICE_URL`, `AI_SERVICE_TOKEN`, `AI_SERVICE_MODE`,
   `AI_SERVICE_TIMEOUT_MS`.
6. **No changes to:** routes' request/response schemas, `apps/web`, Prisma domain models, auth,
   deterministic analysis, existing TS agent code (left in place as fallback + reference).

---

## 7. Database & infra

- **Migration:** one new Prisma migration adding Python-owned trace tables
  (`AiPyRun`, `AiPyTrace`) *or* — preferred — no schema change; Python inserts into existing
  `AIRequestLog` / `RetrievalTrace` / `ToolExecutionTrace` via a dedicated DB role
  `ai_service` with `SELECT` on all + `INSERT` on those three. Decision point for you.
- **pgvector:** Python reads `knowledge_documents`. Embedding model/dimension **must match** the TS
  `embedding.service.ts` default, or RAG returns garbage — contract test asserts the dimension.
- **docker-compose.yml:** add `ai-service` (build `apps/api`… no — `apps/ai-service`), depends_on
  `postgres` + `redis`, env from `apps/ai-service/.env`.
- **CI (`.github/`):** new job — `ruff`, `mypy`, `pytest`; contract test that boots Python and
  validates OpenAPI against the TS types.

---

## 8. Testing / exit criteria for Phase 31

- [ ] `uvicorn app.main:app` starts; `/health` + `/ready` green (pg + redis reachable).
- [ ] `pytest` green: 6 agents unit-tested with a fake LLM, graph routing, retriever, contract test.
- [ ] Fastify `AI_SERVICE_MODE=python`: each of the 6 agents invokable end-to-end
      (job enqueue → Python → `GET /jobs/:id` returns same-shaped output; copilot sync works).
- [ ] `AI_SERVICE_MODE=typescript` still works unchanged (fallback proven).
- [ ] `apps/web` unchanged and functional against both modes.
- [ ] Existing `apps/api` test suite + `pnpm build` green.
- [ ] README documents local run (with/without Docker) and the contract.

---

## 9. Proposed sub-milestone sequence (stop for approval after each)

1. **31.1** Scaffold `apps/ai-service` — FastAPI, config, health/ready, Dockerfile, CI, README. No agents.
2. **31.2** Contract: Pydantic envelopes + per-agent schemas; TS `contract.ts`; contract test.
3. **31.3** LLM + RAG + memory infrastructure (LangChain ChatAnthropic, pgvector retriever, Redis memory, LangGraph checkpointer).
4. **31.4** Agents 1–3 (Discovery, Risk, Compliance) + unit tests.
5. **31.5** Agents 4–6 (Recommendation, Report, Copilot w/ tools + interrupt) + unit tests.
6. **31.6** Fastify `AiServiceClient` + `bundles.ts` + feature-flag wiring in job-dispatcher & copilot route.
7. **31.7** End-to-end tests, docker-compose entry, docs, final verification of both modes.

---

## 10. Open questions for you

1. **Trace persistence:** new `AiPy*` tables, or grant Python insert on existing
   `AIRequestLog`/`RetrievalTrace`/`ToolExecutionTrace`?
2. **Copilot data access:** whitelisted callbacks into Fastify REST (my recommendation) vs. a
   read-only `postgres` tool like the TS one?
3. **LLM provider:** default to Anthropic (`claude-sonnet-5`) only for Phase 31, or also wire the
   OpenAI/Ollama fallbacks the TS side has?
4. **TS agent code:** keep indefinitely as fallback, or delete after Phase 31 sign-off once Python is
   proven?
5. **Python version & package manager:** `uv` + `pyproject.toml` (my recommendation) vs. `pip` +
   `requirements.txt` as the prompt lists?
6. **Deployment target:** same host/compose as now, or is there a separate deploy pipeline the
   `.github/` workflows should target?
