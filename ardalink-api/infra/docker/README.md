# ArdaLink — Local Development

```bash
cd ardalink/infra/docker
cp .env.example .env       # fill in the secrets
make up                    # or: docker compose up --build
```

After `make up`:

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
  # Create a Cloud-API-backed instance (no QR code needed for this mode)
  curl -X POST http://localhost:8081/instance/create \
    -H "apikey: dev_only_change_me" -H "Content-Type: application/json" \
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
    -H "apikey: dev_only_change_me" -H "Content-Type: application/json" \
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