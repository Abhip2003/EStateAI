# Local Development

This document explains how to run EstateAI's infrastructure (PostgreSQL and Redis) locally using Docker Compose, and how to run the API itself.

The API (`apps/api`) is **not** containerized. It runs directly on your machine via `pnpm run dev`, while Docker only manages backing services (database, cache).

## Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) (or another Docker Engine + Compose v2 installation)
- Node.js (see the version used elsewhere in this repo)
- pnpm

Verify Docker is available:

```
docker --version
docker compose version
```

## Starting infrastructure

From the project root (where `docker-compose.yml` lives):

```
docker compose up -d
```

- `up` creates and starts the `postgres` and `redis` containers.
- `-d` runs them in the background (detached) so your terminal stays free.
- Data persists across restarts in named Docker volumes (`postgres_data`, `redis_data`) — stopping or removing the containers does not delete your data unless you also remove the volumes.

## Checking container status

```
docker compose ps
```

Shows each service's container, port mapping, and health status (`healthy`, `starting`, or `unhealthy`) — see [Verifying container health](#verifying-container-health) below.

## Viewing logs

```
docker compose logs
```

Add `-f` to follow logs in real time, or target a single service:

```
docker compose logs -f postgres
docker compose logs -f redis
```

## Stopping infrastructure

```
docker compose down
```

Stops and removes the containers (but **not** the named volumes — your data is preserved). To also wipe the data volumes:

```
docker compose down -v
```

## Running the API

With `postgres` and `redis` up, start the API separately:

```
cd apps/api
cp .env.example .env   # first time only
pnpm run dev
```

The default `.env.example` values already match the Docker Compose service credentials, so no changes are needed for local development.

## Verifying container health

```
docker compose ps
```

Look for `healthy` in the `STATUS` column for both services. This is driven by the `healthcheck` blocks in `docker-compose.yml`:

- **postgres**: runs `pg_isready -U estateai -d estateai` every 5s
- **redis**: runs `redis-cli ping` every 5s

You can also check the API's own readiness endpoint once it's running, which independently confirms it can reach both services:

```
curl http://localhost:3000/health/ready
```
