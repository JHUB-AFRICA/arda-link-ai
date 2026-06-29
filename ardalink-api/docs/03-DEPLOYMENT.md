# 03 — Deployment

[← API](02-API.md) · [Next: Security →](04-SECURITY.md)

## Local

```bash
pnpm install
cp .env.example .env
pnpm run dev
```

## Docker (Phase 5)

```bash
docker build -t ardalink-api:dev .
docker run --rm -p 3000:3000 --env-file .env ardalink-api:dev
```

## Compose (Phase 5)

Part of the shared `infra/docker/compose.yml` (lives in this repo).

## Cloud

Cloud-agnostic. IaC (Terraform) deferred until pilot validates Compose.
