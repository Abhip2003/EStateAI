# syntax=docker/dockerfile:1
#
# Multi-stage build for apps/api. Build context is the repo root (this is a
# pnpm workspace — `docker build -f apps/api/Dockerfile .`), so every COPY
# below is relative to the monorepo root, not this directory.

FROM node:20-alpine AS base
# libc6-compat/openssl: Prisma's engine and bcrypt's native addon both need
# these on musl-based alpine; harmless, small additions otherwise.
RUN apk add --no-cache libc6-compat openssl && corepack enable
WORKDIR /repo

# ---- deps: full install (deps + devDeps) — used for build and dev ----
FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN pnpm install --frozen-lockfile --filter api...

# ---- deps-prod: production-only install — used for the runtime image ----
FROM base AS deps-prod
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN pnpm install --frozen-lockfile --filter api... --prod

# ---- dev: hot-reloading container, source mounted as a volume by
#      docker-compose.dev.yml — see that file's `api` service ----
FROM deps AS dev
WORKDIR /repo/apps/api
ENV NODE_ENV=development
EXPOSE 3000
CMD ["pnpm", "dev"]

# ---- build: compile TypeScript + generate the Prisma client, exactly the
#      same `prisma:generate` + `build` scripts a non-Docker deploy runs ----
FROM deps AS build
COPY apps/api apps/api
WORKDIR /repo/apps/api
RUN pnpm prisma:generate && pnpm build

# ---- runtime: minimal production image, no source, no devDependencies ----
FROM base AS runtime
ENV NODE_ENV=production
# Root package.json (for its "packageManager" field only — corepack walks up
# from cwd to find it) is what lets `docker compose exec api pnpm ...`
# resolve the same pinned pnpm version used everywhere else, instead of
# corepack silently fetching latest (which requires a newer Node than this
# image ships and breaks outright — see DECISIONS.md). `prisma`/`tsx` moved
# to real `dependencies` (not devDependencies) specifically so this
# `--prod` install still includes them: `docs/DEPLOYMENT.md`'s migration
# (`pnpm prisma:deploy`) and seed (`pnpm prisma:seed`) commands are meant to
# run against this exact runtime container, not a separate build-time-only
# image.
# --chown=node:node: Prisma's CLI (migrate deploy / db seed, run via `docker
# compose exec api pnpm prisma:...` per DEPLOYMENT.md) writes small
# cache/lock files under node_modules/.pnpm/@prisma+engines at invocation
# time even when the engine binary itself is already present — without
# this, node_modules is root-owned (the default for anything COPY'd by the
# build) while the container runs as USER node below, and that write fails
# with EACCES.
COPY package.json package.json
COPY --from=deps-prod --chown=node:node /repo/node_modules /repo/node_modules
COPY --from=deps-prod --chown=node:node /repo/apps/api/node_modules /repo/apps/api/node_modules
COPY --from=build --chown=node:node /repo/apps/api/dist /repo/apps/api/dist
COPY --chown=node:node apps/api/package.json apps/api/package.json
COPY --chown=node:node apps/api/prisma apps/api/prisma
COPY --chown=node:node apps/api/prisma.config.ts apps/api/prisma.config.ts
WORKDIR /repo/apps/api
EXPOSE 3000
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1
CMD ["node", "dist/server.js"]
