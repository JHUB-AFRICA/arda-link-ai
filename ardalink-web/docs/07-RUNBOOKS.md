# 07 — Runbooks

[← Costs](06-COSTS.md) · [Next: Team →](08-TEAM.md)

## Common incidents

- **Vite dev server hot reload breaks** → restart, `pnpm clean`.
- **API 401 storm** → check `VITE_API_BASE_URL` and token mint endpoint.
- **Map tiles 403** → check `VITE_MAP_TILES_URL`.

## Backups

Static assets; no state to back up.

## Disaster recovery

See [archive/phase-0.5-backup.md](../archive/phase-0.5-backup.md).
