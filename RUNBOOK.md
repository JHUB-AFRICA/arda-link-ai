# ArdaLink — Operator's Runbook

Step-by-step manual for running the full local stack. Read this if
`LOCAL_SETUP.md` is too brief and you want the full picture. For the
5-minute version, see `LOCAL_SETUP.md`. For diagrams, see
[`Arda-link-AI-Docs/architecture.md`](./Arda-link-AI-Docs/architecture.md).
For the high-level project overview, see [`README.md`](./README.md).

---

## Contents

1. [Prerequisites](#1-prerequisites)
2. [One-time setup on a new machine](#2-one-time-setup-on-a-new-machine)
3. [Daily workflow](#3-daily-workflow)
4. [Git workflow](#4-git-workflow)
5. [Common operations](#5-common-operations)
6. [Verifying a release candidate](#6-verifying-a-release-candidate)
7. [Troubleshooting](#7-troubleshooting)
8. [Disaster recovery](#8-disaster-recovery)
9. [How to read the source](#9-how-to-read-the-source)

---

## 1. Prerequisites

| Tool | Min version | Check | Install (Ubuntu/Debian) |
|---|---|---|---|
| Node.js | 22.x | `node -v` | `nvm install 22 && nvm use 22` |
| pnpm | 9.x | `pnpm -v` | `npm i -g pnpm` |
| Python | 3.12 | `python3 --version` | `apt install python3.12` |
| uv | latest | `uv --version` | `curl -LsSf https://astral.sh/uv/install.sh \| sh` |
| Docker | 24+ | `docker version` | see docker.com |
| PostgreSQL client | 14+ | `psql --version` | `apt install postgresql-client` |
| curl, jq | any | `curl --version && jq --version` | `apt install curl jq` |
| Git | 2.30+ | `git --version` | `apt install git` |

**Do not skip `jq`.** The verify script and several runbook commands
parse JSON with it.

---

## 2. One-time setup on a new machine

### 2.1 Clone the repo

```bash
git clone https://github.com/JHUB-AFRICA/arda-link-ai.git
cd arda-link-ai
```

The three services (`ardalink-engine/`, `ardalink-api/`, `ardalink-web/`)
ship as siblings in this single public monorepo. There are no separate
private repos to clone.

### 2.2 Install dependencies

```bash
# ardalink-api
cd ardalink-api && pnpm install --frozen-lockfile && cd ..

# ardalink-web
cd ardalink-web && pnpm install --frozen-lockfile && cd ..

# ardalink-engine
cd ardalink-engine && uv sync --extra dev && cd ..
```

If you skip `--frozen-lockfile`, pnpm will try to resolve the catalog
on the network and may take a long time. Always frozen in CI; locally
it's a judgement call.

### 2.3 Configure environment

The public dev surface is `ardalink-api/docs/local-dev/`. Copy the
example env and edit if needed:

```bash
cd ardalink-api/docs/local-dev
make setup       # writes .env with dev-only defaults
```

The defaults are:

| Var | Default | Safe to change? |
|---|---|---|
| `POSTGRES_PASSWORD` | `ardalink_dev_only` | Local only — never reuse in prod |
| `POSTGRES_PORT` | `15432` | Yes; don't collide with system Postgres on 5432 |
| `JWT_SECRET` | `replace-with-32-plus-bytes-random` (placeholder) | Dev only. Production rotates |
| `TENANT_ATTESTATION_SECRET` | placeholder | Same |
| `SESSION_SECRET` | placeholder | Same |

> **The shipped `.env` placeholders ARE valid.** They are 35+ bytes
> long, so the API's `JWT_SECRET.length >= 32` check passes. The
> warning is a convention, not a runtime check.

### 2.4 Bring the stack up

```bash
cd ardalink-api/docs/local-dev
make up
```

The script:

1. Stops any previous stack (idempotent).
2. Starts Postgres in Docker on `:15432`.
3. Starts Redis in Docker on `:6379`.
4. Runs the migrations (idempotent — `IF NOT EXISTS` everywhere).
5. Creates the `ardalink_app` role with `NOSUPERUSER, NOBYPASSRLS`.
6. Seeds 3 demo tenants + 36 ground-truth reports + 15 pastoralists.
7. Starts the engine on `:5001`.
8. Starts the API on `:3000`.
9. Starts the web server on `:8080` (serves dashboard + talk).
10. Prints demo JWTs for all three tenants.

This takes ~90 seconds on a cold cache.

### 2.5 Verify

```bash
cd ardalink-api/docs/local-dev
make verify
```

Expected output:

```
== Services ==          ✓ 4/4
== Database ==          ✓ (migrations, 3 tenants, RLS on)
== Auth + Multi-tenant ==  ✓ RLS isolation 12 == 12
== Tests ==             ✓ api (17), web (7), engine (15)

READY: 22/27 passed (5 expected warnings)
```

The 5 warnings are always "port occupied (may be our own service)" —
the verifier just confirms the ports are bound, not that they are
free.

---

## 3. Daily workflow

### Start of day

```bash
cd ardalink-api/docs/local-dev
make up
```

If the stack was already running, this is a no-op for the data
services. If it was stopped (`make down`), this re-creates the
containers but keeps the data volume.

### End of day

```bash
cd ardalink-api/docs/local-dev
make down
```

This stops the containers and removes them. **Data is preserved**
in a Docker volume (`ardalink-local-pgdata`).

### During the day

```bash
# Watch the logs:
make logs

# See what's running:
make ps

# Re-run the verifier:
make verify
```

### Editing code

The api and the web both have hot-reload:

- `ardalink-api` uses `tsx watch src/index.ts` — saved files trigger
  a restart. Watch the log for "Restarting...".
- `ardalink-web` doesn't have a dev server in local-dev (the
  bundles are pre-built). Rebuild with
  `cd ardalink-web/dashboard && pnpm run build` then `cp -r dist/* /tmp/ardalink-local/web/dashboard/dist/`.

The engine has no hot-reload. Restart it:

```bash
pkill -f "ardalink_engine.main"
cd ardalink-engine && uv run python -m ardalink_engine.main &
```

---

## 4. Git workflow

Three long-lived branches, strict promotion order:

```
master ← staging ← dev ← feature/*, fix/*, chore/*, refactor/*, docs/*
```

- **Active work**: branch off `dev`, open a PR to `dev` when ready.
- **Integration**: open `dev` → `staging` PRs for final touches (copy polish, env-var audit, last-minute bumps).
- **Release**: open `staging` → `master` PRs. Tag the merge commit with the version.
- **Back-merge**: after every `staging` → `master` promotion, sync `master` back to `dev` so `dev` never falls behind.

Full rules, branch naming, commit message format, and PR-target checklist live in [`CONTRIBUTING.md`](./CONTRIBUTING.md). Read it once; follow it always.

### Promotion quick-reference

```bash
# Local: stage a dev → staging promotion (do this on the staging branch)
git checkout staging
git merge --no-ff dev                       # merge with history
pnpm run typecheck && pnpm run test         # local sanity
git push origin staging                     # CI will run

# After staging → master lands + e2e green, back-merge:
git checkout dev
git merge --no-ff master
git push origin dev
```

### Daily sanity (5 seconds, run before opening any PR)

```bash
# Are you on a feature branch, not dev?
git branch --show-current                   # ^ should NOT be `dev`

# Is your branch up to date with dev?
git fetch origin
git status -sb                             # ^ should say "ahead/behind 0 0" or just "ahead"

# Is your history clean (no merge commits, no WIP)?
git log --oneline dev..HEAD                # ^ scan for "WIP", "fixup!", "merge branch dev"
```

If any answer is wrong, fix it before opening the PR — don't push a messy branch and expect reviewers to clean it up.

### Weekly branch hygiene (2 minutes, run on Fridays)

The repo accumulates stale branches fast. Run `scripts/branch-hygiene.sh` once a week to spot them:

```bash
./scripts/branch-hygiene.sh                # human report
./scripts/branch-hygiene.sh --cleanup     # also prints delete commands
./scripts/branch-hygiene.sh --json        # machine-readable for CI
```

The script never deletes anything. With `--cleanup` it prints the exact `git branch -d` / `git push origin --delete` commands for each branch it classifies as `MERGED` (already in `dev`), `EMPTY` (no commits past master — recreate the name when actual work starts), or `STALE` (behind `dev` with no activity — rebase or close). Copy-paste the commands you agree with; ignore the rest.

**Classification rules the script uses:**

| Class | Meaning | Action |
|---|---|---|
| `MERGED` | All commits reachable from `dev` | Safe to delete (local + remote) |
| `EMPTY` | No commits past `master` | Delete — recreate the name when work actually starts |
| `STALE` | Has commits, but `dev` has moved on | Either rebase onto `dev` and keep working, or close the branch |
| `ACTIVE` | Has commits `dev` doesn't | Keep working — open the PR |

Protected branches (`master`, `staging`, `dev`) are never reported.

---

## 5. Common operations

### 5.1 Mint a demo JWT

```bash
cd ardalink-api/docs/local-dev
TOKEN=$(make token T=bula-pesa)    # default tenant
echo $TOKEN
```

This mints a JWT signed with the dev `JWT_SECRET` for the tenant
of your choice. The expiry is `9999999999` (year 2286), so the
token is good for any session in this lifetime.

To mint for a different tenant:

```bash
make token T=garbatulla
make token T=merti
```

### 5.2 Call an authenticated API

```bash
TOKEN=$(make token T=bula-pesa)
curl -s -H "Authorization: Bearer $TOKEN" \
  http://localhost:3000/api/ground-truth/recent?limit=5 | jq .
```

### 5.3 Query Postgres directly (as `ardalink` superuser)

```bash
PGPASSWORD=ardalink_dev_only psql -h 127.0.0.1 -p 15432 -U ardalink -d ardalink
```

Useful queries:

```sql
-- List tenants
SELECT tenant_id, display_name, region FROM public.tenants;

-- Count reports per tenant (cross-tenant OK as ardalink superuser)
SELECT tenant_id, count(*) FROM public.ground_truth_reports GROUP BY tenant_id;

-- Show RLS policies on a table
\d+ public.pastoralists
SELECT * FROM pg_policies WHERE schemaname = 'public' AND tablename = 'pastoralists';
```

### 5.4 Query Postgres as `ardalink_app` (proves RLS works)

```bash
PGPASSWORD=ardalink_dev_only psql -h 127.0.0.1 -p 15432 -U ardalink_app -d ardalink
```

Without `SET app.current_tenant_id`, every query returns 0 rows
(RLS denies). To prove tenant scoping:

```sql
SET app.current_tenant_id = 'bula-pesa';
SELECT count(*) FROM ground_truth_reports;   -- returns 12
SET app.current_tenant_id = 'garbatulla';
SELECT count(*) FROM ground_truth_reports;   -- returns 12, different rows
```

### 5.5 Run a single test suite

```bash
# API unit tests
cd ardalink-api && pnpm run test

# Web unit tests (tenant config)
cd ardalink-web && pnpm --filter @workspace/dashboard run test

# Engine unit tests
cd ardalink-engine && uv run pytest -q
```

### 5.6 Tail service logs

```bash
cd ardalink-api/docs/local-dev
make logs
```

Or individually:

```bash
tail -f /tmp/ardalink-local/api.log
tail -f /tmp/ardalink-local/engine.log
tail -f /tmp/ardalink-local/web.log
```

### 5.7 Refresh the WPDx water-point snapshot

Water points shown to herders (USSD selection 2, SMS `MALISHO`, voice
opener) are read from a static snapshot in
`ardalink-api/src/lib/data/wpdxIsiolo.ts`, not fetched at request
time — WPDx changes at survey pace (~annual) and the helpers are on
the Africa's Talking ~10 s budget path.

To refresh (safe to run any time):

```bash
cd ardalink-api
node scripts/pull-wpdx.mjs
```

The script hits `https://data.waterpointdata.org/resource/eqje-vguj.json?clean_adm1=Isiolo`,
prints a `byWard / byStatus / bySource` distribution banner, and
rewrites `src/lib/data/wpdxIsiolo.ts` in place. Diff the file, run
`pnpm test`, commit if the numbers moved.

Reality as of the current snapshot: 10 rows, all Non-Functional per
2012 surveys, no coverage in Bulla Pesa or Wabera — this gap is
exactly what herder ground-truth reports are meant to close.

### 5.8 Add a new tenant + seed data

Edit `ardalink-api/docs/local-dev/seed-data/seed-demo.sql` and
re-run:

```bash
cd ardalink-api/docs/local-dev
make fresh         # tears down + rebuilds from scratch
```

Or surgically:

```bash
PGPASSWORD=ardalink_dev_only psql -h 127.0.0.1 -p 15432 -U ardalink -d ardalink
INSERT INTO public.tenants (tenant_id, display_name, region)
VALUES ('new-ward', 'New Ward', 'Isiolo County');
```

---

## 6. Verifying a release candidate

This is the script the team runs before promoting any branch to
production. It assumes nothing about local state — it starts from
a fresh clone and verifies end-to-end.

```bash
# 1. Set up a clean workspace
mkdir -p /tmp/ardalink-rc && cd /tmp/ardalink-rc
git clone --branch <RELEASE-BRANCH> \
  --depth 1 https://github.com/JHUB-AFRICA/arda-link-ai.git
cd arda-link-ai

# 2. Install
cd ardalink-api && pnpm install --frozen-lockfile && cd ..
cd ardalink-web  && pnpm install --frozen-lockfile && cd ..
cd ardalink-engine && uv sync --extra dev && cd ..

# 3. Up
cd ardalink-api/docs/local-dev
make up

# 4. Verify
make verify
# expected: READY: 22/27 passed (5 expected warnings)

# 5. Smoke (paste from make up output)
TOKEN=$(make token T=bula-pesa)
curl -s -H "Authorization: Bearer $TOKEN" \
  http://localhost:3000/api/ground-truth/recent?limit=5 | jq length
# expected: 5
```

If any step fails, do not promote. Fix the branch and re-run.

---

## 7. Troubleshooting

### Symptom: "Cannot find module 'X'"

```bash
# Inside the affected repo:
rm -rf node_modules
pnpm install --frozen-lockfile
```

If the error persists, the lockfile is out of sync with
`package.json`. That's a build hygiene issue, not a local issue —
fix the lockfile in the repo.

### Symptom: API restarts in a loop, log says "ELIFECYCLE Command failed"

The `tsx watch` is hitting an unhandled error. See the api log:

```bash
tail -50 /tmp/ardalink-local/api.log
```

Common causes:
- DB unreachable: `pg_isready -h 127.0.0.1 -p 15432`
- Schema drift: `cd ardalink-api/docs/local-dev && make fresh`

### Symptom: Port 3000 already in use

```bash
ss -tlnp | grep 3000
# or
lsof -i :3000
```

If it's a previous stack:

```bash
cd ardalink-api/docs/local-dev
make down
make up
```

If it's something else, change `PORT` in `ardalink-api/docs/local-dev/.env`.

### Symptom: "RLS isolation broken: bula-pesa=0, garbatulla=0"

The seed didn't run, or the migrations are stale. Re-run:

```bash
cd ardalink-api/docs/local-dev
make fresh
```

### Symptom: pnpm install hangs forever

This was the bug from 2026-06-21 — pnpm's install of the
ardalink-web workspace was being killed mid-flight by the shell
timeouts, leaving `node_modules/` half-extracted.

Recovery:

```bash
cd ardalink-web
rm -rf node_modules
pnpm install --frozen-lockfile
```

If still hanging, the issue is on a different layer — check
`pnpm-lock.yaml` exists, check `node_modules/.modules.yaml` exists
after the install, and check `node_modules/.pnpm/` isn't a
dangling-symlink graveyard.

### Symptom: 401 on every request

The JWT signing secret in the api's environment doesn't match
what you're using to mint tokens. Check:

```bash
# What the API is using:
cat /tmp/ardalink-local/api.env | grep JWT_SECRET

# What your token is using:
make token T=bula-pesa  # uses .env
```

They must match.

### Symptom: "address already in use" on Postgres

There's a system Postgres on 5432. The local stack runs on 15432.
If you really hit a conflict on 15432:

```bash
docker ps -a | grep postgres
docker stop <container_id>
```

---

## 8. Disaster recovery

### 9.1 The "nothing works, start over" reset

This is destructive — it deletes the demo data.

```bash
cd ardalink-api/docs/local-dev
make down
docker volume rm ardalink-local-pgdata
make up
```

Takes ~90 seconds. After this the stack is back to the demo state.

### 9.2 The "I broke my workspace" reset

If `node_modules/`, `.venv/`, or the lockfile is in a weird state
and reinstall doesn't fix it:

```bash
# ardalink-api
cd ardalink-api
rm -rf node_modules
pnpm install --frozen-lockfile

# ardalink-web
cd ../ardalink-web
rm -rf node_modules
pnpm install --frozen-lockfile

# ardalink-engine
cd ../ardalink-engine
rm -rf .venv
uv sync --extra dev
```

### 9.3 The "my entire machine is on fire" reset

```bash
# 1. Stop everything
cd ardalink-api/docs/local-dev
make down
docker volume rm ardalink-local-pgdata

# 2. Wipe all build artifacts
cd ~/arjolink
rm -rf ardalink-api/node_modules ardalink-web/node_modules ardalink-engine/.venv

# 3. Start over from the One-time Setup section above
```

### 9.4 The "I committed a bug and the verify now fails" recovery

1. `git log --oneline -10` to find the suspect commit.
2. `git revert <commit>` to undo it cleanly.
3. `cd ardalink-api/docs/local-dev && make fresh && make verify`.
4. If `make verify` is green, push the revert.

---

## 9. How to read the source

If you want to understand what a request does, start here:

| You want to know | Start at | Trace |
|---|---|---|
| What does `GET /api/ground-truth/recent` do? | `ardalink-api/src/routes/groundTruth.ts` | `withTenantContext` → `tx.select().from(groundTruthReportsTable)` |
| How does auth work? | `ardalink-api/src/middlewares/tenant.ts` | `verifyJwt` in `ardalink-api/src/lib/tenancy.ts` |
| How is RLS enforced? | `ardalink-api/src/lib/tenancy-context.ts` | `safeTenantId` → `SET LOCAL` → RLS policy in `ardalink-api/docs/local-dev/migrations/0001_multitenant_public.up.sql` |
| Where does the dashboard get data? | `ardalink-web/packages/api-client-react/src/index.ts` | `useGetStatus` etc. → `fetch` to `/api/*` |
| Where does the engine compute? | `ardalink-engine/ardalink_engine/src/` | pure-Python modules; FastAPI wrapper in `ardalink_engine/main.py` |
| How is the demo data loaded? | `ardalink-api/docs/local-dev/seed-data/seed-demo.sql` | applied by `start-local.sh` after migrations |
| What does `make verify` actually check? | `ardalink-api/docs/local-dev/scripts/verify.sh` | line by line, with section headers |
| Where does the LLM registry live? | `ardalink-api/src/lib/llm/registry.ts` | `pickProvider` → `providers/{azure,zai,minimax,mock}.ts` |
| How does the Azure GPT-5 provider handle `max_completion_tokens`, `reasoning_effort`, `temperature`? | `ardalink-api/src/lib/llm/providers/azure.ts` | `isGpt5` deployment-name check → body-shape rewrites |
| Where does the speech (STT/TTS) bridge live? | `ardalink-api/src/lib/speech.ts` | `routes/speech.ts` → Azure Speech REST (STT + TTS + STS token) |
| Which voice mode does a call use? | `ardalink-api/src/routes/voice.ts::resolveCallMode` | `CALL_PIPELINE_MODE` env (default `deterministic`) or per-request `?mode=` query |
| How does the **deterministic** herder pipeline work? | `ardalink-api/src/routes/voice.ts` (dual-mode webhook) → `src/lib/voiceDeterministicPipeline.ts` | AT `<Say>`/`<GetDigits>`/`<Record>` XML stages → download recording → `fastTranscribe` → `extractIndicators` → `withTenantContext` + `insert(groundTruthReportsTable)` → `touchPastoralistLastContact` |
| Which sim does the demo hub link to? | `ardalink-api/src/routes/demo/index.ts` | Only deterministic sims (voice / USSD / SMS). Realtime demo is kept at `/simulator-realtime` for Phase 3 but is not linked. |
| How is a herder identified + personalized? | `ardalink-api/src/lib/herderContext.ts::resolveHerderContext` | Since 2026-07-08 **Supabase-first**: canonicalize phone → try `api_call_context` view or `pastoralists` on Supabase → overlay ward intelligence from `api_latest_satellite_indices` + `api_latest_weather_data` → enrich from local mirror (species breakdown, extraction detail) → fall back to local-only if Supabase unreachable → return `HerderContext { source, wardId, wardNdviMean, wardVci, ... }` used by voice / USSD / SMS sims |
| Where does the Supabase client live? | `ardalink-api/src/lib/supabase.ts` | PostgREST over `SUPABASE_URL` + `SUPABASE_SECRET_KEY`; helpers `listWards` / `latestSatelliteFor` / `latestWeatherFor` / `callContextByPhone` / `pastoralistByPhone` / `upsertPastoralist` / `insertGroundTruthCall`; 60 s cache for reference reads (`SUPABASE_CACHE_TTL_MS`); null-on-failure so callers can fall back to local |
| How is a tenant slug mapped to a Supabase ward_id? | `ardalink-api/src/lib/wardMapping.ts` | Static map: `bula-pesa → 242`. `garbatulla` and `merti` default to `242` until confirmed with the Supabase project owner. |
| How does the dual-write to Supabase work? | `ardalink-api/src/lib/voiceDeterministicPipeline.ts::writeSupabaseMirror` (also called from `src/routes/talk.ts`) | After the local rich `ground_truth_reports` insert, upsert the pastoralist (uuid PK) if missing, then insert a thin `ground_truth_calls` row on Supabase. `mortality_rate` + `offtake_rate` bucket-to-proportion in `[0,1]`, `trust_score` divided by 100. Fire-and-forget: Supabase failure never rolls back the local write. |
| How does the **realtime** browser demo work (Phase-3 preview)? | `ardalink-api/src/routes/demo/voice.ts` (`/simulator-realtime`) | `POST /api/demo/voice/token` → WS `/api/browser-voice-stream` → `handleBrowserVoiceStream` in `voiceStreamBrowser.ts` → Azure OpenAI Realtime |
| Where is ground truth extracted from a call? | Deterministic: `voiceDeterministicPipeline.ts::processDeterministicVoiceRecording`. Realtime: `voiceStreamBrowser.ts::endBrowserCall` and `voiceStream.ts::endCall` for AT. | `extractIndicators(transcript)` → RLS-scoped `insert(groundTruthReportsTable)` with BCS / mortality / water / trust score |
| Why does the demo `record-and-send` page use the same pipeline as real calls? | `ardalink-api/src/routes/demo/voice.ts::/record` | Directly calls `fastTranscribe` + `extractIndicators` — identical code path minus the AT XML stages |

---

---

## Related docs

- [`README.md`](./README.md) — high-level project overview, service table, deep-dive guide index
- [`STATUS.md`](./STATUS.md) — strategic view, vendor matrix, phase-by-phase roadmap
- [`Arda-link-AI-Docs/architecture.md`](./Arda-link-AI-Docs/architecture.md) — C4-style component diagrams
- [`LOCAL_SETUP.md`](./LOCAL_SETUP.md) — 5-minute install on a fresh machine
- [`Arda-link-AI-Docs/deployment.md`](./Arda-link-AI-Docs/deployment.md) — production hosting options
- [`Arda-link-AI-Docs/security.md`](./Arda-link-AI-Docs/security.md) — auth, rate limiting, RLS threat model

*See `Arda-link-AI-Docs/architecture.md` for the diagrams. See `LOCAL_SETUP.md`
for the 5-minute install.*
