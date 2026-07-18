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
│   ├── web/                 # Frontend application (Next.js) — not yet scaffolded
│   └── api/                 # Backend application (Fastify + TypeScript + Prisma)
├── packages/
│   ├── shared/               # Shared TypeScript types/utils/constants across apps
│   └── config/                # Shared tooling config (eslint, tsconfig, prettier)
├── docs/
│   ├── architecture/         # Architecture decision records and design notes
│   └── development.md         # Local development setup (Docker Compose, running the API)
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
| Cache / Queues | Redis + BullMQ *(BullMQ is a future milestone)* | Background job processing for continuous, asynchronous monitoring of external services. |
| Local infra | Docker Compose (Postgres + Redis only) | Reproducible local backing services without containerizing the API itself, which still runs natively via `pnpm run dev` for a fast inner dev loop. |
| Auth | Better Auth or Auth.js *(future milestone)* | Deferred — not implemented yet. |
| AI | Claude API / OpenAI API *(future milestone)* | Deferred — used later for report generation and analysis, not chat. |

> **Status:** Backend scaffold with Fastify, Prisma/PostgreSQL, Redis, and health/readiness endpoints is in place. No auth, business logic, queues, or API containerization yet — these are addressed in future milestones.

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
