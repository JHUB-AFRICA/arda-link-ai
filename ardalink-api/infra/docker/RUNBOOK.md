# ArdaLink — Docker Stack Runbook (WhatsApp: Meta + Evolution modes)

Step-by-step operator manual for the **containerized** stack in this
directory (`infra/docker/`) — bringing every service up, running the
WhatsApp channel in either provider mode, watching the right dashboards
and logs while it's live, and shutting down without losing state.

> This is a different stack from the root [`RUNBOOK.md`](../../../RUNBOOK.md),
> which covers the script-based `ardalink-api/docs/local-dev/` workflow
> (no Docker, `make setup`/`make token`/`make verify`). Use *this*
> runbook when you're working with `docker compose` here in
> `infra/docker/` — which is the only place the WhatsApp channel's two
> provider modes actually run. For the "why" behind the two modes, see
> [`whatsapp-first-architecture.md`](../../../Arda-link-AI-Docs/whatsapp-first-architecture.md).

---

## Contents

1. [Prerequisites](#1-prerequisites)
2. [Environment setup](#2-environment-setup)
3. [Bringing up the core stack](#3-bringing-up-the-core-stack)
4. [Running in Meta mode (360dialog)](#4-running-in-meta-mode-360dialog)
5. [Running in Evolution mode (self-hosted)](#5-running-in-evolution-mode-self-hosted)
6. [Switching modes on a live stack](#6-switching-modes-on-a-live-stack)
7. [Dashboards and where to look](#7-dashboards-and-where-to-look)
8. [Observing the system end-to-end](#8-observing-the-system-end-to-end)
9. [Stopping gracefully](#9-stopping-gracefully)
10. [Troubleshooting](#10-troubleshooting)

---

## 1. Prerequisites

| Tool | Why | Check |
|---|---|---|
| Docker + Docker Compose v2 | Runs every service | `docker compose version` |
| curl, jq | Manual API/webhook testing | `curl --version && jq --version` |
| ngrok (or any TLS tunnel) | Only needed to expose a webhook to a real Meta/360dialog account or a real Evolution WhatsApp session for a true end-to-end test | `ngrok version` |
| A phone with WhatsApp | To actually send/receive messages in either mode | — |

## 2. Environment setup

```bash
cd ardalink-api/infra/docker
cp .env.example .env
```

Fill in at minimum: `JWT_SECRET`, `TENANT_ATTESTATION_SECRET`,
`SESSION_SECRET` (32+ random bytes each), and whichever of
`AZURE_OPENAI_*` / `AFRICASTALKING_*` / `GEE_*` you need for the parts
of the system you're actually testing — none of them are required just
to boot the stack.

**WhatsApp-specific variables** (all in `.env.example` already):

| Var | Default | Used by |
|---|---|---|
| `WA_PROVIDER` | `360dialog` | `whatsappProviderRegistry.ts` — read fresh on every call, so flipping it only needs an `api` restart, not a rebuild |
| `THREESIXTYDIALOG_API_KEY`, `THREESIXTYDIALOG_PHONE_NUMBER_ID` | empty | Meta mode only |
| `EVOLUTION_API_KEY` | `dev_only_change_me` | Evolution mode — also the API key the `evolution-api` container itself authenticates with |
| `EVOLUTION_INSTANCE_NAME` | `ardalink-dev` | Evolution mode — the instance name used in every Evolution API call |
| `EVOLUTION_POSTGRES_PASSWORD` | `evolution_dev_only` | Evolution's own Postgres (schema-isolated from ArdaLink's DB) |

Both provider's env vars can sit filled-in in `.env` at the same time —
only whichever `WA_PROVIDER` points at is actually reached for outbound
sends; the other is a harmless no-op.

## 3. Bringing up the core stack

```bash
cd ardalink-api/infra/docker
make up          # = docker compose up -d --build
```

This starts, in dependency order: `postgres` → `redis` → `engine` →
`api` → `web`. `api` waits on `postgres` (healthy) and `redis`
(healthy) and `engine` (started) per the compose `depends_on` block.

| Service | URL | Notes |
|---|---|---|
| Operator dashboard | http://localhost:8080 | ardalink-web, nginx |
| Public Talk | http://localhost:8080/talk | |
| API | http://localhost:3000/api/healthz | liveness + data-freshness |
| Engine | http://localhost:5001/health | |
| Postgres | `localhost:5432` (`ardalink`/`ardalink`) | |
| Redis | `localhost:6379` | |

Confirm everything is actually up before moving on:

```bash
make ps
curl -s http://localhost:3000/api/healthz | jq .
curl -s http://localhost:5001/health
```

At this point `WA_PROVIDER` (whatever `.env` set it to) is already
live in the `api` container — the two sections below just cover
getting a *real* WhatsApp account talking to it.

## 4. Running in Meta mode (360dialog)

This is the default (`WA_PROVIDER=360dialog`), and the code-complete,
**not-yet-production-live** path — see the known-limitation note in
[`whatsapp-first-architecture.md`](../../../Arda-link-AI-Docs/whatsapp-first-architecture.md#known-limitation-meta-business-api-verification).
Meta Business verification for the 360dialog account is what's
pending; everything below still works for testing against a
sandbox/dev 360dialog account once you have one.

1. Set `THREESIXTYDIALOG_API_KEY` and `THREESIXTYDIALOG_PHONE_NUMBER_ID`
   in `.env` from your 360dialog dashboard.
2. Restart just the API to pick up the new env:
   ```bash
   docker compose up -d --build api
   ```
3. **Expose the webhook publicly** — 360dialog needs a real HTTPS URL
   to call. The dashboard/talk static bundles are not needed for this;
   tunnel directly at the API container's published port:
   ```bash
   ngrok http 3000
   ```
   (nginx's `web` container does **not** proxy `/api/*` — don't point
   the tunnel at `:8080` for this, it'll 404.)
4. In the 360dialog dashboard, set the webhook URL to
   `https://<ngrok-subdomain>.ngrok-free.app/api/whatsapp-webhook`.
5. Send a WhatsApp message to the 360dialog-provisioned number from
   your phone. Watch it arrive:
   ```bash
   docker compose logs -f api | grep -i whatsapp
   ```

## 5. Running in Evolution mode (self-hosted)

Bring the optional Evolution containers up alongside the core stack:

```bash
docker compose --profile evolution up -d --build
```

This starts `evolution-postgres` + `evolution-api` (image
`evoapicloud/evolution-api:v2.3.7`), exposed on `localhost:8081`.

There are **two integration modes** Evolution itself supports. Only one
of them has actually been live-tested end-to-end in this repo:

### 5a. Baileys / QR-linking mode — confirmed working, no Meta account needed

This is what was used to verify the entire WhatsApp conversation
pipeline end-to-end this session, against a real personal WhatsApp
account, with zero Meta credentials.

1. Open the Evolution manager UI: **http://localhost:8081/manager**
   (log in with your `EVOLUTION_API_KEY`).
2. Create an instance named `ardalink-dev` (matching
   `EVOLUTION_INSTANCE_NAME`) with integration type **Baileys** (not
   "WHATSAPP-BUSINESS").
3. The manager UI shows a live-refreshing QR code — **use the manager
   UI for this, not a one-off screenshot/curl of the QR endpoint**.
   Baileys rotates the QR roughly every 45 seconds, so a static
   snapshot goes stale before you can scan it; the manager UI polls
   for the current one automatically.
4. Scan it from your phone: WhatsApp → Linked Devices → Link a Device.
   Once linked, the manager shows the instance state as `open`.
5. In `.env`, set:
   ```
   WA_PROVIDER=evolution
   ```
   and restart just the API:
   ```bash
   docker compose up -d --build api
   ```
6. Set the instance's webhook (one-time, via the manager UI or curl) to
   `http://host.docker.internal:3000/api/evolution-whatsapp-webhook`,
   events `MESSAGES_UPSERT` + `MESSAGES_UPDATE`.
7. Message the linked phone number from another real WhatsApp account.
   Watch it arrive:
   ```bash
   docker compose logs -f api | grep -i whatsapp
   docker compose logs -f evolution-api
   ```

**Known gaps in this mode** (confirmed by live testing, not theoretical):
list-type interactive messages crash Evolution's send path on this
stack (`whatsappTurn.ts`'s welcome menu deliberately uses buttons
instead — see its docstring); non-text inbound shapes (location,
audio, list/button replies) are implemented but unverified against a
live instance; there's no `outside_session_window` detection, so every
non-2xx send error currently maps to a generic error rather than a
specific "24h window closed" signal.

### 5b. Cloud-API-backed mode — documented, not live-tested this session

Evolution can also front Meta's own Cloud API (needs a real Meta WABA
phone number ID + permanent access token + business ID) rather than
acting as a Baileys/WhatsApp-Web client. See the manual smoke-test
recipe in [`README.md`](./README.md#whatsapp-providers) (`POST
/instance/create` with `"integration": "WHATSAPP-BUSINESS"`). This
mode still needs the same Meta Business verification 360dialog is
waiting on, so it doesn't currently unblock anything Meta-side that
360dialog doesn't already unblock — 5a is the mode actually worth using
today for end-to-end testing without Meta.

## 6. Switching modes on a live stack

```bash
# In .env:
WA_PROVIDER=evolution   # or 360dialog

# Then:
docker compose up -d --build api
```

Only `api` needs restarting — `whatsappProviderRegistry.ts` reads
`WA_PROVIDER` fresh per call, so no other service is affected, and
neither provider's containers/credentials need to change.

## 7. Dashboards and where to look

| What | Where | Shows |
|---|---|---|
| Operator dashboard | http://localhost:8080 | Ground Truth Intelligence tab → **CallbackLog** panel now includes WhatsApp turns (channel `"whatsapp"` in `lead_interactions`, alongside ussd/sms/voice) since this session's operator-logging fix |
| Evolution manager | http://localhost:8081/manager | Instance connection state, live QR (linking mode), send/receive activity, webhook config |
| `/api/healthz` | http://localhost:3000/api/healthz | Process liveness (`status`) + `pipeline` — per-table data freshness from the 15-minute heartbeat job (`satellite_indices`, `weather_data`, `ground_truth_calls`, `pastoralists`, etc.) |
| `GET /api/ops/leads` | (Bearer-gated) | Registered leads/pastoralists |
| `GET /api/ops/interactions` | (Bearer-gated) | Raw `lead_interactions` feed — filterable by `channel=whatsapp` |
| `POST /api/ops/whatsapp/alerts/dispatch` | (Bearer-gated) | Manual drought-alert dispatch to opted-in WhatsApp-tier pastoralists (`whatsappAlerts.ts`) — the one ops action that proactively *sends*, everything else here is passive observation |

## 8. Observing the system end-to-end

A combined checklist for watching a WhatsApp conversation actually
flow through the whole pipeline, not just "is the container up":

```bash
# 1. Tail everything at once (prefix shows which service).
#    Drop `evolution-api` from the list if you're in Meta/360dialog
#    mode and that profile isn't running.
docker compose logs -f --tail=100 api engine evolution-api

# 2. In a second terminal, poll health every few seconds
watch -n 5 'curl -s http://localhost:3000/api/healthz | jq .pipeline'

# 3. Send a message from your phone, then watch for, in order:
#    - api log: "request completed" for POST /api/evolution-whatsapp-webhook
#      (or /api/whatsapp-webhook in Meta mode)
#    - api log: "[WhatsApp] Free-text turn processed" (llm + indicator
#      extraction ran) — or the welcome/menu/opt-out branch if it's a
#      keyword
#    - api log: "[Evolution] message dispatched" / equivalent 360dialog
#      send log — the reply actually went out
#    - Evolution manager UI or your phone: the reply arrives
```

The background jobs (`satelliteJob`, `forecastJob`, `vciBackfillJob`,
`syncJob`, `heartbeatJob`) all log their own start/finish lines on
their own schedules — `docker compose logs -f api | grep -E
"SatelliteJob|ForecastJob|VciBackfill|SyncJob|Heartbeat"` isolates
just those if you want to confirm the scheduler loop itself is alive
without the WhatsApp noise.

## 9. Stopping gracefully

```bash
docker compose stop        # stops containers, keeps them + all volumes
# or
docker compose down        # removes containers, KEEPS named volumes
```

Either is safe for a normal end-of-session stop. **Named volumes
persist across both** (`pgdata`, `redisdata`, `evolution_pgdata`,
`caddy_data`, `caddy_config`) — critically, this means **your Evolution
Baileys link survives a restart**. Bringing the stack back up with
`make up` reconnects to the same linked WhatsApp session without
re-scanning a QR code, as long as you didn't remove the volume.

```bash
# Only if you actually want to wipe everything (fresh DB + re-link
# Evolution from scratch):
docker compose down -v     # or: make reset
```

To stop just the Evolution side while leaving the core stack up:

```bash
docker compose --profile evolution stop evolution-api evolution-postgres
```

## 10. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Evolution QR always says "couldn't link, try again" | Baileys rotates the QR ~every 45s; a static/screenshotted QR is stale by the time you scan it | Scan straight from the manager UI (http://localhost:8081/manager), not a saved image |
| Welcome menu never arrives / Evolution send throws `this.isZero is not a function` | List-type interactive messages crash on this Evolution/Baileys stack | Already fixed — the welcome menu uses buttons (`sendWhatsappInteractiveButtons`), not lists. If you see this again, check nothing regressed back to `sendWhatsappInteractiveList` |
| Bot re-sends the welcome menu on every message from an already-known number | `hasPriorWhatsappMessages()` defaulting to "not seen" when Supabase is unreachable | Confirm `DATABASE_URL` is reachable from `api`; the local-mirror fallback should catch this — check `docker compose logs api \| grep hasPriorWhatsappMessages` for the specific warning |
| `POST /api/whatsapp-webhook` or `/api/evolution-whatsapp-webhook` returns 404 through your tunnel | Tunnel is pointed at `:8080` (nginx, static-only) instead of `:3000` (api) | Repoint the tunnel/Caddy at `api:3000` |
| Port 3000 (or 8081, 5001, 8080) already in use | Another process — possibly a non-Docker instance of the same service from a previous manual test — is bound to it | `ss -tlnp \| grep <port>`, stop the conflicting process, or change the published port in `compose.yml` |
| `evolution-api` won't start / restarts in a loop | `evolution-postgres` not healthy yet, or `EVOLUTION_API_KEY` missing | `docker compose logs evolution-postgres`; confirm `.env` has `EVOLUTION_API_KEY` set (default `dev_only_change_me` works for local testing) |

---

## Related docs

- [`README.md`](./README.md) — quick-start + the original WhatsApp providers smoke-test recipe
- [`whatsapp-first-architecture.md`](../../../Arda-link-AI-Docs/whatsapp-first-architecture.md) — as-built status, sequence diagrams, the Meta API verification blocker
- [`../../../RUNBOOK.md`](../../../RUNBOOK.md) — the *other* (non-Docker, script-based) local dev runbook
- [`../../docs/07-RUNBOOKS.md`](../../docs/07-RUNBOOKS.md) — incident response / backup / DR runbook
