# EstateAI AI Service (Python)

Phase 31 — a real Python AI service that reimplements EstateAI's six-agent
layer in **FastAPI + Pydantic + LangChain + LangGraph**. The rest of
EstateAI (Next.js frontend, Fastify API, auth, GitHub OAuth, Prisma,
deterministic security analysis, jobs) stays in TypeScript.

```
Next.js  →  Fastify / TS API  →  Python FastAPI AI Service  →  LangGraph
                  │                        │                    LangChain
        deterministic services      AiServiceClient            6 agents
        = verified data source                             RAG / tools / memory
                  │                        │
              PostgreSQL + pgvector  ·  Redis (ai:py: namespace)
```

## Core principle

**Deterministic TypeScript remains the source of truth for security facts.**
The Python agents never invent findings, severities, scores or policy
results. For every security-sensitive agent, Fastify assembles a
*verified context bundle* from the real `Finding` / `RiskScore` /
`PolicyResult` rows and sends it in the request; the agents reason over
that bundle only. Copilot may additionally *pull* data, but only through
a fixed allowlist of read-only Fastify REST callbacks (ownership still
enforced by Fastify).

## The six agents

| Agent | Input | Grounds on | Produces |
|---|---|---|---|
| **Discovery** | `{accountId}` + verified resources | verified resource list | organized inventory, language/topic tallies, summary |
| **Risk** | `{assetId}` + verified findings + RiskScore | verified findings (severity/score copied verbatim) | per-finding reasoning, severity buckets, executive summary |
| **Compliance** | `{assetId}` + verified policy results | verified PASS/FAIL/WARNING results | grounded explanations, per-framework narrative, score |
| **Recommendation** | `{assetId}` + verified Risk + Compliance output | upstream finding ids / policy codes only | prioritized recommendations, each citing an upstream ref |
| **Report** | `{assetId}` + verified upstream outputs | upstream values only (no new facts) | executive summary + sectioned narrative |
| **Copilot** | `{message, assetId?, conversationId?}` | RAG chunks + whitelisted read-only tools | grounded answer + citations + tool-call log |

## LangChain usage (real, not decorative)

- `langchain-anthropic.ChatAnthropic` — the single live LLM provider
  (`app/llm/provider.py`), behind a `get_chat_model()` factory so other
  providers can be added without touching agents.
- `ChatPromptTemplate`, `SystemMessage`/`HumanMessage` — agent prompts.
- `model.with_structured_output(PydanticModel)` — structured extraction
  in the Recommendation and Report agents.
- `langchain_core.tools.StructuredTool` — the five typed Copilot tools.
- `langchain_core.embeddings.Embeddings` — `LocalHashEmbeddings`, a
  byte-for-byte port of the Fastify local-hash embedder so vectors are
  comparable to the ones the TS indexer wrote.
- `langgraph.prebuilt.create_react_agent` — the Copilot tool-calling loop.

## LangGraph usage (Phase 32)

`app/graph/` is a real orchestration layer, split into focused modules:

| Module | Role |
|---|---|
| `state.py` | `SecurityGraphState` / `CopilotGraphState` (typed `TypedDict`) + reducers (`operator.add`, `merge_dict`, `take_last`) + `ApprovalRequest` |
| `nodes.py` | `make_agent_node(...)` — one reusable adapter that turns any agent into a node with **classified, bounded retry**; plus `await_approval`, `finalize_no_resources`, `revise` control nodes |
| `routing.py` | deterministic conditional-edge functions |
| `errors.py` | `ErrorClass` (7 categories) + `classify_error` + retry policy |
| `checkpointer.py` | Postgres / memory checkpoint backend lifecycle |
| `telemetry.py` | graph + per-node traces (reuses Phase 31 `AiPyRun` / `AiPyTrace`) |
| `security_graph.py` | the security-analysis `StateGraph` + `SecurityGraphService` |
| `copilot_graph.py` | the Copilot conversational `StateGraph` + `CopilotGraphService` |
| `runtime.py` | non-persisted per-request secrets (Copilot bearer token) |

### Security-analysis graph

```
       discovery ──(no resources)──▶ finalize_no_resources ──▶ END
          │
       ┌──┴──┐   fan-out: risk ∥ compliance in one superstep
       ▼     ▼
      risk  compliance
       └──┬──┘   fan-in: recommendation has two incoming edges → waits for BOTH
          ▼
    recommendation ──(critical risk / forced)──▶ await_approval ──(approved)──▶ report ──▶ END
          │                                            │
      (no critical)                                (rejected)
          ▼                                            ▼
        report ──▶ END                              revise ──▶ END
```

