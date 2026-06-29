# 07 — Runbooks

[← Costs](06-COSTS.md) · [Next: Team →](08-TEAM.md)

## On-call

| Severity | Response          | Who             |
| -------- | ----------------- | --------------- |
| SEV-1    | 15 min            | Primary on-call |
| SEV-2    | 1 hour            | Primary on-call |
| SEV-3    | next business day | Triage queue    |

## Common incidents

- **Realtime API rate limit** → circuit breaker, switch to script-only mode.
- **Cosmos DB 429** → bump RU/s, or pre-fetch baseline cache.
- **Africa's Talking delivery failure** → retry with exponential backoff.

## Backups

- PostgreSQL: daily + WAL streaming. RPO 1h, RTO 4h.
- Cosmos DB: continuous backup (Azure default).

## Disaster recovery

See [archive/phase-0.5-backup.md](../archive/phase-0.5-backup.md).
