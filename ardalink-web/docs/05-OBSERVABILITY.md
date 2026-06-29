# 05 — Observability

[← Security](04-SECURITY.md) · [Next: Costs →](06-COSTS.md)

## Browser telemetry

- Sentry (or equivalent) for client errors and session replay (Phase 8).
- Web Vitals reported to OTLP via `@opentelemetry/sdk-trace-web`.

## Key gauges

- `ardalink_web.page.views.total{route}`
- `ardalink_web.api.errors.total{route,status}`
