<div align="center">

# ArdaLink Engine

### Biophysical brain for satellite-to-pastoralist drought intelligence

ArdaLink Engine ingests Earth observation data, scores livestock journeys,
and answers environmental questions for Isiolo County and beyond.

[![Python](https://img.shields.io/badge/Python-3.12-3776AB?logo=python&logoColor=white)](https://python.org)
[![FastAPI](https://img.shields.io/badge/FastAPI-latest-009688?logo=fastapi&logoColor=white)](https://fastapi.tiangolo.com)
[![uv](https://img.shields.io/badge/uv-package%20manager-DE5FE9)](https://docs.astral.sh/uv)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](../../LICENSE)

</div>

---

## Quickstart

```bash
# Requires Python 3.12 and uv
uv sync
cp .env.example .env       # edit with your credentials

# Run the API
uv run uvicorn ardalink_engine.main:app --reload --port 5001

# Health check
curl http://localhost:5001/health
```

Open `http://localhost:5001/docs` for the interactive API.

---

## What this service does

| Capability | Endpoint |
|---|---|
| Point conditions (NDVI, NDRE, soil, climate) | `POST /api/v1/conditions` |
| Journey assessment (energy + nutrition scoring) | `POST /api/v1/journey` |
| Spatial assessment across a polygon | `POST /api/v1/spatial` |
| Grid build (Earth Engine reduceRegions) | `POST /api/v1/grid/build` |
| Schedule a refresh run | `POST /api/v1/schedule` |
| Health probe | `GET /health` |

See [`docs/01-ARCHITECTURE.md`](docs/01-ARCHITECTURE.md) for system context.

---

## Degraded mode (HTTP 503 contract)

ArdaLink Engine is designed so that **the absence of an upstream credential
never silently disables a feature**. When a provider that gates a route is
unconfigured or unreachable, the affected route returns **HTTP 503** with
a clear, machine- AND human-readable error body that names the unavailable
provider and the feature surface it gates.

### Which providers can put the engine into degraded mode?

| Provider | Env vars | What fails when missing | Code path |
|---|---|---|---|
| Google Earth Engine | `GOOGLE_SERVICE_ACCOUNT_JSON` | Routes that compute live NDVI / NDRE / RED_EDGE composites (e.g. `/api/v1/conditions`, `/api/v1/grid/build`) | `ardalink_engine/src/pipeline/gee.py` → raises `GEEUnavailableError` |
| Azure Cosmos DB (baseline grids) | `COSMOS_*` | Routes that compare the live composite to the 11-year baseline (`/api/v1/spatial`) | `ardalink_engine/src/db/client.py` → raised by `loadCosmosGrid()` |
| Azure OpenAI (chat-side enrichment) | `AZURE_OPENAI_*` | `/api/v1/journey`'s natural-language rationale layer | `ardalink_engine/src/ai/azure_client.py` → raises `AzureNotConfiguredError` |

### 503 response shape

```json
{
  "error": "upstream_unavailable",
  "provider": "google_earth_engine",
  "feature": "live_vegetation",
  "message": "Google Earth Engine is not configured on this deployment. Set GOOGLE_SERVICE_ACCOUNT_JSON in the engine's environment, then retry.",
  "docs": "https://github.com/JHUB-AFRICA/arda-link-ai/blob/main/ardalink-engine/docs/data-sources.md"
}
```

- **`error`** is a stable, machine-readable code (`upstream_unavailable`).
- **`provider`** names the missing dependency (`google_earth_engine`,
  `cosmos_db`, `azure_openai`).
- **`feature`** names the API surface that is gated
  (`live_vegetation`, `baseline_grid`, `chat_rationale`).
- **`message`** is human-readable, English-only, and contains the
  operator's next step (which env var to set, where to look).
- **`docs`** points to the per-service data-sources doc so the operator
  can keep reading without leaving the error body.

### What still works in degraded mode?

- `GET /health` always returns 200 (with a `degraded: true` flag when any
  provider is missing).
- Free, key-less providers keep responding: `SRTM` terrain tiles,
  `OpenStreetMap` water + obstacles.
- The API service still owns the public surface; the engine is just the
  compute layer.

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
ardalink-engine/
├── ardalink_engine/          # Python package (FastAPI app)
│   ├── main.py
│   ├── api/                  # route handlers + models
│   ├── core_math/            # energy + nutrition formulas
│   ├── db/                   # schema, seed, client
│   ├── geo/                  # grid + routing
│   ├── pipeline/             # GEE ingest, scheduler, obstacles
│   └── ai/                   # Azure OpenAI client
├── tests/                    # pytest (unit + integration + contract)
├── docs/                     # 8-doc CTO navigation
├── pyproject.toml
├── uv.lock
└── .env.example
```

---

## Documentation

Start with [`docs/00-EXECUTIVE-INDEX.md`](docs/00-EXECUTIVE-INDEX.md) (5 min).
For the full data-source inventory and 503 contract per provider, see
[`docs/data-sources.md`](docs/data-sources.md).

---

## Sister services (same monorepo)

- [`ardalink-api/`](../ardalink-api/) — voice, intelligence pipeline, ground-truth capture
- [`ardalink-web/`](../ardalink-web/) — operator dashboard and public Talk app

---

## License

[MIT](../../LICENSE) — Copyright (c) 2026 ArdaLink.