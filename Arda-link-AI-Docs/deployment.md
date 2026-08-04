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
3. [Scenario 2 — VPS Self-Hosted (staged, not yet cut over)](#scenario-2--vps-self-hosted-staged-not-yet-cut-over)
4. [Scenario 3 — Meta Cloud API / 360dialog Production Channel](#scenario-3--meta-cloud-api--360dialog-production-channel)
5. [Scenario 4 — Cloud-Hosted Scale-Out](#scenario-4--cloud-hosted-scale-out)
6. [Environment Variables](#environment-variables)
7. [Security Checklist Per Scenario](#security-checklist-per-scenario)
8. [Health Checks & Monitoring](#health-checks--monitoring)

---

## Current State — What's Actually Running Today

```mermaid
flowchart TB
    subgraph Laptop ["Dev laptop (munen-Latitude-7420)"]
        API["ardalink-api\nsystemd: ardalink-api.service\n:3001"]
        LocalPG["ardalink-local-postgres\n:15432 (local mirror)"]
        LocalRedis["ardalink-local-redis\n:6379 (provisioned, unused)"]
        Evo["evolution-api (Docker)\nv2.3.7, Baileys 7.0.0-rc.9\n:8081"]
        EvoPG["evolution-postgres (Docker)"]
        Tunnel["ardalink-tunnel.service\nautossh -R 127.0.0.1:9091:127.0.0.1:3001"]
    end

    subgraph VPS ["baitech VPS (69.164.244.165)"]
        Nginx1["nginx: ardalink.ementech.co.ke\n-> 127.0.0.1:9091"]
        Nginx2["nginx: wa.ardalink.ementech.co.ke\n-> 127.0.0.1:8082 (staged, see Scenario 2)"]
    end

    subgraph Cloud ["Real production data + AI (cloud)"]
        Supabase["Supabase\n(source of truth: wards, pastoralists,\nground_truth_calls, whatsapp_messages*)"]
        ZAI["z.ai (glm-4.5-flash)\nprimary LLM"]
        Minimax["MiniMax\nfallback LLM"]
        Azure["Azure OpenAI + Speech\nvoice/TTS/STT"]
        GEE["Google Earth Engine"]
    end

    WhatsAppUser["Real WhatsApp testers"] -->|messages| Evo
    Evo -->|webhook| API
    API <-->|reverse SSH tunnel| Tunnel
    Tunnel -.->|forwards to| Nginx1
    Nginx1 -->|public HTTPS, not used for inbound today| API
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
- `ardalink-api` runs as a systemd service **on this laptop**, not on any
  server — `ardalink-api.service`, `WorkingDirectory=.../ardalink-api`,
  auto-restarts on crash, survives laptop reboots (`WantedBy=default.target`).
- Real WhatsApp testers reach it via a **permanent reverse SSH tunnel**
  (`ardalink-tunnel.service`, `autossh`) to the baitech VPS — the VPS
  itself runs no ArdaLink application code, only an nginx reverse proxy
  (`/media/munen/muneneENT/baitech-infra/nginx/ardalink.ementech.co.ke.conf`)
  that forwards to whatever the tunnel is pointed at. **If the laptop is
  off, asleep, or off the network, the whole WhatsApp channel goes down**
  — this is the central limitation of Scenario 1, and the reason
  Scenario 2 exists.
- Evolution (the self-hosted WhatsApp/Baileys bridge) also runs **on this
  laptop** via Docker, QR-linked to a real WhatsApp number.
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

**Setup:** see `ardalink-api/infra/docker/RUNBOOK.md` for bringing up
Evolution + the core stack locally. The tunnel/systemd layer on top of
that (not covered in that runbook, since it's laptop-specific, not part
of the containerized stack) is two systemd user units:
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

## Scenario 2 — VPS Self-Hosted (staged, not yet cut over)

**When to use:** the natural next step once local-laptop testing is
validated and you want the WhatsApp channel to survive laptop reboots,
sleep, and network changes — i.e. an actual pilot, not just testing.

**Current status: partially staged, not live.** The baitech VPS already
has:
- `/root`-adjacent `ardalink-evolution/docker-compose.yml` +
  `.env.example` pre-staged (created 2026-08-02) — an Evolution instance
  ready to bring up directly on the VPS.
- nginx already configured for `wa.ardalink.ementech.co.ke` → `127.0.0.1:8082`,
  with the Evolution manager UI (`/manager`) gated behind a **dedicated**
  basic-auth file (`.htpasswd_ardalink_evolution` — deliberately separate
  from any other Evolution instance's manager credentials on the same
  box).
- The main domain's nginx config (`ardalink.ementech.co.ke.conf`)
  explicitly documents, in its own comments, that ardalink-api is *not*
  hosted on the VPS today — only the reverse-proxy hop to the tunnel is.

**To actually cut over:**
1. Bring up `ardalink-evolution`'s staged compose stack on the VPS,
   QR-link a WhatsApp number (or migrate the existing linked session —
   check Evolution's session-export/import support first, since
   re-linking means a new number or a brief downtime window).
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
