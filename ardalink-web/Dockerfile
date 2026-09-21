# syntax=docker/dockerfile:1.7
# -----------------------------------------------------------------------------
# ArdaLink Web — multi-stage build
# Two apps (dashboard, talk) built separately, served by nginx
# -----------------------------------------------------------------------------

# ---- Stage 1: deps ----
FROM node:24-bookworm-slim AS deps
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json .npmrc ./
COPY dashboard/package.json dashboard/
COPY talk/package.json talk/
COPY packages ./packages
RUN pnpm install --frozen-lockfile --prod=false

# ---- Stage 2: build dashboard ----
FROM node:24-bookworm-slim AS build-dashboard
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
COPY --from=deps /app/node_modules ./node_modules
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages ./packages
COPY dashboard ./dashboard
ENV BASE_PATH=/
RUN pnpm --filter @workspace/dashboard run build

# ---- Stage 2: build talk ----
FROM node:24-bookworm-slim AS build-talk
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
COPY --from=deps /app/node_modules ./node_modules
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages ./packages
COPY talk ./talk
ENV BASE_PATH=/talk/
RUN pnpm --filter @workspace/talk run build

# ---- Stage 3: runtime (nginx) ----
FROM nginx:1.27-alpine AS runtime
RUN rm -rf /usr/share/nginx/html/* /etc/nginx/conf.d/default.conf
COPY --from=build-dashboard /app/dashboard/dist /usr/share/nginx/html/dashboard
COPY --from=build-talk /app/talk/dist /usr/share/nginx/html/talk
COPY nginx.conf /etc/nginx/conf.d/default.conf
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1/healthz || exit 1
EXPOSE 80