- **Genuine parallelism**: `tests/test_graph_parallel.py` replaces Risk & Compliance with timed stand-ins and asserts their execution windows overlap and total wall time ≈ 1× (not 2×) the work.
- **Conditional routing** (`routing.py`) — every condition is deterministic and reads a verified value (`resourceCount`, `counts.critical`, `approval_status`). The LLM never chooses a route (enforced by a test that greps the router source for `summary`/`reasoning`).
- **HITL** — LangGraph's dynamic `interrupt()` inside `await_approval`; the pause point exists only when `counts.critical > 0` or the caller set `requireApproval`. The `ApprovalRequest` (execution id, requested action, reason, severity counts, timestamp, correlation id) is checkpointed. Resume: `Command(resume={"approved": bool, "note": str})`. Approve → `report`; reject → `revise` (safe termination, no report, recommendations retained).
- **Checkpointing** — `langgraph-checkpoint-postgres` `AsyncPostgresSaver`, pool created once in the lifespan. `tests/test_integration.py` proves a full `execute → interrupt → inspect → resume → complete` lifecycle across **three simulated cold service processes** (new pool + saver each time), keyed only by the execution id.
- **Error handling / retry** (`errors.py`) — failures are classified into `transient_infra` / `llm_failure` / `invalid_output` / `missing_context` / `tool_failure` / `authorization` / `permanent`. Only the first three + `tool_failure` are retried, each with a bounded attempt count; authorization and validation errors are never retried. A failed node records a structured error and the graph still terminates.
- **Structured output** — agents already return Pydantic models; the node adapter only accepts a non-`FAILED` `RunResponse`. Deterministic facts are never overwritten: `test_graph_recovery.py` asserts the verified `overallScore`/`counts` survive the graph verbatim.

### Copilot graph

```
understand_intent → retrieve_knowledge → decide_tools ──(tools needed)──▶ run_tools ──▶ END
                                              │
                                       (RAG sufficient)
                                              ▼
                                       generate_answer ──▶ END
```

`decide_tools` is deterministic (live-data intent + assetId, or weak/empty RAG → tools). `run_tools` is a LangChain ReAct loop over the **unchanged** Phase 31 read-only tool allowlist. Conversation continuity is Redis (`ai:py:`); the graph uses an in-process `MemorySaver`. The `/v1/agents/copilot/run` endpoint and `CopilotAgent` are now thin adapters over this graph — one Copilot implementation.

### Endpoints

`POST /v1/graph/execute` · `POST /v1/graph/{id}/resume` · `GET /v1/graph/{id}` (enriched envelope: `status`, `currentNode`, `completedNodes`, `pendingNodes`, `approvalStatus`, `approvalRequest`, `approvalDecision`, per-node `timings`, `errors`, `warnings`) · `GET /v1/graph/{id}/state` (raw checkpoint values, `verified_context` stripped, no secrets).

## Dynamic planner (Phase 33 — `app/planner/`)

The LLM **proposes** a structured `Plan` (via `with_structured_output`);
`validate_plan()` **rejects** — never repairs — a plan naming an unknown
agent/tool, with a cycle, a missing/duplicate/mis-shaped dependency, or a
bad confidence (`PLANNER_MAX_REPAIR_ATTEMPTS` re-asks, then a
deterministic full-analysis fallback). `PlanExecutor` compiles the
**validated** plan into a real LangGraph `StateGraph` (one node per step,
edges from `depends_on`, Postgres checkpointer, `interrupt()` HITL gate
before `report` when `require_approval`). The executor only instantiates
the six registered agents — no arbitrary callables, SQL, or HTTP.
Endpoints: `POST /v1/planner/{plan,execute,{id}/resume}`, `GET /v1/planner/{id}`.

## Debate / consensus (Phase 33 — `app/debate/`)

A LangGraph: `risk ∥ compliance → recommendation → aggregate → consensus
→ [conflicts && round < DEBATE_MAX_ROUNDS] → reconsider → aggregate …`.
Participants give **independent grounded** opinions (verified
findings/scores copied verbatim). `aggregate` / `consensus` are a direct
port of the deterministic TS `consensus.scoring.ts` — agreement score,
conflicts, accepted/rejected findings, blended confidence. `reconsider`
is a bounded LLM round restating *interpretation* only. Endpoint:
`POST /v1/debate/run`.

## Reflection / verification (Phase 33 — `app/reflection/`)

