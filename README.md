# EstateAI

## Overview

EstateAI is a production-grade **Multi-Agent Digital Asset & Continuity Manager**. It discovers, organizes, monitors, analyzes, and protects a user's digital assets across the services they rely on — GitHub, AWS, Gmail, Google Drive, Stripe, domains, Notion, Dropbox, Slack, Cloudflare, and more.

It is an **event-driven, multi-agent platform** — not an AI chatbot. Each integration behaves as its own agent/module, continuously monitoring its connected service and feeding into a unified **Digital Health Report** covering:

- Security risks (exposed secrets, misconfigurations)
- Cost optimization opportunities
- Forgotten or abandoned assets
- Subscription waste
- Continuity recommendations (what happens to these assets over time)

## Goals

- Give individuals and teams a single, continuously up-to-date picture of their digital footprint across services.
- Surface risk, waste, and neglect automatically, without manual audits.
- Provide continuity planning — ensuring digital assets are accounted for and recoverable over time.
- Build this as a maintainable, cleanly architected system (clean architecture / SOLID / DDD where appropriate) — not a quick prototype.

## Folder Structure

```
EstateAI/
├── apps/
│   ├── web/                 # Frontend application (Next.js + TypeScript + Tailwind CSS)
│   ├── api/                 # Backend application (Fastify + TypeScript + Prisma)
│   └── ai-service/          # Python AI service (FastAPI + LangChain + LangGraph), Phase 31
├── packages/
│   ├── shared/               # Shared TypeScript types/utils/constants across apps
│   └── config/                # Shared tooling config (eslint, tsconfig, prettier)
├── docs/
│   ├── architecture/         # (reserved for design notes; ADR-style decisions currently live in DECISIONS.md)
│   ├── development.md        # Local development setup (Docker Compose, running the API)
│   ├── ARCHITECTURE.md       # System architecture, layering, cross-cutting patterns
│   ├── DATABASE.md           # Prisma schema reference
│   ├── API_REFERENCE.md      # Full route reference
│   ├── DECISIONS.md          # Non-obvious architectural decisions and rationale
│   ├── PROJECT_PROGRESS.md   # Checkpoint-by-checkpoint status
│   ├── TODO.md                # Known gaps, deferred work
│   └── CHANGELOG.md           # Notable changes per checkpoint
├── docker-compose.yml           # Local infrastructure only: PostgreSQL + Redis
├── .gitignore
├── .editorconfig
└── README.md
```

This structure follows a **pnpm workspace monorepo** layout, allowing `apps/*` to consume shared code from `packages/*` without publishing to a registry.

## Tech Stack

| Layer | Technology | Rationale |
|---|---|---|
| Monorepo tooling | pnpm workspaces | Fast, disk-efficient, strict dependency isolation across multiple apps and shared packages. |
| Frontend | Next.js, React, TypeScript, Tailwind CSS, shadcn/ui | SSR/RSC support, mature deployment story, type safety, and a consistent composable design system. |
| Backend | Fastify, TypeScript | Lightweight, high-performance HTTP framework; modules are composed as plain Fastify plugins rather than a heavier framework's DI container. |
| Database | PostgreSQL + Prisma | Relational consistency for structured domain data, with type-safe queries and migrations. |
| Cache / Queues | Redis + a custom Postgres-backed job queue | Background job processing for continuous, asynchronous monitoring of external services. Redis is used as a fast-path wake signal only; PostgreSQL (`SyncJob`) is the durable queue and source of truth. |
| Local infra | Docker Compose (Postgres + Redis only) | Reproducible local backing services without containerizing the API itself, which still runs natively via `pnpm run dev` for a fast inner dev loop. |
| Auth | Custom JWT (access + rotating refresh tokens) | Implemented — see [docs/API_REFERENCE.md](docs/API_REFERENCE.md). |
| Analysis | Deterministic rule engine (no LLM) | Implemented — a registry of rules evaluates discovered resources into findings, recommendations, and weighted risk scores. |
| AI (TypeScript) | `@langchain/langgraph` in-process, Claude/OpenAI providers | The original six-agent AI subsystem (Phases 16–30): agents, RAG/pgvector, memory, planner, reflection, debate/consensus, HITL. Always present; the fallback for Phase 31. |
| AI (Python) | **FastAPI · Pydantic · LangChain · LangGraph** (`apps/ai-service`) | Phase 31 — a real Python service reimplementing the six agents as LangChain agents on a LangGraph `StateGraph`. Opt-in via `AI_SERVICE_MODE=python`; deterministic TS analysis stays the source of truth for security facts. See [apps/ai-service/README.md](apps/ai-service/README.md). |

> **Status:** Auth, the full Asset domain (categories/tags/events), OAuth + sync/discovery integrations (GitHub), an async job/worker platform, universal resource persistence, a knowledge graph + search layer, and a deterministic rule-based analysis engine (findings, recommendations, risk scoring) are all implemented. See [docs/PROJECT_PROGRESS.md](docs/PROJECT_PROGRESS.md) for the current checkpoint status, [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how it fits together, and [docs/API_REFERENCE.md](docs/API_REFERENCE.md) for the full route list. AI agents, webhooks, and vector search/embeddings are not yet implemented.

## Local Development

Start backing services (PostgreSQL + Redis) with Docker Compose, then run the API natively:

```
docker compose up -d          # start Postgres + Redis
cd apps/api
cp .env.example .env           # first time only
pnpm run dev                    # runs the Fastify API locally on http://localhost:3000
```

Verify everything is wired up correctly:

```
curl http://localhost:3000/health/ready
```

See [docs/development.md](docs/development.md) for the full guide, including how to check container health, view logs, and tear the environment down.

### Python AI service (Phases 31–33, optional)

A Python FastAPI service (LangChain + LangGraph) that reimplements the AI
layer: 6 agents, a security-analysis LangGraph (parallel Risk∥Compliance,
conditional routing, Postgres-checkpointed HITL), a Copilot graph, a
dynamic LLM planner, multi-agent debate/consensus, a bounded reflection
loop, pgvector RAG, read-only tool calling, and Redis memory. Deterministic
TypeScript stays the source of truth for every security fact.

```
cd apps/ai-service
uv sync                        # create venv + install (uv + pyproject.toml)
cp .env.example .env           # leave ANTHROPIC_API_KEY empty to use the deterministic fake LLM
uv run uvicorn app.main:app --reload --port 8000
curl http://localhost:8000/ready
uv run pytest                                       # 166 unit tests (no infra)
uv run pytest -m "integration or not integration"   # + 6 integration (needs compose)
```

To route Fastify's AI layer to it, set `AI_SERVICE_MODE=python` (and
`AI_SERVICE_TOKEN`) in `apps/api/.env`. Default is `typescript` — the
in-process TS agents, kept permanently as the fallback. `POST /ai/graph/analyze`
runs the complete LangGraph workflow as one job. Full guide + AI
Engineering Highlights: [apps/ai-service/README.md](apps/ai-service/README.md).

> Live Claude inference has **not** been executed (no API key in this
> environment); all tests run against the deterministic fake model. The
> provider switches to the real model automatically once `ANTHROPIC_API_KEY`
> is set.
