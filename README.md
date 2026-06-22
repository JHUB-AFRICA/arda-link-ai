# ArdaLink

**Pastoralist intelligence platform for the drylands of Isiolo County, Kenya.**

Three demo deployments: Bula Pesa, Garbatulla, Merti wards. Each ward
is an isolated tenant; pastoralists are registered in their own ward;
satellite + herder reports are scoped per tenant. The platform runs
end-to-end on a single laptop with Docker, or scales horizontally
behind a load balancer.

---

## Repository map

This workspace contains **three independently-deployable service repos**,
plus internal team files. Every public repo has its own README, its
own lockfile, its own Dockerfile, and its own CI.

| Path | Language | Runtime | Purpose | Public docs |
|---|---|---|---|---|
| `ardalink-engine/` | Python 3.12 | FastAPI / uvicorn | Biophysical compute (energy, water, herd dynamics) | `ardalink-engine/README.md` |
| `ardalink-api/` | TypeScript | Node 22 / Express 5 | Multi-tenant HTTP API, auth, intelligence cycle | `ardalink-api/docs/local-dev/README.md` |
| `ardalink-web/` | TypeScript | React 19 / Vite 7 | Operator dashboard + public talk app | `ardalink-web/dashboard/README.md` |
| `ardalink-internal/` | — | — | Lead-engineer continuity, comms drafts, status notes | **not public** |

```
JHUB/
├── ardalink-engine/    ← Python service
├── ardalink-api/       ← Node service (the multi-tenant boundary)
├── ardalink-web/       ← React apps (dashboard + talk)
├── ardalink-internal/  ← internal-only files (chmod 700, not in any repo)
├── ARCHITECTURE.md     ← system diagrams and data flow
├── RUNBOOK.md          ← step-by-step operator manual
└── LOCAL_SETUP.md      ← quick-start for a new machine
```

---

## Where to start

- **New to the codebase?** Read `ARCHITECTURE.md` first — 5-minute tour
  of every service, the auth model, the data model, and the request
  flow.
- **Want to run the stack locally?** Read `RUNBOOK.md`. It walks
  through prerequisites, first-time setup, daily workflow, and
  troubleshooting.
- **Setting up on a new machine?** `LOCAL_SETUP.md` is the 5-minute
  version.
- **Stakeholder communication, status, retrospective?** `ardalink-internal/`.

---

## Five-line summary for anyone in a hurry

1. Three services. The API is the only one that touches the database
   directly. The web apps talk to the API. The engine is currently a
   thin service for `/health`; the real biophysical work is in
   `ardalink-engine/src/`.
2. Multi-tenant by JWT claim. Every API request carries a Bearer
   token; the claim's `tenant_id` is bound to the Postgres session
   via `SET LOCAL app.current_tenant_id`, and every operational table
   has `ENABLE + FORCE ROW LEVEL SECURITY` so it filters rows
   automatically.
3. The web apps are pure static assets served by a thin Python server
   that also proxies `/api/*` and `/ws/*` to the API. No CORS dance,
   no separate origin, no surprises.
4. RLS is the only thing standing between tenants. There is no
   application-level `WHERE tenant_id = ?` check anywhere in the
   request path. If RLS were disabled, every tenant would see every
   other tenant's data.
5. The public surface for local dev is `ardalink-api/docs/local-dev/`
   — one Makefile, one `.env.example`, one `make verify` that runs
   27 checks end-to-end. The internal files are intentionally outside
   the repos.

---

## Build, test, run

```bash
# Prereqs: Node 22+, pnpm 9+, Python 3.12+, uv, Docker, psql, jq, curl

# Fresh stack on a clean machine (~90s):
cd ardalink-api/docs/local-dev
make setup     # one-time: copy .env.example to .env
make up        # bring up postgres + redis + engine + api + web
make verify    # 27-point health check — should be READY 22/27

# Stop everything:
make down

# Wipe data + rebuild from scratch:
make fresh
```

See `RUNBOOK.md` for the full walkthrough and `LOCAL_SETUP.md` for the
5-minute version.

---

## Status (last verified)

`make verify` against a fresh clone of `migrate/import-legacy`:

```
== Services ==          ✓ api, engine, web, talk
== Database ==          ✓ 3 tenants, RLS on
== Auth + Multi-tenant ==  ✓ JWT claim wins, RLS isolation 12 == 12
== Tests ==             ✓ api (17), web (7), engine (15)
READY: 22/27 passed (5 expected warnings = our own services on the ports)
```

See `ardalink-internal/STATUS-2026-06-22.md` for the dated
narrative.

---

*Maintained by the Lead Software Engineer. Last update: 2026-06-22.*