`ReflectionRunner.run(agent, run_once, …)` — a bounded verify→revise loop
(`REFLECTION_MAX_ITERATIONS`). `verify_output()` is deterministic: schema
completeness, grounding, and **fact-consistency** with the verified
bundle. A verified-fact mismatch is *flagged and returned* — never
"fixed" by looping. The Copilot graph's `verify_answer` node applies the
same idea to a chat answer. Also available as `build_reflection_graph()`.

## HITL

LangGraph dynamic `interrupt()` / `Command(resume=…)`, structured
`approval_status` (`not_required` / `pending` / `approved` / `rejected`),
checkpointed `ApprovalRequest`. Present in the security graph *and* the
plan executor.

## RAG (Phase 33 additions)

`app/rag/` — question → `LocalHashEmbeddings.embed_query` (byte-for-byte
port of the TS local-hash embedder, dim 1536) → pgvector cosine search
over the **existing** `KnowledgeDocument` (`1 - (embedding <=> $vec::vector)`,
matching `KnowledgeRepository.search`) → evidence → context → LLM.
Read-only, no schema change, no re-indexing. Phase 33 added: `tags`
metadata filtering, per-query `min_score`, near-duplicate collapsing
(`RAG_DEDUPE`), `RAG_MAX_CONTEXT_CHARS` cap, and `citations_for()` —
structured citations (id, source type, score, snippet) preserved verbatim.

## Memory (Phase 33 hardening)

`app/memory/conversation.py` — per-conversation history + session state in
Redis (`ai:py:` namespace). `history()` trims to a char budget + turn
count (context-window safety); every stored turn is **secret-scrubbed**
(bearer/API-key regex) and length-capped; every Redis op is wrapped so a
memory failure degrades to empty rather than failing the AI request.
Session state rejects any key containing "token".

## Claude provider (Phase 33 — `app/llm/provider.py`)

`get_chat_model()` → `ChatAnthropic` when `LLM_PROVIDER=anthropic` and
`ANTHROPIC_API_KEY` is set, else `DeterministicFakeChat`. Model id:
`ANTHROPIC_MODEL` (falls back to `LLM_MODEL`, default `claude-sonnet-4-5`).
`structured_output(schema, …)` = `with_structured_output` + bounded
validation retry (`STRUCTURED_OUTPUT_MAX_RETRIES`) + fallback.
`verify_anthropic_config()` constructs the client with no network call.

> **Live Claude inference was NOT executed** — no API key was available in
> this environment. All tests run against the fake model. The provider
> switches to the real model automatically once `ANTHROPIC_API_KEY` is set.

## Service contract

`POST /v1/agents/{agent}/run` with a generic envelope:

```jsonc
// RunRequest
{
  "correlation_id": "…",
  "principal": { "user_id": "…", "role": "USER", "bearer_token": "…?" },
  "agent_input": { "assetId": "…" },       // small id, per existing TS contract
  "verified":    { … },                    // deterministic facts from Fastify
  "options":     { "refresh": false }
}
// RunResponse
{
  "status": "COMPLETED|PARTIAL|FAILED",
  "correlation_id": "…",
  "agent": "risk",
  "output": { … },            // mirrors the TS *AgentOutput shape 1:1
  "confidence_score": 0.87,
  "warnings": [], "errors": [],
  "metadata": { "duration_ms": 1234, "model": "claude-sonnet-5", "llm_calls": 3 }
}
```

Auth: every `/v1` route requires `X-Service-Token` (constant-time compare
against `AI_SERVICE_TOKEN`; never logged). Correlation id flows in via
`X-Correlation-Id` and back on every response and log line.

## Local development

```bash
cd apps/ai-service
uv sync                       # create venv + install from uv.lock
cp .env.example .env          # leave ANTHROPIC_API_KEY empty to use the fake LLM
uv run uvicorn app.main:app --reload --port 8000

curl localhost:8000/health
curl localhost:8000/ready     # checks postgres + redis + llm mode
```

The service also reads `../../.env` (repo root), so a single root `.env`
can drive both Fastify and this service.

### Prisma migration

The AiPy trace tables + graph checkpoint tables live in the shared
database. Apply them from `apps/api`:

```bash
cd apps/api && pnpm prisma migrate deploy   # includes 20260906_add_ai_py_traces
```

The Postgres checkpoint tables (`checkpoints`, `checkpoint_writes`, …) are
created automatically by `AsyncPostgresSaver.setup()` on first startup.

## Tests

