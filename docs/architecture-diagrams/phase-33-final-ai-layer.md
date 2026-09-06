# Phase 33 — Final Python AI Layer

## A. Complete EstateAI architecture

```mermaid
flowchart TD
    WEB[Next.js frontend] --> API[Fastify + TypeScript API]
    API --> AUTH[auth · GitHub OAuth · Prisma]
    API --> DET[deterministic security analysis<br/>Finding · RiskScore · PolicyResult]
    API -->|AI_SERVICE_MODE=typescript| TSAI[in-process TS AI agents — permanent fallback]
    API -->|AI_SERVICE_MODE=python| PYC[AiServiceClient + verified-bundle builder]
    PYC -->|HTTPS · X-Service-Token · correlation id| PY[Python FastAPI AI service]

    subgraph PY[Python AI service]
      direction TB
      LG[LangGraph — orchestration authority]
      LC[LangChain — LLM · prompts · structured output · tools · RAG]
      AG[6 agents — domain reasoning]
      PLAN[dynamic planner]
      DEB[debate / consensus]
      REF[reflection / verification]
      LG --> AG
      LG --> PLAN
      LG --> DEB
      LG --> REF
      AG --> LC
    end

    DET -. verified bundle .-> PYC
    PY --> PG[(PostgreSQL + pgvector<br/>KnowledgeDocument · AiPy* traces · graph checkpoints)]
    PY --> REDIS[(Redis — ai:py: conversational / session memory)]
```

## B. Dynamic planner

```mermaid
flowchart TD
    G[goal + assetId] --> LLM[LLM proposes a structured Plan<br/>with_structured_output&#40;Plan&#41;]
    LLM --> V{validate_plan}
    V -->|invalid, attempts left| LLM
    V -->|invalid, exhausted| FB[deterministic fallback plan<br/>discovery→risk∥compliance→recommendation→report]
    V -->|valid| EXEC
    FB --> EXEC[PlanExecutor.build_plan_graph]
    EXEC --> LGX[LangGraph StateGraph<br/>one node per step, edges from depends_on]
    LGX --> HITL{constraints.require_approval<br/>&& a report step?}
    HITL -->|yes| INT[interrupt&#40;&#41; before report → resume]
    HITL -->|no| DONE
    INT --> DONE[step_outputs envelope]

    V -. rejects .-> X1[unknown agent]
    V -. rejects .-> X2[unknown tool]
    V -. rejects .-> X3[cycle / missing dep / bad shape]
```

The LLM only *proposes*. The registry (`app/planner/registry.py`) is the
authority on which agents / tool categories / dependency shapes are
allowed. LangGraph executes only the validated plan; it never runs an
arbitrary callable, raw SQL, or an HTTP request.

## C. Debate / consensus

```mermaid
flowchart TD
    START((START)) --> R[risk opinion]
    START --> C[compliance opinion]
    R --> RC[recommendation review]
    C --> RC
    RC --> AGG[aggregate — deterministic derive_conflicts]
    AGG --> CON[consensus — deterministic scoring]
    CON -->|conflicts && round < max_rounds| RECON[reconsider — bounded LLM restatement]
    RECON --> AGG
    CON -->|reached OR round == max| END((END))
```

* Participants (risk, compliance, recommendation) give **independent,
  grounded** opinions — their verified findings/severities/scores are
  copied verbatim into the debate.
* `aggregate` / `consensus` are pure heuristics ported from the TS
  `consensus.scoring.ts` — agreement score, conflict list, accepted /
  rejected findings, blended confidence. Never an LLM judgment on a fact.
* `reconsider` is a bounded round (`DEBATE_MAX_ROUNDS`) where the LLM
  restates *interpretation* only — it cannot change a verified fact.

## D. Reflection / verification

```mermaid
flowchart TD
    START((START)) --> A[run agent]
    A --> V[verify — deterministic<br/>schema · grounding · evidence · fact-consistency]
    V -->|valid| END((END))
    V -->|invalid & iteration < REFLECTION_MAX_ITERATIONS<br/>& issue is agent-fixable| A
    V -->|invalid & verified-fact mismatch| FLAG[flag it — never 'fix' the fact] --> END
```

## E. Copilot LangGraph (Phase 32 + 33.12 verify pass)

```mermaid
flowchart TD
    START((START)) --> UI[understand_intent]
    UI --> RK[retrieve_knowledge — pgvector RAG, dedupe, citations]
    RK --> DT[decide_tools — deterministic]
    DT -->|tools| RT[run_tools — LangChain ReAct, allowlisted read-only tools, multi-call]
    DT -->|RAG enough| GA[generate_answer — one grounded LLM call]
    RT --> VA[verify_answer — light reflection: grounded? has evidence?]
    GA --> VA
    VA --> END((END))
```

## F. Fastify ↔ Python

| Fastify route / job | Python endpoint | Notes |
|---|---|---|
| `AI_DISCOVERY/RISK/COMPLIANCE/RECOMMENDATION/REPORT` jobs | `POST /v1/agents/{agent}/run` | individual agents; Recommendation/Report now get raw `findings`/`policyResults` — Risk/Compliance not re-run (33.8) |
| `AI_FULL_ANALYSIS` job · `POST /ai/graph/analyze` | `POST /v1/graph/execute` | the complete security LangGraph as one workflow (33.7) |
| `POST /ai/graph/{id}/resume` | `POST /v1/graph/{id}/resume` | HITL approval proxy |
| `POST /ai/copilot/chat` | `POST /v1/agents/copilot/run` | Copilot graph |
| — | `POST /v1/planner/{plan,execute,{id}/resume}` | dynamic planner |
| — | `POST /v1/debate/run` | debate / consensus |

## Responsibility split

| Layer | Owns |
|---|---|
| **LangChain** | LLM client + `ChatAnthropic` / fake, prompts, `with_structured_output`, `StructuredTool`, ReAct loop, embeddings, retrieval |
| **LangGraph** | state, nodes, edges, conditional routing, parallel supersteps, checkpointing, `interrupt`/`resume`, plan execution, debate rounds, reflection loop |
| **Agents** | domain reasoning + Pydantic-validated output |
| **Fastify** | auth, deterministic security analysis, verified-bundle assembly, application API, job orchestration — the trusted boundary |
| **PostgreSQL** | application data; **pgvector** = `KnowledgeDocument` retrieval; also AiPy* traces + LangGraph checkpoints |
| **Redis** | `ai:py:` conversational history + session state (bounded, secret-scrubbed) |
