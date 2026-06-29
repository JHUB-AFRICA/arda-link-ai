# ArdaLink AI — Developer Onboarding

> This guide gets a new developer from zero to a fully running local ArdaLink environment. Estimated time: 30–60 minutes depending on your internet speed and GEE account setup.

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Repository Structure](#repository-structure)
3. [Local Setup](#local-setup)
4. [Running the Platform](#running-the-platform)
5. [Testing Guide](#testing-guide)
6. [Working with Africa's Talking](#working-with-africas-talking)
7. [Common Issues](#common-issues)
8. [Code Conventions](#code-conventions)

---

## Prerequisites

Ensure the following are installed before starting:

| Tool | Version | Install |
|------|---------|---------|
| Docker Desktop | 24+ | [docker.com](https://docker.com) |
| Docker Compose | v2 (bundled with Docker Desktop) | — |
| Node.js | 22+ | [nodejs.org](https://nodejs.org) or via `nvm` |
| Python | 3.12+ | [python.org](https://python.org) or via `pyenv` |
| Git | Any | — |

You will also need accounts with:

- **Africa's Talking** — [account.africastalking.com](https://account.africastalking.com) (free sandbox)
- **Azure OpenAI** — Azure subscription with `gpt-4o-realtime` deployed
- **Google Earth Engine** — [earthengine.google.com](https://earthengine.google.com) (free for research)

---

## Repository Structure

```
ardalink-ai/
├── ardalink-web/          # React 19 + Vite frontend
│   ├── src/
│   │   ├── components/    # UI components (maps, charts, forms)
│   │   ├── pages/         # Route pages (dashboard, pastoralists, reports)
│   │   ├── hooks/         # Custom React hooks
│   │   └── lib/           # API client, utilities
│   ├── Dockerfile
│   └── vite.config.ts
│
├── ardalink-api/          # Express 5 + Node 22 API server
│   ├── src/
│   │   ├── routes/        # Route handlers grouped by domain
│   │   │   ├── auth.ts
│   │   │   ├── pastoralists.ts
│   │   │   ├── ground-truth.ts
│   │   │   ├── intelligence.ts
│   │   │   ├── voice.ts
│   │   │   ├── ussd.ts
│   │   │   └── sms.ts
│   │   ├── middleware/    # Auth, tenant context, rate limiting
│   │   ├── db/            # Drizzle ORM schema + migrations
│   │   ├── services/      # Business logic (voice bridge, AT client)
│   │   └── index.ts       # App entry point
│   ├── Dockerfile
│   └── package.json
│
├── ardalink-engine/       # Python 3.12 + FastAPI satellite engine
│   ├── app/
│   │   ├── gee/           # Google Earth Engine processing
│   │   │   ├── ndvi.py
│   │   │   ├── ndre.py
│   │   │   ├── vci.py
│   │   │   └── prosopis.py
│   │   ├── climate/       # Open-Meteo integration
│   │   ├── db/            # SQLAlchemy models (gis_engine schema)
│   │   └── main.py        # FastAPI app
│   ├── Dockerfile
│   └── requirements.txt
│
├── docs/
│   └── system/            # ← You are here
│
├── docker-compose.yml
├── Caddyfile
├── .env.example
└── README.md
```

---

## Local Setup

### Step 1 — Clone the repository

```bash
git clone https://github.com/Diznizo25/ardalink-ai.git
cd ardalink-ai
```

### Step 2 — Copy and configure environment variables

```bash
cp .env.example .env
```

Open `.env` and fill in the required values. Minimum needed for local development:

```bash
# Database (Docker handles this — leave as-is for local)
DATABASE_URL=postgresql://ardalink:ardalink@localhost:5432/ardalink
REDIS_URL=redis://localhost:6379

# Required — generate random strings
JWT_SECRET=$(openssl rand -hex 32)
SESSION_SECRET=$(openssl rand -hex 32)
TENANT_ATTESTATION_SECRET=$(openssl rand -hex 32)

# Africa's Talking (sandbox — free, no real calls)
AFRICASTALKING_USERNAME=sandbox
AFRICASTALKING_API_KEY=<your-sandbox-key>
AFRICASTALKING_CALLER_ID=+254711082200   # AT sandbox number

# Azure OpenAI (required for voice calls)
AZURE_OPENAI_ENDPOINT=https://<resource>.openai.azure.com/
AZURE_OPENAI_API_KEY=<your-key>
AZURE_OPENAI_REALTIME_DEPLOYMENT=gpt-4o-realtime

# Google Earth Engine (required for satellite pipeline)
GEE_SERVICE_ACCOUNT=<JSON as single-line string>
GEE_PROJECT=<your-gcp-project>
```

**Tip:** For local development without GEE or Azure, most features still work. The satellite snapshot cache will return empty results, and voice calls will fail at the Azure bridge — but the dashboard, USSD, SMS, and pastoralist management all function without those credentials.

### Step 3 — Set up Google Earth Engine service account

1. Go to [console.cloud.google.com](https://console.cloud.google.com) → IAM → Service Accounts
2. Create a service account with `Earth Engine Resource Writer` role
3. Download the JSON key
4. Register the service account email at [earthengine.google.com/noncommercial_signup](https://earthengine.google.com/noncommercial_signup)
5. Stringify the JSON and set it as `GEE_SERVICE_ACCOUNT` in `.env`:

```bash
GEE_SERVICE_ACCOUNT=$(cat service-account.json | python3 -c "import sys,json; print(json.dumps(json.load(sys.stdin)))")
```

### Step 4 — Initialise the database

The database is created automatically by Docker, but you need to run migrations and seed data:

```bash
# Start just postgres first
docker compose up postgres -d

# Run migrations (from ardalink-api)
cd ardalink-api
npm install
npm run db:migrate

# Seed initial tenants and an admin user
npm run db:seed
```

The seed script creates:
- Tenants: `bula-pesa`, `garbatulla`, `merti`, `legacy`
- Admin user: `admin@ardalink.local` / `changeme123` (change immediately)

---

## Running the Platform

### Full stack (recommended)

```bash
docker compose up
```

Services will be available at:

| Service | URL |
|---------|-----|
| Web Dashboard | http://localhost:8080 |
| API | http://localhost:3000 |
| Engine | http://localhost:5001 |
| API Health | http://localhost:3000/api/healthz |
| Caddy proxy | http://localhost |

### Individual services (for active development)

When working on `ardalink-api`, you may want Docker for the data services but Node for hot-reload:

```bash
# Start infrastructure
docker compose up postgres redis engine -d

# Run API with hot-reload
cd ardalink-api
npm run dev

# Run web with hot-reload
cd ardalink-web
npm run dev
```

### Useful Docker commands

```bash
# View logs for a specific service
docker compose logs -f api

# Restart a single service
docker compose restart api

# Stop everything
docker compose down

# Wipe the database (fresh start)
docker compose down -v
```

---

## Testing Guide

### API health check

```bash
curl http://localhost:3000/api/healthz
# Expected: {"status":"ok","service":"ardalink-api","version":"1.0.0"}
```

### Login as admin

```bash
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@ardalink.local","password":"changeme123"}'

# Save the token
TOKEN="eyJ..."
```

### List pastoralists

```bash
curl http://localhost:3000/api/pastoralists \
  -H "Authorization: Bearer $TOKEN"
```

### Simulate a USSD request

```bash
curl -X POST http://localhost:3000/api/ussd-callback \
  -d "sessionId=test-session-001" \
  -d "serviceCode=*123*8#" \
  -d "phoneNumber=+254711082200" \
  -d "text="

# Expected: CON Karibu ArdaLink\n...
```

### Simulate a USSD menu selection (option 1 → Bula Pesa)

```bash
curl -X POST http://localhost:3000/api/ussd-callback \
  -d "sessionId=test-session-001" \
  -d "serviceCode=*123*8#" \
  -d "phoneNumber=+254711082200" \
  -d "text=1"
```

### Simulate an SMS keyword

```bash
curl -X POST http://localhost:3000/api/sms-callback \
  -d "from=+254711082200" \
  -d "to=+254XXXXXXXXX" \
  -d "text=BULA" \
  -d "id=sms-test-001" \
  -d "date=2026-06-18 11:04:00"
```

### Trigger a dry-run drought check

```bash
curl -X POST http://localhost:3000/api/trigger-check \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"phone":"+254711082200","dryRun":true}'
```

### Test the satellite intelligence brief

```bash
curl http://localhost:3000/api/intelligence/brief \
  -H "Authorization: Bearer $TOKEN"
```

---

## Working with Africa's Talking

### Sandbox mode

AT provides a free sandbox environment. Calls and SMS in sandbox mode are not real — they're visible in the AT sandbox simulator dashboard.

**Webhook testing with ngrok:**

Africa's Talking webhooks require a public HTTPS URL. Use ngrok for local testing:

```bash
# Install ngrok: https://ngrok.com
ngrok http 3000

# Copy the HTTPS URL, e.g. https://abc123.ngrok-free.app
# Set this as your webhook URL in the AT dashboard:
# Voice callback: https://abc123.ngrok-free.app/api/voice-callback
# USSD callback: https://abc123.ngrok-free.app/api/ussd-callback
# SMS callback:  https://abc123.ngrok-free.app/api/sms-callback
```

### AT Sandbox Simulator

The [AT dashboard simulator](https://simulator.africastalking.com) lets you:
- Send USSD sessions as if you were dialling from a phone
- Send test SMS messages
- Simulate inbound calls

Use phone number `+254711082200` (Hassan Wako from seed data) when testing.

---

## Common Issues

### `SET LOCAL` fails / RLS not working

**Symptom:** Queries return all rows regardless of tenant.

**Fix:** Ensure you're wrapping all queries in `withTenantContext()`. The `SET LOCAL` must be inside a transaction.

---

### GEE authentication fails

**Symptom:** Engine logs show `EEException: Permission denied`.

**Fix:**
1. Verify the service account email is registered at earthengine.google.com
2. Check `GEE_PROJECT` matches the GCP project where the service account lives
3. Ensure the JSON is properly stringified in `.env` (no newlines)

---

### Voice call fails silently

**Symptom:** Call connects but no audio, or call drops immediately.

**Checklist:**
- Azure OpenAI endpoint URL ends with `/` 
- `gpt-4o-realtime` deployment name matches `AZURE_OPENAI_REALTIME_DEPLOYMENT`
- ngrok is running and AT webhook URL is updated
- Redis is running (rate limit check fails without it)

---

### Docker volume permissions error on Linux

**Symptom:** `postgres` container fails to start with permissions error.

**Fix:**
```bash
sudo chown -R 999:999 ./pgdata
```

---

## Code Conventions

### TypeScript (ardalink-api, ardalink-web)

- **ESM modules** — `import/export`, no CommonJS
- **Drizzle ORM** for all database access — no raw SQL except for `SET LOCAL`
- **Zod** for request validation on all POST/PUT endpoints
- Routes are grouped by domain in `src/routes/`
- Middleware lives in `src/middleware/`

### Python (ardalink-engine)

- **Type hints** on all function signatures
- **Pydantic** for request/response models
- GEE operations are in `app/gee/` — one file per index
- All GEE calls go through `app/gee/client.py` which handles auth

### Git workflow

- `main` — production-ready, deployable
- `dev` — integration branch
- Feature branches: `feat/<description>`
- Fix branches: `fix/<description>`

Commit messages follow Conventional Commits:
```
feat(voice): add Borana language detection
fix(rls): wrap pastoralists route in withTenantContext
docs(api): add call-tokens endpoint documentation
```

---

## Cross-References

- **Architecture overview:** [`architecture.md`](./architecture.md)
- **Full API reference:** [`api.md`](./api.md)
- **Environment variables:** [`deployment.md`](./deployment.md#environment-variables)
- **Security & JWT:** [`security.md`](./security.md)
- **Voice call design:** [`voice.md`](./voice.md)
