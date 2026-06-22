# ArdaLink — Local Setup (5-minute install)

The shortest path from a clean machine to a working local stack.
For the full manual, see `RUNBOOK.md`. For diagrams, see
`ARCHITECTURE.md`.

---

## Prerequisites

| Tool | Min | Check |
|---|---|---|
| Node.js | 22.x | `node -v` |
| pnpm | 9.x | `pnpm -v` |
| Python | 3.12 | `python3 --version` |
| uv | latest | `uv --version` |
| Docker | 24+ | `docker version` |
| psql, curl, jq | any | `psql --version && curl --version && jq --version` |
| Git | 2.30+ | `git --version` |

---

## 1. Clone the three repos

```bash
mkdir -p ~/arjolink && cd ~/arjolink
for repo in ardalink-engine ardalink-api ardalink-web; do
  git clone --branch migrate/import-legacy \
    https://github.com/MUNENE1212/$repo.git
done
```

The public local-dev surface is `ardalink-api/docs/local-dev/`. That
one Makefile drives the whole stack.

---

## 2. Install dependencies (one-time, ~2 min)

```bash
# API (Node, 22 packages direct + transitive)
cd ardalink-api && pnpm install --frozen-lockfile && cd ..

# Web (Node, react 19 + tailwind 4 + radix + recharts + wouter)
cd ardalink-web  && pnpm install --frozen-lockfile && cd ..

# Engine (Python, fastapi + shapely + httpx)
cd ardalink-engine && uv sync --extra dev && cd ..
```

> `--frozen-lockfile` is the right default. It guarantees you get
> exactly the deps the team shipped, not "whatever's latest". If
> you've intentionally bumped a dep, drop the flag.

---

## 3. Configure environment (one-time, ~10 sec)

```bash
cd ardalink-api/docs/local-dev
make setup
```

This copies `.env.example` to `.env` with safe dev defaults:

- `POSTGRES_PASSWORD=ardalink_dev_only`
- `JWT_SECRET=replace-with-32-plus-bytes-random` (placeholder, 35+ bytes — valid)
- `TENANT_ATTESTATION_SECRET=replace-with-32-plus-bytes-random-shared-with-engine`
- `SESSION_SECRET=replace-with-32-plus-bytes-random`

> **Don't reuse these in production.** The shipped placeholders are
> long enough to pass the API's checks but they're a known constant
> on GitHub. Rotate before any non-dev deploy.

---

## 4. Bring up the stack (~90 sec)

```bash
cd ardalink-api/docs/local-dev
make up
```

This script:

1. Stops any previous stack (idempotent).
2. Starts Postgres in Docker on `127.0.0.1:15432`.
3. Starts Redis in Docker on `127.0.0.1:6379`.
4. Applies migrations (`0000`, `0001_public`, `0001_gis_engine`).
5. Creates the `ardalink_app` role with `NOSUPERUSER, NOBYPASSRLS`.
6. Seeds 3 demo tenants + 36 ground-truth reports + 15 pastoralists.
7. Starts the engine on `127.0.0.1:5001`.
8. Starts the API on `127.0.0.1:3000`.
9. Starts the web server on `127.0.0.1:8080` (dashboard + talk).
10. Prints three demo JWTs — copy them.

Expected last lines:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ArdaLink local stack is up
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Dashboard   http://localhost:8080/
  Talk        http://localhost:8080/talk/
  API         http://localhost:3000/api/healthz
  Engine      http://localhost:5001/health
  Postgres    127.0.0.1:15432 (user ardalink / ardalink_app)
```

---

## 5. Verify (~20 sec)

```bash
make verify
```

Expected:

```
== Services ==          ✓ 4/4
== Database ==          ✓ 3 tenants, RLS on
== Auth + Multi-tenant ==  ✓ RLS isolation 12 == 12
== Tests ==             ✓ api + web + engine
READY: 22/27 passed (5 expected warnings)
```

The 5 warnings are always "port occupied by our own services" — the
verifier confirms the ports are bound, not that they are free.

---

## 6. Try it out

```bash
# From the local-dev directory:
TOKEN=$(make token T=bula-pesa)

# Hit a public endpoint:
curl -s http://localhost:3000/api/healthz | jq .

# Hit an authenticated endpoint:
curl -s -H "Authorization: Bearer $TOKEN" \
  'http://localhost:3000/api/ground-truth/recent?limit=3' | jq '.[] | .reportedLocation'

# Open the dashboard in a browser:
# http://localhost:8080/?token=<paste-from-step-4>&tenant=bula-pesa
```

---

## 7. Tear down

```bash
cd ardalink-api/docs/local-dev
make down          # stops containers, keeps the data volume
# or
make fresh         # stops + deletes the data volume + re-seeds
```

`make down` is reversible. `make fresh` is destructive (deletes the
demo data; you'll need to re-seed).

---

## Where to go next

- **Need the full operator manual?** `RUNBOOK.md` — daily workflow,
  troubleshooting, disaster recovery, how to read the source.
- **Need the architecture?** `ARCHITECTURE.md` — system overview,
  multi-tenant request flow, HMAC attestation, data model.
- **Need to understand a specific code path?** `RUNBOOK.md` has a
  "How to read the source" table at the bottom.

---

*Maintained by the Lead Software Engineer. Last update: 2026-06-22.*
