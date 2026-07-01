<div align="center">

# ArdaLink API

### Voice, intelligence pipeline, ground-truth capture

ArdaLink API is the request-facing service: it composes voice calls, runs the
drought intelligence pipeline, captures herder ground truth, and serves data
APIs to the operator dashboard and public Talk app.

[![Node](https://img.shields.io/badge/Node-24-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Express](https://img.shields.io/badge/Express-5-000000?logo=express&logoColor=white)](https://expressjs.com)
[![pnpm](https://img.shields.io/badge/pnpm-9-F69220?logo=pnpm&logoColor=white)](https://pnpm.io)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](../../LICENSE)

</div>

---

## Quickstart

```bash
# Requires Node 24 and pnpm 9
pnpm install
cp .env.example .env       # edit with your credentials
pnpm run dev               # starts the server on :3000

curl http://localhost:3000/api/healthz
```

Open `http://localhost:3000/api/docs` for the interactive API.

---

## What this service does

| Capability | Endpoint |
|---|---|
| Intelligence pipeline (vegetation delta → call decision) | `POST /api/trigger-check` |
| Current drought status snapshot | `GET /api/status` |
| Voice call bridge (phone) | `WS /api/voice-stream` |
| Voice call bridge (browser) | `WS /api/browser-voice-stream` |
| Africa's Talking callback (returns `<Stream>`) | `POST /api/voice-callback` |
| One-shot call token | `POST /api/call-tokens` |
| Ground truth reports | `GET /api/ground-truth/recent` |
| Pastoralist directory CRUD | `GET \| POST \| DELETE /api/pastoralists` |
| Health probe | `GET /api/healthz` |

Full route list: [`docs/02-API.md`](docs/02-API.md).

---

## Degraded mode (HTTP 503 contract)

ArdaLink API is designed so that **the absence of an upstream credential
never silently disables a feature**. When a provider that gates a route is
unconfigured or unreachable, the affected route returns **HTTP 503** with
a clear, machine- AND human-readable error body that names the unavailable
provider and the feature surface it gates.

### Which providers can put the API into degraded mode?

| Provider | Env vars | What fails when missing | Code path |
|---|---|---|---|
| Azure OpenAI (chat + Realtime voice) | `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_ENDPOINT` | `/api/chat`, `/api/intelligence/brief` (falls back to `MockClient`), `/api/voice-stream` (browser-voice) | `src/lib/llm/providers/azure.ts`, `src/routes/chat.ts` |
| Africa's Talking (SMS, USSD, voice telephony) | `AT_API_KEY`, `AT_USERNAME` | `/api/call-tokens`, `/api/sms`, `/api/ussd`, `/api/voice-callback` | `src/lib/voiceStream.ts`, `src/routes/{sms,ussd,voice}.ts` |
| Google Earth Engine (live vegetation) | delegated to the engine | `/api/status` returns `degraded: true` with the engine's error in `last_run.error` | (engine owns the call — see `../ardalink-engine/README.md`) |

> **Baseline source of truth** is the engine's Postgres table
> `gis_engine.baseline_aggregate` (and optionally `baseline_pixel`).
> Populated by `ardalink-engine/scripts/populate_baseline.py`. When the
> table is empty for a (ward, month), the API does **not** return 503 —
> it returns the live composite with `baselineSource: "none"` so the
> dashboard can render "no baseline yet" honestly.

### 503 response shape

```json
{
  "error": "upstream_unavailable",
  "provider": "azure_openai",
  "feature": "intelligence_brief",
  "message": "Azure OpenAI is not configured on this deployment. Set AZURE_OPENAI_API_KEY and AZURE_OPENAI_ENDPOINT in the API's environment, then retry.",
  "docs": "https://github.com/JHUB-AFRICA/arda-link-ai/blob/main/ardalink-api/docs/data-sources.md"
}
```

- **`error`** is a stable, machine-readable code (`upstream_unavailable`).
- **`provider`** names the missing dependency (`azure_openai`,
  `africas_talking`, `google_earth_engine`).
- **`feature`** names the API surface that is gated
  (`intelligence_brief`, `voice_bridge`, `sms_outbound`,
  `ussd_inbound`).
- **`message`** is human-readable, English-only, and contains the
  operator's next step (which env var to set, where to look).
- **`docs`** points to the per-service data-sources doc so the operator
  can keep reading without leaving the error body.

### What still works in degraded mode?

- `GET /api/healthz` always returns 200 (with a `degraded: true` flag
  listing the missing providers).
- Free, key-less providers keep responding: Open-Meteo (Forecast,
  Archive, Air Quality), Microsoft Planetary Computer STAC.
- The intelligence brief falls back to the `MockClient` LLM provider,
  which returns a deterministic placeholder so the dashboard's
  pipeline stays testable end-to-end.
- Live vegetation + GEE composite work without a baseline; the
  anomaly report includes `baselineSource: "none"` so the dashboard
  can render the "no baseline" state honestly.

### Why 503 and not silent graceful-degrade?

A silent graceful-degrade would return **stale** numbers when an upstream
provider is down. The operator would not know whether they were looking
at a real reading or a 3-day-old cached one — and they would make
operational decisions on that data. By returning **503 with a named
provider**, the system surfaces the truth and lets the operator choose
to wait, switch to the dashboard's "open data only" view, or escalate.

See [`docs/data-sources.md`](docs/data-sources.md) for the full provider
inventory and which code paths each one gates.

---

## Repository layout

```
ardalink-api/
├── src/
│   ├── index.ts            # Express bootstrap
│   ├── app.ts              # middleware chain
│   ├── routes/             # intelligence, voice, ground-truth, …
│   ├── lib/                # openai, satellite, climate, memory, …
│   └── middlewares/        # auth, rate limit, origin guard
├── lib/
│   ├── api-spec/           # canonical OpenAPI (single source of truth)
│   ├── api-zod/            # generated Zod schemas
│   └── db/                 # Drizzle ORM (PostgreSQL public schema)
├── tests/                  # vitest (unit + integration + contract)
├── docs/                   # 8-doc CTO navigation
├── Dockerfile
└── package.json
```

---

## Documentation

Start with [`docs/00-EXECUTIVE-INDEX.md`](docs/00-EXECUTIVE-INDEX.md) (5 min).
For the full data-source inventory and 503 contract per provider, see
[`docs/data-sources.md`](docs/data-sources.md).

---

## Sister services (same monorepo)

- [`ardalink-engine/`](../ardalink-engine/) — biophysical brain
- [`ardalink-web/`](../ardalink-web/) — operator dashboard and Talk app

---

## License

[MIT](../../LICENSE) — Copyright (c) 2026 ArdaLink.