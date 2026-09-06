# syntax=docker/dockerfile:1
#
# Multi-stage build for apps/web. Build context is the repo root (this is a
# pnpm workspace — `docker build -f apps/web/Dockerfile .`).

FROM node:20-alpine AS base
RUN corepack enable
WORKDIR /repo

# ---- deps: full install, used for build and dev ----
FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/web/package.json apps/web/package.json
COPY apps/api/package.json apps/api/package.json
RUN pnpm install --frozen-lockfile --filter web...

# ---- dev: hot-reloading container, source mounted as a volume by
#      docker-compose.dev.yml — see that file's `web` service ----
FROM deps AS dev
WORKDIR /repo/apps/web
ENV NODE_ENV=development
EXPOSE 3001
CMD ["pnpm", "dev", "--port", "3001"]

# ---- build: `next build` with standalone output ----
FROM deps AS build
COPY apps/web apps/web
WORKDIR /repo/apps/web
ENV NEXT_TELEMETRY_DISABLED=1
# The only env var this frontend reads (lib/api/client.ts,
# RealtimeProvider.tsx derives the WS URL from the same base) — baked in
# at build time since Next.js inlines NEXT_PUBLIC_* vars into the client
# bundle, not read at container start.
ARG NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}
RUN pnpm build

# ---- runtime: the standalone server only, no source, no devDependencies ----
# Next's standalone output for a pnpm workspace mirrors the monorepo layout
# (a root node_modules with the pnpm store, plus apps/web/node_modules full
# of symlinks pointing back up into it) — pnpm's node_modules are symlinks,
# so flattening this into a single /app dir breaks every relative symlink
# target. Preserving the same /repo/apps/web nesting here is what keeps
# them resolvable.
FROM base AS runtime
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3001
ENV HOSTNAME=0.0.0.0
COPY --from=build /repo/apps/web/.next/standalone ./
COPY --from=build /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /repo/apps/web/public ./apps/web/public
WORKDIR /repo/apps/web
EXPOSE 3001
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:3001/ || exit 1
CMD ["node", "server.js"]
