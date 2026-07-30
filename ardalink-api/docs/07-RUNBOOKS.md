# 07 — Runbooks

[← Costs](06-COSTS.md) · [Next: Team →](08-TEAM.md)

## On-call

| Severity | Response          | Who             |
| -------- | ----------------- | --------------- |
| SEV-1    | 15 min            | Primary on-call |
| SEV-2    | 1 hour            | Primary on-call |
| SEV-3    | next business day | Triage queue    |

## Common incidents

- **Realtime API rate limit** → circuit breaker, switch to deterministic pipeline mode.
- **Supabase PostgREST timeout** → local Postgres mirror serves reads; check `GET /api/healthz` per-table freshness; restart sync job if mirror is stale.
- **VCI null on `satellite_indices`** → trigger `pnpm --filter ardalink-api run vci-backfill` CLI or wait for next hourly `vciBackfillJob` tick.
- **Africa's Talking delivery failure** → retry with exponential backoff.

## Backups

- Local PostgreSQL: daily + WAL streaming. RPO 1h, RTO 4h.
- Supabase: managed continuous backup (Supabase default). Point-in-time restore via Supabase dashboard.

## Disaster recovery

See [archive/phase-0.5-backup.md](../archive/phase-0.5-backup.md).