```bash
uv run pytest                                       # 166 unit tests, fake LLM, no infra
uv run pytest -m "integration or not integration"   # + 6 integration (needs compose)
uv run ruff check app tests
uv run mypy app
```

Coverage: health, config validation, Claude provider config + fake
fallback + structured-output retry, service-token auth, request
validation, all six agents (grounding assertions), LangGraph construction
/ execution / conditional routing / parallel Risk∥Compliance /
Recommendation-waits-for-both / Report-last / checkpoint / resume, dynamic
planner (valid/invalid/unknown-agent/unknown-tool/cycle/bounded/HITL),
debate (consensus / disagreement / bounded rounds / recovery / fact
preservation), reflection (valid / invalid / bounded / fact preservation),
RAG (retrieval / filter / citations / empty / context cap / dedupe),
tools (allowlist / auth / read-only / no write), security (no secrets in
state / memory / logs / errors), contract shapes vs the TS interfaces, and
the full LangGraph-via-Fastify path.

## Docker

```bash
# from repo root
docker compose up -d postgres redis
cd apps/api && pnpm prisma migrate deploy && cd ../..
docker compose up -d --build ai-service       # builds apps/ai-service/Dockerfile
curl localhost:8000/health
curl localhost:8000/ready                      # database / redis / llm mode + model
```

## Switching Fastify to the Python service

In `apps/api` env: `AI_SERVICE_MODE=python` (default `typescript`).
When `python`:
- the `AI_DISCOVERY / AI_RISK / AI_COMPLIANCE / AI_RECOMMENDATION /
  AI_REPORT` job handlers build the verified bundle and call this service;
- `AI_FULL_ANALYSIS` job / `POST /ai/graph/analyze` runs the **complete
  security LangGraph** as one workflow; `POST /ai/graph/{id}/resume`
  forwards a HITL approval;
- `POST /ai/copilot/chat` delegates here (same external request/response).
The TypeScript agents remain in place as the permanent fallback — flip the
env var back and nothing else changes. (`/v1/planner/*` and `/v1/debate/*`
are called directly on this service; the equivalent Fastify routes still
run the TS implementations.)

---

## AI Engineering Highlights

A truthful summary of what this service demonstrates:

- **Python AI microservice** — FastAPI + Pydantic + `uv`, behind the
  TypeScript API, with a hard service-token boundary and correlation-id
  propagation. Deterministic TypeScript stays the source of truth for
  every security fact.
- **LangChain** — `ChatAnthropic` (real Claude) with a deterministic fake
  fallback; `ChatPromptTemplate`; `with_structured_output(PydanticModel)`
  with bounded validation-retry; `StructuredTool` × 5 (typed, read-only);
  `create_react_agent` tool loop; `Embeddings` adapter for pgvector RAG.
- **LangGraph** — three real `StateGraph`s (security analysis, Copilot,
  debate) plus a dynamically-compiled plan graph. Typed state with
  reducers, genuine fan-out/fan-in parallel supersteps, deterministic
  conditional routing, Postgres checkpointing, dynamic `interrupt()` HITL
  with `Command(resume=…)`, classified bounded retry, graph + node
  telemetry.
- **6 specialized agents** — Discovery, Risk, Compliance, Recommendation,
  Report, Copilot. Each has a Pydantic input/output contract mirroring the
  existing TS interface.
- **Dynamic planning** — LLM proposes a structured plan; the app validates
  it against a registry of real agents/tools/dependency shapes; LangGraph
  executes only the validated plan.
- **Multi-agent debate / consensus** — independent grounded opinions,
  deterministic conflict + agreement scoring, bounded rounds.
- **Reflection / verification** — bounded verify→revise loop; verified
  facts always win.
- **RAG** — pgvector over the existing `KnowledgeDocument`, embedding
  parity with the TS indexer, metadata filtering, dedupe, preserved
  citations.
- **Tool calling** — allowlisted, read-only, ownership-enforced via
  Fastify callbacks; multi-call ReAct loop.
- **Memory** — Redis (`ai:py:`) conversation + session state, bounded and
  secret-scrubbed, degrades safely.
- **HITL** — real checkpoint-backed interrupt/resume across separate HTTP
  requests and cold process restarts.
- **TypeScript fallback** — `AI_SERVICE_MODE=typescript` keeps the entire
  original in-process AI stack; nothing was deleted.
- **Claude integration status** — wired and configurable; **live inference
  was not executed** because no API key was available in this environment.
  All tests run against the deterministic fake model.
