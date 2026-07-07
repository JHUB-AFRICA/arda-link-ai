# ArdaLink — Local Setup (5-minute install)

The shortest path from a clean machine to a working local stack.
For the high-level project overview, see [`README.md`](./README.md).
For the full manual, see `RUNBOOK.md`. For diagrams, see
[`Arda-link-AI-Docs/architecture.md`](./Arda-link-AI-Docs/architecture.md).

---

## Prerequisites

| Tool | Min | Check |
|---|---|---|
| Node.js | 24.x | `node -v` |
| pnpm | 9.x | `pnpm -v` |
| Python | 3.12 | `python3 --version` |
| uv | latest | `uv --version` |
| Docker | 24+ | `docker version` |
| psql, curl, jq | any | `psql --version && curl --version && jq --version` |
| Git | 2.30+ | `git --version` |

---

## 1. Clone the repo

```bash
git clone https://github.com/JHUB-AFRICA/arda-link-ai.git
cd arda-link-ai
```

The three services (`ardalink-engine/`, `ardalink-api/`, `ardalink-web/`)
ship as siblings in this single public monorepo.

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

### Azure AI Foundry + Azure Speech (optional but recommended)

The stack now defaults to Azure AI Foundry (`gpt-5-mini`) as the
primary LLM and Azure Speech for STT/TTS. The voice pipeline defaults
to **deterministic mode** (`CALL_PIPELINE_MODE=deterministic`) — real
herder phone calls use a value-first opener + DTMF menu + 20 s
`<Record>` + server-side Azure Speech + GPT-5 Mini extract. Realtime
mode (Azure OpenAI Realtime WS) stays wired for browser demos and as
the Phase-3 upgrade path but does not affect the herder default.

To wire the credentials, add the following to `docs/local-dev/.env`
before `make up`:

```env
# Azure AI Foundry (chat completions — the deterministic voice pipeline
# uses gpt-5-mini; realtime voice needs a separate deployment)
AZURE_OPENAI_FOUNDRY_ENDPOINT=https://<resource>.services.ai.azure.com/api/projects/<project>
AZURE_OPENAI_ENDPOINT=https://<resource>.services.ai.azure.com/
AZURE_OPENAI_API_KEY=<foundry-api-key>
AZURE_OPENAI_CHAT_DEPLOYMENT=gpt-5-mini
AZURE_OPENAI_CHAT_API_VERSION=2024-10-21
# Realtime voice deployment — only used when CALL_PIPELINE_MODE=realtime
# or /api/demo/voice/simulator is opened. Optional for herder calls
# (they use the deterministic pipeline). GPT-5 does not support Realtime;
# use gpt-4o-realtime-preview.
AZURE_OPENAI_REALTIME_DEPLOYMENT=gpt-4o-realtime-preview
AZURE_OPENAI_REALTIME_API_VERSION=2025-04-01-preview
LLM_PRIMARY_PROVIDER=azure
LLM_FALLBACK_PROVIDER=z

# Voice call flow (see ardalink-api/docs/llm-integration.md §5)
CALL_PIPELINE_MODE=deterministic   # deterministic | realtime
DETERMINISTIC_TENANT_ID=bula-pesa   # tenant used for RLS on demo/sandbox rows

# Azure Speech (STT / TTS / browser SDK token)
AZURE_SPEECH_KEY=<speech-key>
AZURE_SPEECH_REGION=southafricanorth
AZURE_SPEECH_ENDPOINT=https://southafricanorth.api.cognitive.microsoft.com/
AZURE_SPEECH_TTS_VOICE_SW=sw-KE-ZuriNeural
AZURE_SPEECH_TTS_VOICE_EN=en-KE-AsiliaNeural
AZURE_SPEECH_STT_LANGUAGES=sw-KE,en-KE
```

**Prerequisites in Azure Portal:**
1. AI Foundry project with a `gpt-5-mini` chat deployment.
2. A separate `gpt-4o-realtime-preview` deployment on the same
   resource — GPT-5 does **not** support the Realtime API.
3. A Cognitive Services Speech resource in `southafricanorth`
   (or any region — update `AZURE_SPEECH_REGION` accordingly).

