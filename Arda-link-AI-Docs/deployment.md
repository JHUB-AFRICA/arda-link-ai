# ArdaLink AI — Deployment

> This document is the strategic view: what's actually running today, and
> the concrete scenarios for what comes next. For the step-by-step
> mechanics of the containerized stack (bringing services up, switching
> WhatsApp providers, health-check commands), see
> [`ardalink-api/infra/docker/RUNBOOK.md`](../ardalink-api/infra/docker/RUNBOOK.md)
> — that document is current and does not need duplicating here.

**Rewritten 2026-08-04** — the previous version of this document described
a generic Docker Compose stack (6 services, no WhatsApp channel, no
Supabase) and a hypothetical DigitalOcean/Hetzner/AWS/Azure comparison
that was never acted on. Neither reflected what actually exists. This
version is grounded in the real, currently-running architecture and the
real options actually available for what comes next.

---

## Table of Contents

1. [Current State — What's Actually Running Today](#current-state--whats-actually-running-today)
2. [Scenario 1 — Local Dev / Active WhatsApp Testing (current)](#scenario-1--local-dev--active-whatsapp-testing-current)
3. [Scenario 2 — VPS Self-Hosted (half done — Evolution live, API still on laptop)](#scenario-2--vps-self-hosted-half-done--evolution-live-api-still-on-laptop)
4. [Scenario 3 — Meta Cloud API / 360dialog Production Channel](#scenario-3--meta-cloud-api--360dialog-production-channel)
5. [Scenario 4 — Cloud-Hosted Scale-Out](#scenario-4--cloud-hosted-scale-out)
6. [Environment Variables](#environment-variables)
7. [Security Checklist Per Scenario](#security-checklist-per-scenario)
8. [Health Checks & Monitoring](#health-checks--monitoring)

---

## Current State — What's Actually Running Today

**Corrected 2026-08-05** — the diagram and Scenario 2 below previously
said the VPS-hosted Evolution instance was "staged, not cut over," with
a local Docker `evolution-api` container standing in as the real bridge.
That was wrong (either already stale when written, or overtaken within a
day): verified directly against the VPS that `ardalink-evolution-api`
has been running there for 2 days, webhooking real messages back to
`ardalink-api` on this laptop over the existing tunnel. The local
`evolution-api` Docker container was a leftover, unrelated to real
traffic, and has been stopped.

```mermaid
flowchart TB
    subgraph Laptop ["Dev laptop (munen-Latitude-7420)"]
        API["ardalink-api\nsystemd: ardalink-api.service\n:3001"]
        LocalPG["ardalink-local-postgres\n:15432 (local mirror)"]
        Tunnel["ardalink-tunnel.service\nautossh -R 127.0.0.1:9091:127.0.0.1:3001"]
    end

    subgraph VPS ["baitech VPS (69.164.244.165)"]
        Nginx1["nginx: ardalink.ementech.co.ke\n-> 127.0.0.1:9091"]
        Nginx2["nginx: wa.ardalink.ementech.co.ke\n-> 127.0.0.1:8082"]
        Evo["ardalink-evolution-api (Docker)\nv2.3.7, isolated from Ementech's\nown evolution-api on :8080\n:8082 (127.0.0.1 only)"]
        EvoPG["ardalink-evolution-postgres (Docker)"]
    end

    subgraph Cloud ["Real production data + AI (cloud)"]
        Supabase["Supabase\n(source of truth: wards, pastoralists,\nground_truth_calls, whatsapp_messages*)"]
        ZAI["z.ai (glm-4.5-flash)\nprimary LLM"]
        Minimax["MiniMax\nfallback LLM"]
        Azure["Azure OpenAI + Speech\nvoice/TTS/STT"]
        GEE["Google Earth Engine"]
    end

    WhatsAppUser["Real WhatsApp testers"] -->|messages| Evo
    Evo --> EvoPG
    Evo -->|webhook: https://ardalink.ementech.co.ke/api/evolution-whatsapp-webhook| Nginx1
    Nginx1 -.->|forwards over the tunnel| Tunnel
    Tunnel <-->|reverse SSH tunnel| API
    Nginx2 -.->|manager UI, basic-auth gated| Evo
    API --> LocalPG
    API --> Supabase
    API --> ZAI
    API --> Minimax
    API --> Azure
    API -->|proxied via ardalink-engine| GEE
```

*`whatsapp_messages` exists on the local mirror but not yet on the real
Supabase project — see `STATUS.md`'s tracked blockers.*

**What this actually means:**
- The WhatsApp bridge (Evolution/Baileys) already runs **on the VPS**,
  not the laptop — `ardalink-evolution-api`, isolated (own Postgres, own
  API key, own port `8082`) from a separate, unrelated `evolution-api`
  instance also on that box (a different company's live customer CRM —
  same VPS, nothing to do with ArdaLink).
- `ardalink-api` still runs as a systemd service **on this laptop** —
  `ardalink-api.service`, auto-restarts on crash, survives laptop
  reboots — reached via the same permanent reverse SSH tunnel
  (`ardalink-tunnel.service`, `autossh`) as before. This is genuinely a
  **hybrid** state: the WhatsApp bridge has already moved to the VPS: half
  of Scenario 2, not yet all of it (see below).
- The VPS's `ardalink.ementech.co.ke` nginx vhost only proxies to the
  tunnel — it runs no ArdaLink application code itself
  (`/opt/baitech-infra/nginx/ardalink.ementech.co.ke.conf`).
  **If the laptop is off, asleep, or off the network, Evolution keeps
  receiving messages but `ardalink-api` can't process or reply to any of
  them** — the WhatsApp bridge surviving on the VPS no longer means the
  *channel* survives a laptop outage, only that the bridge/session
  itself does. Finishing Scenario 2 (moving `ardalink-api` + engine to
  the VPS too) is what actually removes the laptop dependency.
- Supabase is the **real production data store** — not a generic
  "managed Postgres," a specific already-provisioned Supabase project.
  The local Postgres (`ardalink-local-postgres`) is a resilient
  read-fallback mirror, not the source of truth.
- Redis is running locally but **entirely unused by the application** —
  see `security.md`'s Rate Limiting correction. It was provisioned for a
  rate-limiting design that was never implemented.

---

## Scenario 1 — Local Dev / Active WhatsApp Testing (current)

**When to use:** exactly what it's for today — active development and
real-tester feedback loops where you want to redeploy in seconds (edit,
rebuild, `systemctl --user restart ardalink-api.service`) without any
remote deploy step.

**Setup:** see `ardalink-api/infra/docker/RUNBOOK.md` for the
containerized core stack (`ardalink-api`/`ardalink-engine`/local
Postgres) — Evolution itself now runs on the VPS, not locally, so its
bring-up is `/opt/baitech-infra/ardalink-evolution/` on the VPS side
(see Scenario 2). The tunnel/systemd layer on the laptop (not covered in
that runbook, since it's laptop-specific, not part of the containerized
stack) is two systemd user units:
- `~/.config/systemd/user/ardalink-api.service` — runs `dist/index.mjs`,
  restarts on crash.
- `~/.config/systemd/user/ardalink-tunnel.service` — `autossh` reverse
  tunnel, `-R 127.0.0.1:9091:127.0.0.1:3001`, connecting as the
  `ardalink-tunnel` VPS user with a dedicated SSH key
  (`~/.ssh/ardalink_tunnel_key`).

**Known limitations (do not treat as production):**
- Single point of failure is a **personal laptop** — no uptime guarantee.
- The entire project directory lives on an NTFS drive mounted with
  `uid=0,gid=0,allow_other` — every file including every secret is
  effectively world-readable/writable at the OS level (see
  `security.md`'s Secrets Management section). Acceptable for a
  single-developer machine; must not be assumed for any scenario below.
- No rate limiting, open CORS (see `security.md`) — fine when only a
  small group of known testers has the number, not fine at any real scale.

---

## Scenario 2 — VPS Self-Hosted (half done — Evolution live, API still on laptop)

**When to use:** the natural next step once local-laptop testing is
validated and you want the WhatsApp channel to survive laptop reboots,
sleep, and network changes — i.e. an actual pilot, not just testing.

**Current status, verified live 2026-08-05:** the Evolution half of this
is done. On the baitech VPS, `/opt/baitech-infra/ardalink-evolution/`
runs `ardalink-evolution-api` (port `8082`, 127.0.0.1-only) +
`ardalink-evolution-postgres`, isolated (own DB, own API key, own port)
from a separate, unrelated Evolution instance on the same box (a
different company's live customer CRM). Its webhook posts to
`https://ardalink.ementech.co.ke/api/evolution-whatsapp-webhook`, which
still forwards over the reverse SSH tunnel to `ardalink-api` on the
laptop — so **the bridge no longer depends on the laptop, but the actual
message-processing/reply logic still does.** `wa.ardalink.ementech.co.ke`
nginx vhost fronts the manager UI (`/manager`, gated behind a dedicated
basic-auth file, `.htpasswd_ardalink_evolution` — deliberately separate
credentials from the other instance's).

**To finish the cutover:**
1. ~~Bring up `ardalink-evolution`'s compose stack on the VPS, QR-link a
   WhatsApp number~~ — **done**, live 2 days as of 2026-08-05.
2. Deploy `ardalink-api` + `ardalink-engine` on the VPS itself, using
   `ardalink-api/infra/docker/compose.yml` (the same stack documented in
   `infra/docker/RUNBOOK.md`) — this replaces the tunnel entirely; the
   VPS's own nginx proxies directly to the co-located containers instead
   of forwarding over SSH to a laptop.
3. Retire `ardalink-tunnel.service` and `ardalink-api.service` on the
   laptop once the VPS path is confirmed working end-to-end (don't
   retire before confirming — the laptop path is the fallback during
   cutover).
4. Point `wa.ardalink.ementech.co.ke`'s nginx `proxy_pass` at the new
   Evolution container's actual port if it differs from the staged
   `8082` default.

**Tradeoffs vs. Scenario 1:** real uptime (systemd + Docker restart
policies on an always-on box, no laptop dependency), but now the VPS
itself needs the same secrets-hardening treatment (real Linux filesystem
— no NTFS-mount permission problem there — so `chmod 600` on env files
actually means something; do it).

---

## Scenario 3 — Meta Cloud API / 360dialog Production Channel

**When to use:** once Meta's Business API verification clears (the
tracked blocker in `STATUS.md`'s D-series and
`whatsapp-first-architecture.md`) — this is the intended long-term
production channel, not Evolution/Baileys.

**Why this is a different scenario, not just a config flag:** Evolution
mode depends on a self-hosted Baileys bridge (reverse-engineered
WhatsApp Web protocol — works, but not WhatsApp's supported integration
path, and ties the whole channel to one QR-linked device session). Meta
Cloud API via 360dialog is WhatsApp's own supported Business API — no
self-hosted bridge, no device-linking fragility, and it's what
`whatsapp-first-architecture.md` was designed around from the start.

**Cutover is a config change, not a code change:** the codebase already
has both `WhatsappProvider` adapters built and converging on the same
turn handler (`whatsappTurn.ts`). Flip `WA_PROVIDER=360dialog` (see
`infra/docker/RUNBOOK.md` §4 "Running in Meta mode"), point Meta's
webhook configuration at whichever public HTTPS endpoint is live
(Scenario 1's tunnel domain or Scenario 2's VPS domain both work — Meta
doesn't care which). The Evolution containers can be stopped once this
is confirmed working, or kept running as a fallback channel.

---

## Scenario 4 — Cloud-Hosted Scale-Out

**When to use:** only once a real pilot outgrows what a single VPS can
handle — not needed for anything described above. This is the
"eventually, if it works" scenario, kept deliberately brief since
nothing here has been built or validated yet.

Supabase already **is** the real production database in every scenario
above — this isn't about migrating off it, it's about scaling the
compute (`ardalink-api` + `ardalink-engine`) beyond one box once request
volume warrants it (e.g. Azure Container Apps / App Service, co-located
with the Azure OpenAI + Speech resources already in use, avoiding
cross-region latency to those). Evaluate this when there's an actual
load number motivating it, not before.

---

## Environment Variables

Real variable names, pulled from `ardalink-api/.env.example` and
`ardalink-api/infra/docker/.env.example` (not the generic placeholders
this document previously listed):

```bash
# Core
DATABASE_URL=postgresql://ardalink:password@host:5432/ardalink   # local mirror
JWT_SECRET=<random, >=32 bytes — validated at boot>
SESSION_SECRET=<random, >=32 bytes>
TENANT_ATTESTATION_SECRET=<random — HMAC key for engine<->api tenant attestation>

# Supabase (real production data store)
SUPABASE_URL=https://<project>.supabase.co
SUPABASE_SECRET_KEY=sb_secret_...   # service-role — never exposed to the browser

# WhatsApp channel
WA_PROVIDER=evolution   # or 360dialog
EVOLUTION_API_KEY=...
EVOLUTION_INSTANCE_NAME=...
THREESIXTYDIALOG_API_KEY=...          # Meta mode only
THREESIXTYDIALOG_PHONE_NUMBER_ID=...  # Meta mode only

# Africa's Talking (voice/USSD/SMS channels)
AFRICASTALKING_USERNAME=...
AFRICASTALKING_API_KEY=...
AFRICASTALKING_CALLER_ID=+254XXXXXXXXX

# LLM registry (see llm/registry.ts — z.ai primary, minimax fallback for text tasks)
# (provider-specific keys not enumerated here — see registry.ts's routing table)

# Azure OpenAI + Speech
AZURE_OPENAI_ENDPOINT=https://<resource>.openai.azure.com/
AZURE_OPENAI_KEY=<key>
AZURE_OPENAI_DEPLOYMENT=gpt-4o-realtime-preview

# Google Earth Engine
GOOGLE_SERVICE_ACCOUNT_JSON={"type":"service_account",...}   # full JSON blob, see security.md's systemd caveat
GEE_PROJECT=<gcp-project-id>
```

### Legacy / Migration

Cosmos DB was retired 2026-07. Historical NDVI/NDRE baselines now live
in the engine's Postgres (`gis_engine.baseline_aggregate` and
`gis_engine.baseline_pixel`), populated by
`ardalink-engine/scripts/populate_baseline.py`. Nothing reads
`COSMOS_DB_ENDPOINT`/`COSMOS_DB_PRIMARY_KEY` any more.

---

## Security Checklist Per Scenario

Building on `security.md`'s 2026-08-04 findings — what actually needs
fixing before each scenario is safe to rely on:

| Item | Scenario 1 (current) | Scenario 2 (VPS) | Scenario 3 (Meta) | Scenario 4 (scale-out) |
|---|---|---|---|---|
| Open CORS (`app.use(cors())`) | Acceptable — small known tester group | **Fix first** — public-reachable | **Fix first** | **Fix first** |
| No rate limiting on `/api/auth/login` or webhooks | Acceptable | **Fix first** | **Fix first** | **Fix first** |
| Env files world-readable (NTFS mount) | Structural, unfixable here | N/A — real filesystem, `chmod 600` for real | N/A | N/A |
| JWT in `localStorage` | Low risk (no XSS found) | Same — keep checking on every dashboard change | Same | Same |
| `admin_users.role` not enforced | Low risk — small trusted operator group | Revisit if operator count grows | Revisit | Build real RBAC |

---

## Health Checks & Monitoring

| Service | Health Check | Endpoint |
|---------|-------------|----------|
| `ardalink-api` | HTTP GET | `GET /api/healthz` |
| `ardalink-engine` | HTTP GET | `GET /health` |
| `evolution-api` | HTTP GET | `GET /` (manager UI reachable) |
| `ardalink-local-postgres` | Shell | `pg_isready -U ardalink` |

### Recommended monitoring stack (self-hosted, not yet set up)

- **Uptime:** [Uptime Kuma](https://github.com/louislam/uptime-kuma) — polls `/api/healthz` every 60s, alerts via Telegram/email
- **Logs:** currently `journalctl --user -u ardalink-api.service` (Scenario 1) — no centralized log aggregation yet
- **Alerting on the known-stale satellite data**: `/api/healthz` already reports per-table freshness (`satellite_indices`, `weather_data`, `ground_truth_calls`) via the heartbeat job — worth wiring an actual alert on top rather than only checking manually

---

## Cross-References

- **Container stack mechanics (bring-up, mode switching, health checks):** [`ardalink-api/infra/docker/RUNBOOK.md`](../ardalink-api/infra/docker/RUNBOOK.md)
- **Architecture overview:** [`architecture.md`](./architecture.md)
- **Security findings + secrets management:** [`security.md`](./security.md)
- **WhatsApp channel design + Meta blocker:** [`whatsapp-first-architecture.md`](./whatsapp-first-architecture.md)
- **Full engineering log:** [`../STATUS.md`](../STATUS.md)
