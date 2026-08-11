# syntax=docker/dockerfile:1.7
# -----------------------------------------------------------------------------
# ArdaLink API — multi-stage build
# Final image: distroless Node 24 (no shell, no package manager, non-root)
# -----------------------------------------------------------------------------

# ---- Stage 1: dependencies ----
FROM node:24-bookworm-slim AS deps
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY lib ./lib
RUN pnpm install --frozen-lockfile --prod=false

# ---- Stage 2: build ----
FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
COPY --from=deps /app/node_modules ./node_modules
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.json tsconfig.base.json ./
COPY src ./src
COPY lib ./lib
COPY scripts ./scripts
RUN pnpm run build

# ---- Stage 3: production deps (no devDeps) ----
FROM node:24-bookworm-slim AS prod-deps
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY lib ./lib
RUN pnpm install --frozen-lockfile --prod

# ---- Stage 4: runtime ----
FROM gcr.io/distroless/nodejs24-debian12:nonroot AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000
COPY --from=prod-deps --chown=nonroot:nonroot /app/node_modules ./node_modules
COPY --from=build --chown=nonroot:nonroot /app/dist ./dist
COPY --from=build --chown=nonroot:nonroot /app/lib ./lib
COPY --chown=nonroot:nonroot package.json ./
USER nonroot
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:3000/api/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
ENTRYPOINT ["/nodejs/bin/node", "dist/index.mjs"]