Without these, `AzureOpenAIClient` falls back to a `MockClient` tagged
`azure` and the speech routes return `503 speech-not-configured` — the
rest of the stack still works, but you won't have real LLM output.

**Verify** after `make up`:
```bash
curl -s http://localhost:3000/api/speech/status
# {"configured":true,"region":"southafricanorth","voiceSw":"sw-KE-ZuriNeural",...}

TOK=$(make -s token T=bula-pesa)
curl -s -H "Authorization: Bearer $TOK" \
  http://localhost:3000/api/intelligence/brief?lang=sw | jq '.provider,.model,.latency_ms'
# "azure"
# "gpt-5-mini"
# 6404
```

### Supabase (source of truth for reference data; recommended)

Since 2026-07-08, Supabase is the **source of truth** for wards,
`satellite_indices`, `weather_data`, `pastoralists`, and the thin
`ground_truth_calls` audit trail. Local Postgres becomes a **backup
mirror** holding the rich `ground_truth_reports` schema + species
breakdown + `admin_users` / `tenants` / `gis_engine.*`. The stack
runs fine without Supabase env vars set — every helper short-circuits
to `null` and `resolveHerderContext` tags `source: "local"` — but
herder personalization (NDVI / VCI / rainfall / temperature per ward)
uses local seed data instead of the live Supabase reference set.

Add to `docs/local-dev/.env` before `make up`:

```env
# Supabase — reference data primary + ground_truth_calls mirror
SUPABASE_URL=https://<ref>.supabase.co
SUPABASE_SECRET_KEY=sb_secret_...        # service-role / secret key, server-side only
SUPABASE_ANON_KEY=                        # optional; reserved for future client-side reads
SUPABASE_CACHE_TTL_MS=60000               # 60 s cache for reference-table reads
```

**Sanity check** (should return one ward row):

```bash
curl -s "$SUPABASE_URL/rest/v1/wards?limit=1" \
  -H "apikey: $SUPABASE_SECRET_KEY" \
  -H "Authorization: Bearer $SUPABASE_SECRET_KEY" | jq .
```

**Inspect the schema** (dumps tables, columns, row counts to
`/tmp/supabase-report.json`):

```bash
cd ardalink-api
python3 scripts/explore-supabase.py
```

Two views return HTTP 500 today and are skipped by the client
(`api_latest_cell_satellite_indices`, `api_ward_cell_latest_rollup`).
Flagged to the project owner; not blocking.

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
  Dashboard        http://localhost:8080/
  Talk             http://localhost:8080/talk/
  Demo hub         http://localhost:3000/api/demo/
  Voice sim        http://localhost:3000/api/demo/voice/simulator          (deterministic — phone lookup → opener → record → ground truth)
  USSD sim         http://localhost:3000/api/demo/ussd/simulator           (deterministic — fixed menus, personalized brief)
  SMS sim          http://localhost:3000/api/demo/sms/simulator            (deterministic — keyword responses, personalized)
  Realtime preview http://localhost:3000/api/demo/voice/simulator-realtime (Phase-3, needs gpt-4o-realtime-preview)
  API              http://localhost:3000/api/healthz
  Engine           http://localhost:5001/health
  Postgres         127.0.0.1:15432 (user ardalink / ardalink_app)
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

## Related docs

- [`README.md`](./README.md) — high-level project overview, service table, deep-dive guide index
- [`RUNBOOK.md`](./RUNBOOK.md) — full operator manual (daily workflow, troubleshooting, disaster recovery, how to read the source)
- [`STATUS.md`](./STATUS.md) — strategic view, vendor matrix, roadmap
- [`Arda-link-AI-Docs/architecture.md`](./Arda-link-AI-Docs/architecture.md) — C4-style component diagrams
- [`Arda-link-AI-Docs/onboarding.md`](./Arda-link-AI-Docs/onboarding.md) — full new-developer bring-up (30–60 min)
- [`Arda-link-AI-Docs/deployment.md`](./Arda-link-AI-Docs/deployment.md) — local Docker Compose + production hosting options
- [`Arda-link-AI-Docs/satellite.md`](./Arda-link-AI-Docs/satellite.md) — Google Earth Engine account setup (needed for live vegetation)

---

*Maintained by the Lead Software Engineer. Last update: 2026-06-22.*
