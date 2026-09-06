# Phase 31 — Python AI Service Architecture

## System context

```mermaid
flowchart TD
    subgraph client[Client]
      WEB[Next.js frontend]
    end
    subgraph ts[TypeScript — apps/api]
      API[Fastify API<br/>auth · OAuth · Prisma · jobs]
      DET[Deterministic security analysis<br/>Finding · RiskScore · PolicyResult]
      TSAGENTS[In-process TS agents<br/>FALLBACK — AI_SERVICE_MODE=typescript]
      CLIENT[AiServiceClient + verified-bundle builder]
    end
    subgraph py[Python — apps/ai-service]
      FAPI[FastAPI<br/>X-Service-Token · correlation ids]
      GRAPH[LangGraph StateGraph]
      AGENTS[6 LangChain agents]
      RAG[pgvector RAG]
      MEM[Redis memory ai:py:]
      TOOLS[Read-only Copilot tools]
    end
    subgraph data[Shared data]
      PG[(PostgreSQL + pgvector<br/>KnowledgeDocument · AiPyRun/AiPyTrace · checkpoints)]
      REDIS[(Redis)]
    end

    WEB --> API
    API --> DET
    API -->|AI_SERVICE_MODE=typescript| TSAGENTS
    API -->|AI_SERVICE_MODE=python| CLIENT
    CLIENT -->|HTTPS + X-Service-Token<br/>RunRequest w/ verified bundle| FAPI
    DET -.verified facts.-> CLIENT
    FAPI --> GRAPH --> AGENTS
    AGENTS --> RAG --> PG
    AGENTS --> MEM --> REDIS
    TOOLS -->|whitelisted GET + user bearer| API
    AGENTS --> TOOLS
    GRAPH -->|checkpoints| PG
    FAPI -->|traces| PG
```

## The security-analysis graph

```mermaid
flowchart TD
    START((start)) --> D[discovery]
    D --> R[risk]
    D --> C[compliance]
    R --> RC[recommendation]
    C --> RC
    RC --> RP[report]
    RP --> END((end))

    RP -. interrupt_before when requireApproval .-> HITL{{HITL pause<br/>POST /v1/graph/&#123;id&#125;/resume}}
```

- `risk` and `compliance` fan out from `discovery` and execute in the same
  LangGraph superstep (parallel).
- `recommendation` has two incoming edges — LangGraph waits for **both**
  before it runs.
- `report` runs last; with `requireApproval` the graph checkpoints and
  pauses before it until a resume call injects the approval decision.

## Request flow — an AI_RISK job with AI_SERVICE_MODE=python

```mermaid
sequenceDiagram
    participant W as Worker (Fastify)
    participant B as verified-bundle.ts
    participant P as Python /v1/agents/risk/run
    participant L as LangChain (Claude)
    participant DB as Postgres

    W->>B: buildRiskBundle(assetId)
    B->>DB: SELECT findings, RiskScore (deterministic rows)
    B-->>W: { findings, riskScore }
    W->>P: RunRequest { agent_input:{assetId}, verified:{findings,riskScore} }
    P->>DB: INSERT AiPyRun (RUNNING)
    P->>L: explain findings + summary (facts are fixed inputs)
    L-->>P: prose
    P->>DB: UPDATE AiPyRun (COMPLETED)
    P-->>W: RunResponse { output: RiskAgentOutput-shaped, ... }
    W->>W: map output -> JobExecutionResult (unchanged downstream)
```

## Trust boundary

| Concern | Owner |
|---|---|
| Findings, severities, risk scores, policy results | **Deterministic TypeScript** (source of truth) |
| Verified-bundle assembly | Fastify (`verified-bundle.ts`) |
| LLM reasoning, narration, prioritization prose | Python agents |
| Graph orchestration, checkpoint, HITL | Python LangGraph |
| RAG retrieval (read-only) | Python over existing pgvector |
| Copilot data pulls | Python → whitelisted Fastify GET routes (user bearer, ownership enforced) |
| AI run traces | Python → `AiPyRun` / `AiPyTrace` only |
```
