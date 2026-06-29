# 02 — API

[← Architecture](01-ARCHITECTURE.md) · [Next: Deployment →](03-DEPLOYMENT.md)

## Source of truth

Canonical OpenAPI: [`lib/api-spec/openapi.yaml`](../lib/api-spec/openapi.yaml).
Phase 3 will:

- Generate Zod validators from OpenAPI
- Generate React Query hooks for `ardalink-web`
- Generate Pydantic models consumed by `ardalink-engine`

## Live docs

- Swagger UI: `http://localhost:3000/api/docs`
- ReDoc: `http://localhost:3000/api/redoc`

(Active in v0.2.0+ once route handlers are wired.)
