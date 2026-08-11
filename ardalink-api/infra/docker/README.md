# ArdaLink — Local Development

> **For the full step-by-step runbook** — running every service, both
> WhatsApp provider modes (Meta/360dialog and self-hosted Evolution),
> dashboards, monitoring, and graceful shutdown — see
> [`RUNBOOK.md`](./RUNBOOK.md). This README is the quick-start.

```bash
cd ardalink/infra/docker
cp .env.example .env       # fill in the secrets
make up                    # or: docker compose up --build
make migrate-up            # postgres starts empty — this creates the schema
```

`make migrate-up` is safe to re-run (idempotent). If you're also using
a real Supabase project (not just the local Postgres mirror), see
RUNBOOK.md's ["Bringing up the core
stack"](./RUNBOOK.md#3-bringing-up-the-core-stack) section for the
separate, hand-run Supabase-only migrations that step doesn't cover.

After `make up` + `make migrate-up`:

| Service | URL |
|---|---|
| Operator dashboard | http://localhost:8080 |
| Public Talk | http://localhost:8080/talk |
| API | http://localhost:3000/api/healthz |
| Engine | http://localhost:5001/health |
| Postgres | `localhost:5432` (user `ardalink`, db `ardalink`) |
| Redis | `localhost:6379` |

## Profiles

- `make up` (default) — local stack without TLS
- `make up-tls` — adds Caddy with auto-TLS via Let's Encrypt (requires a real domain)
- `docker compose --profile evolution up` — adds the optional self-hosted WhatsApp gateway (see below)
- `make logs`, `make down`, `make reset` — see `Makefile`

## Handing off to a different deployer (pre-built images)

If someone else is standing up the stack and shouldn't need the source
tree, use `compose.prod.yml` instead of `compose.yml` — pulls pre-built
images from Docker Hub (`munene1212/ardalink-api`,
`munene1212/ardalink-engine`, `munene1212/ardalink-web` — public repos)
instead of building locally, and — unlike `compose.yml`'s local-dev
version — bundles the self-hosted WhatsApp bridge (`evolution-postgres`
+ `evolution-api`) as a core part of the stack, not an opt-in profile:

```bash
cd ardalink/infra/docker
cp .env.example .env                          # fill in real secrets
docker compose -f compose.prod.yml pull
docker compose -f compose.prod.yml up -d       # brings up Evolution too, no extra flag
make migrate-up-prod                           # postgres starts empty — this creates the schema
```

`make migrate-up-prod` is the same migration set as `make migrate-up`
(see the local-dev quick-start above), just targeted at this stack's
own `postgres` container — idempotent, safe to re-run. If this
deployment also points at a real Supabase project, see RUNBOOK.md's
["Bringing up the core
stack"](./RUNBOOK.md#3-bringing-up-the-core-stack) section for the
separate, hand-run Supabase-only migrations required there.

Pin `ARDALINK_IMAGE_TAG` in `.env` to a dated release tag (e.g.
`2026-08-10`) rather than relying on the default `latest` — `latest`
moves every time a new build is pushed, a dated tag doesn't. `api`'s
`WA_PROVIDER` defaults to `evolution` in this file (vs. `360dialog` in
local dev) since Evolution is always up here — override it in `.env`
if this deployment should use a hosted BSP instead. See
`compose.prod.yml`'s own header for the WhatsApp session/cutover caveat
(bringing this stack up creates a NEW WhatsApp session to QR-link, not
a copy of any existing production session) before pointing a real WABA
number at it.

## WhatsApp providers

ArdaLink's WhatsApp channel supports two interchangeable providers behind
one interface (`ardalink-api/src/lib/whatsappProvider.ts`), selected via
`WA_PROVIDER=360dialog|evolution` (default `360dialog`):

- **360dialog** (default) — a hosted BSP, no local infra needed. Set
  `THREESIXTYDIALOG_API_KEY` + `THREESIXTYDIALOG_PHONE_NUMBER_ID`.
- **Evolution API** (optional, self-hosted) — for local testing of the
  second provider path. Bring it up alongside the main stack:

  ```bash
  docker compose --profile evolution up
  ```

  This starts `evolution-postgres` + `evolution-api` (image
  `evoapicloud/evolution-api:v2.3.7`, exposed on `localhost:8081`). It
  does **not** need a real WhatsApp number to run — but a true
  end-to-end test (a real inbound WhatsApp message flowing Meta →
  Evolution → `ardalink-api`) needs a real Meta WABA phone number and
  isn't achievable purely locally. What you *can* verify locally is that
  the container itself works, via a manual smoke test:

  ```bash
  # Uses the EVOLUTION_API_KEY you set in .env (or the compose default)
  export EVO_KEY="${EVOLUTION_API_KEY:?set EVOLUTION_API_KEY first}"

  # Create a Cloud-API-backed instance (no QR code needed for this mode)
  curl -X POST http://localhost:8081/instance/create \
    -H "apikey: $EVO_KEY" -H "Content-Type: application/json" \
    -d '{
      "instanceName": "ardalink-dev",
      "integration": "WHATSAPP-BUSINESS",
      "number": "<your-meta-phone-number-id>",
      "token": "<your-meta-permanent-access-token>",
      "businessId": "<your-waba-id>",
      "webhook": {"url": "http://host.docker.internal:3000/api/evolution-whatsapp-webhook", "enabled": true, "events": ["MESSAGES_UPSERT", "MESSAGES_UPDATE"]}
    }'

  # Send a plain-text message through it
  curl -X POST http://localhost:8081/message/sendText/ardalink-dev \
    -H "apikey: $EVO_KEY" -H "Content-Type: application/json" \
    -d '{"number": "254712345678", "text": "hello from Evolution"}'
  ```

  Then set `WA_PROVIDER=evolution` on `ardalink-api` and restart it to
  route outbound WhatsApp sends through this instance instead of
  360dialog.

## Running migrations

After the engine boots for the first time, apply Phase 2 multi-tenant migrations:

```bash
make migrate-up       # forward
make migrate-down     # rollback
```