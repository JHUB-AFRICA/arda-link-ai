# ArdaLink local-dev

One-command local stack for development, demos, and stakeholder
verification. Lives under `ardalink-api/docs/local-dev/` because the
api is the orchestrator (it owns the runtime topology).

## Quick start

```bash
cd docs/local-dev
make setup      # one-time: copies .env.example to .env
make up         # ~90s, brings up postgres + redis + engine + api + web
make verify     # 30-point health check
make down       # tear down
```

After `make up`:

| Service | URL |
|---|---|
| Operator dashboard | http://localhost:8080/ |
| Public Talk | http://localhost:8080/talk/ |
| API health | http://localhost:3000/api/healthz |
| Engine health | http://localhost:5001/health |
| Postgres | 127.0.0.1:15432 (user `ardalink` / `ardalink_app`, pwd in `.env`) |

## What's in here

| Path | Purpose | Pushed? |
|---|---|---|
| `Makefile` | Single entrypoint — `make help` to list targets | yes |
| `.env.example` | Template for `.env` (placeholders only) | yes |
| `.gitignore` | Excludes `.env` and runtime artifacts | yes |
| `scripts/start-local.sh` | Boots the full stack | yes |
| `scripts/stop-local.sh` | Tears down cleanly | yes |
| `scripts/verify.sh` | 30-point pre-flight health check | yes |
| `migrations/*.up.sql` | Portable SQL (base schema + multi-tenant RLS) | yes |
| `seed-data/seed-demo.sql` | 3 demo tenants, 36 reports — idempotent | yes |
| `docs/walkthrough.md` | Plain-language walkthrough of the demo | yes |
| `docs/cheat-sheet.md` | One-page printable runbook for the session | yes |
| `docs/preflight-checklist.md` | Sunday/Monday/Tuesday checklist | yes |
| `.env` | Real credentials (gitignored) | **no** |
| `/tmp/ardalink-local/` | Runtime PIDs + logs | **no** |

## Security model (the "smart secrets" part)

Three principles, in priority order:

1. **No secret is ever committed to git.** All secrets come from
   `.env` (gitignored) or environment variables. The `.env.example`
   template only contains placeholders and dev-only defaults that are
   visibly weak (e.g. `replace-with-32-plus-bytes-random`).

2. **The local app role is not a superuser.** The api connects as
   `ardalink_app` (NOSUPERUSER, NOBYPASSRLS). Row-Level Security on
   the operational tables is therefore actually enforced. The
   engine uses the superuser `ardalink` because it owns its
   `gis_engine` schema and runs DDL on it.

3. **The verify script proves both layers.** A JWT for one tenant
   returns only that tenant's rows via the api; a direct psql as
   `ardalink_app` with `SET app.current_tenant_id` returns the same.

## Production deploy is a different surface

This folder is for local development. Production deploy uses
`infra/docker/compose.yml` (in the api repo root, not this folder)
with:

- A real managed Postgres (e.g. Cloud SQL, RDS, Supabase)
- A real secret store (GCP Secret Manager, AWS Secrets Manager, etc.)
- TLS via Caddy or a managed load balancer
- Container images from GHCR, signed with cosign

The local stack is a development convenience, not a production
blueprint.

## How the bring-up works

1. Stop any previous run (idempotent)
2. Boot Postgres in Docker on `127.0.0.1:15432`
3. Boot Redis in Docker on `127.0.0.1:6379`
4. Create the `ardalink_app` role (no BYPASSRLS)
5. Apply base schema + multi-tenant migrations
6. Seed 3 demo tenants with realistic data
7. Start `ardalink-engine` (uv + FastAPI) on `127.0.0.1:5001`
8. Start `ardalink-api` (pnpm + tsx) on `127.0.0.1:3000`
9. Start `ardalink-web` (python static server) on `127.0.0.1:8080`
10. Print demo JWTs for each tenant (paste into a curl)

## Running a demo

See `docs/walkthrough.md` for the full plan, and
`docs/cheat-sheet.md` for the one-page runbook. The cross-tenant
proof is in `docs/cheat-sheet.md` under "The cross-tenant demo".

## What is NOT in this stack

- No production deploy path
- No real Africa's Talking calls
- No live GEE data
- No real Azure OpenAI calls
- No changes to `main` on any GitHub repo

## Adding new services

If you need to add a new service to the local stack:

1. Add a `docker run` block in `scripts/start-local.sh` after the
   existing services, following the same `nohup ... & echo $! > pid`
   pattern.
2. Add a `check_http` row in `scripts/verify.sh`.
3. Add the service's env vars to `.env.example`.
4. Update this README's service table.

## Troubleshooting

Most issues are covered in `docs/walkthrough.md` (the "If something
breaks mid-demo" section). If the bring-up fails:

1. Read the log: `tail -50 /tmp/ardalink-local/<service>.log`
2. Try `make down && make up` (idempotent restart)
3. Try `make fresh` (full wipe + rebuild)
4. If all else fails, the pre-restructure backup is at
   `~/ardalink-backups/ardalink-pre-restructure-*.tar.gz`
   (see repo root for the restore procedure).