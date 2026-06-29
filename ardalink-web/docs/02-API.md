# 02 — API

[← Architecture](01-ARCHITECTURE.md) · [Next: Deployment →](03-DEPLOYMENT.md)

## Source of truth

Canonical OpenAPI: [`ardalink-api/lib/api-spec/openapi.yaml`](https://github.com/MUNENE1212/ardalink-api/blob/main/lib/api-spec/openapi.yaml).

## Generated hooks (Phase 3)

- Orval config in `dashboard/orval.config.ts` and `talk/orval.config.ts`.
- Outputs: `src/api/hooks.ts` (typed React Query wrappers).
- Inputs: Zod schemas (re-exported from `ardalink-api/lib/api-zod`).

## Local proxy

Vite dev server proxies `/api/*` to `VITE_API_BASE_URL`.
