# ArdaLink

**Pastoralist intelligence platform for the drylands of Isiolo County, Kenya.**

ArdaLink gives pastoralist communities in Isiolo County a low-bandwidth, multi-channel
early-warning and decision-support system for drought stress. Herders reach it through
USSD (`*123*8#`), SMS, browser voice, or an operator dashboard. Three independent services
ingest open satellite + climate data, run biophysical models, and surface actionable
summaries scoped to a single ward (Bulla Pesa, Garbatulla, Kinna — with the
Merti Sub-County operator also live as a tenant) — with strict tenant
isolation enforced at the database boundary.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/Node-24-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Python](https://img.shields.io/badge/Python-3.12-3776AB?logo=python&logoColor=white)](https://python.org)
[![React](https://img.shields.io/badge/React-19-149ECA?logo=react&logoColor=white)](https://react.dev)
[![Vite](https://img.shields.io/badge/Vite-7-646CFF?logo=vite&logoColor=white)](https://vitejs.dev)
[![pnpm](https://img.shields.io/badge/pnpm-workspaces-F69220?logo=pnpm&logoColor=white)](https://pnpm.io)

[View on GitHub ↗](https://github.com/JHUB-AFRICA/arda-link-ai)

---

## What's in this repo

This is the **public monorepo** for ArdaLink. It contains three independently-deployable
services plus a marketing site, organised as siblings so each can be lifted out and
deployed on its own.

| Path | Language | Runtime | One-line purpose |
|---|---|---|---|
| [`ardalink-engine/`](./ardalink-engine/) | Python 3.12 | FastAPI / uvicorn | Biophysical compute — satellite + climate ingestion, energy / water / herd scoring, journey planning. |
| [`ardalink-api/`](./ardalink-api/) | TypeScript | Node 24 | Multi-tenant HTTP boundary — auth, intelligence cycle, ground-truth capture, voice/SMS/USSD routing. |
| [`ardalink-web/`](./ardalink-web/) | TypeScript | React 19 / Vite 7 | Operator dashboard + public browser Talk app + `@workspace/api-client-react` typed hooks. |
| [`ardalink-marketing/`](./ardalink-marketing/) | HTML/CSS/JS | static | Conference posters and the public showcase site. |
| [`Arda-link-AI-Docs/`](./Arda-link-AI-Docs/) | Markdown | — | Long-form narrative documentation (8 deep-dive guides). |

Each service has its own README, lockfile, Dockerfile, and CI workflow.

---

## Architecture at a glance

Read [`STATUS.md`](./STATUS.md) for the strategic view (current vs production, vendor
matrix, roadmap) and [`Arda-link-AI-Docs/architecture.md`](./Arda-link-AI-Docs/architecture.md)
for the C4-style component diagrams.

Five-line summary for anyone in a hurry:

1. **Three services.** The API is the only one that touches the database directly. The web
   apps talk to the API. The engine feeds the API.
2. **Multi-tenant by JWT claim.** Every API request carries a Bearer token; the claim's
   `tenant_id` is bound to the Postgres session and every operational table has
   row-level security enabled.
3. **Open data first.** Free, key-less providers (Open-Meteo, Microsoft Planetary
   Computer STAC) carry the operator when paid credentials are absent. Paid providers
   are additive, never required.
4. **Degraded mode is loud, not silent.** When an upstream provider is missing, the
   affected route returns **HTTP 503** with a clear, human-readable message naming the
   unavailable provider and the feature surface it gates.
5. **The web apps are pure static assets** served by a thin reverse proxy that also
   forwards `/api/*` and `/ws/*` to the API. No CORS dance, no surprises.

---

## Quick start

Prerequisites: Node 24, pnpm 9, Python 3.12, uv, Docker, psql, jq, curl.

```bash
# clone
git clone https://github.com/JHUB-AFRICA/arda-link-ai.git
cd arda-link-ai

# pick a service and follow its README
cd ardalink-api && cat README.md
cd ../ardalink-engine && cat README.md
cd ../ardalink-web && cat README.md
```

For the local dev stack (one Makefile, no secrets, 27-check bring-up), see
[`LOCAL_SETUP.md`](./LOCAL_SETUP.md) (5 min) or [`RUNBOOK.md`](./RUNBOOK.md) (full).

---

## Documentation

| Doc | Purpose | Audience |
|---|---|---|
| [`STATUS.md`](./STATUS.md) | Strategic view — current vs production, vendor matrix, roadmap | Engineers, CTOs, funders |
| [`RUNBOOK.md`](./RUNBOOK.md) | Step-by-step operator manual | Operators, on-call |
| [`LOCAL_SETUP.md`](./LOCAL_SETUP.md) | 5-minute install on a fresh machine | New contributors |
| [`CONVENTIONS.md`](./CONVENTIONS.md) | Shared code conventions + per-service addenda | Contributors, reviewers |
| [`Arda-link-AI-Docs/`](./Arda-link-AI-Docs/) | Long-form narrative (8 guides: api, architecture, data, deployment, onboarding, satellite, security, voice) | Engineers, partners |
| `ardalink-{engine,api,web}/docs/` | Per-service 8-doc CTO navigation | Service-level readers |

### Deep-dive guides in `Arda-link-AI-Docs/`

| Guide | Covers |
|---|---|
| [`architecture.md`](./Arda-link-AI-Docs/architecture.md) | System overview, C4-style context, technology stack |
| [`api.md`](./Arda-link-AI-Docs/api.md) | All public REST endpoints, request/response shapes |
| [`data.md`](./Arda-link-AI-Docs/data.md) | Postgres schema, ERD, multi-tenant RLS policies |
| [`deployment.md`](./Arda-link-AI-Docs/deployment.md) | Local Docker Compose + production hosting options |
| [`onboarding.md`](./Arda-link-AI-Docs/onboarding.md) | New-developer 30–60 min bring-up |
| [`satellite.md`](./Arda-link-AI-Docs/satellite.md) | Google Earth Engine pipeline, Sentinel-2 indices, GEE account setup |
| [`security.md`](./Arda-link-AI-Docs/security.md) | Auth, rate limiting, WebSocket security, threat model |
| [`voice.md`](./Arda-link-AI-Docs/voice.md) | Africa's Talking integration, USSD, voice-call lifecycle |

---

## License

[MIT](./LICENSE) — Copyright (c) 2026 ArdaLink.

---

## Status

Public repository, public visibility, on `master`. Verified end-to-end via CI on every PR.
See each service's CI badge for current state.

---

*Maintained by the ArdaLink engineering team.*