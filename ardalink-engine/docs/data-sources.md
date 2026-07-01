# Engine Data Sources — Inventory & Integration Notes

**Service**: `ardalink-engine` (Python 3.12, FastAPI)
**Audience**: engine maintainers, ML/data engineers
**Scope**: every data feed the **engine** itself touches, with attribution,
license, and the exact code path that consumes it.

> **Cross-service:** Open-Meteo (Forecast / Archive / Air Quality) and
> Microsoft Planetary Computer STAC are wired in the **API** service, not
> the engine. See [`ardalink-api/docs/data-sources.md`](../ardalink-api/docs/data-sources.md)
> for those.

---

## 1. Active integrations (live)

| Provider | Endpoint / Artifact | Auth | Attribution | What it gives | Used by |
|---|---|---|---|---|---|
| **Google Earth Engine** (Sentinel-2 SR Harmonized) | GEE `ImageCollection("COPERNICUS/S2_SR_HARMONIZED")` | Service-account JSON (`GOOGLE_SERVICE_ACCOUNT_JSON`) | Google + ESA Copernicus (free for research use; service-account auth required) | 10 m surface reflectance composite per ward, used to derive NDVI / NDRE / RED_EDGE | `ardalink_engine/src/pipeline/gee.py` → `fetchLiveVegetation()` |
| **SRTM elevation** (v3, 30 m) | `https://elevation-tile-prod.s3.amazonaws.com/skadi/{N}/{lat}{lon}.hgt.gz` (public S3 tiles) | none | NASA / USGS / NGA (public domain) | 30 m digital elevation model per grid cell — used for terrain-aware routing | `ardalink_engine/src/pipeline/srtm_terrain.py` |
| **OpenStreetMap-derived water + obstacles** | OSM PBF extracts for the ward (snapshotted) | none | OpenStreetMap contributors (ODbL) | Wells, pans, rivers, settlements, fenced-off areas; the routing engine treats them as obstacles | `ardalink_engine/src/pipeline/obstacles.py`, `ardalink_engine/src/pipeline/grid_ingest.py` |

All three are confirmed live during the local-dev bring-up:

```
== Engine data sources ==
  google-earth-engine       healthy   (with service account) / disabled (no key, pipeline continues without live NDVI)
  srtm-terrain              healthy   ~80 ms per tile
  osm-water-obstacles       healthy   ~10 ms per snapshot
```

---

## 2. Wired but disabled (need a credential)

| Provider | What it gives | Why it sits behind a flag | Code path |
|---|---|---|---|
| **Google Earth Engine** (Sentinel-2 SR Harmonized) | 10 m NDVI / NDRE / RED_EDGE composite over the ward, sampled to the exact pixel grid of the baseline | Requires a service-account JSON (`GOOGLE_SERVICE_ACCOUNT_JSON`). On a cold local-dev boot the warm-up fails harmlessly and `fetchLiveVegetation()` returns **HTTP 503** with a clear "Earth Engine not configured" message. Fallback: live climate + open-data routes continue to work. | `ardalink_engine/src/pipeline/gee.py` |

> **Baseline tables are NOT 503-eligible.** The engine's
> `gis_engine.baseline_aggregate` and `gis_engine.baseline_pixel` are
> empty by default. The endpoints (`/api/v1/baseline/aggregate`,
> `/api/v1/baseline/pixel`) return HTTP 200 with `{"available": false}`
> when empty — the dashboard renders "no baseline yet" honestly
> instead of the intelligence cycle failing. Populate via
> [`scripts/populate_baseline.py`](../scripts/populate_baseline.py).

> **Degraded mode is loud.** When GEE is missing, the affected
> route returns **HTTP 503** with a clear, human-readable message naming
> the unavailable provider and the feature surface it gates. See
> [`README.md`](../README.md) → "Degraded Mode" for the full contract.

---

## 3. Evaluated but not yet wired

| Provider | Free tier? | Why we held off | When to revisit |
|---|---|---|---|
| **FAO WaPOR** (Africa-focused dekadal actual ET, biomass) | Yes — free for non-commercial, requires email signup | Coverage at 100 m, dekadal cadence — perfect for pastoralist biomass assessment, but a new ingest pipeline + a new raster-read path. We want one round of validation before committing. | Post-launch Q3. |
| **GFRA** (Gridded Livestock of the World) | Yes — free | Would let the brief reason about *which species* are likely to be where. Currently assumes cattle + goats + camels per the demo data. | Q4 |

---

## 4. Source code map

| File | Purpose |
|---|---|
| `ardalink-engine/ardalink_engine/src/pipeline/gee.py` | GEE pipeline. Exports `fetchLiveVegetation()`, `warmUpGEE()`. Raises `GEEUnavailableError` (mapped to **HTTP 503**) when the service account is missing. |
| `ardalink-engine/ardalink_engine/src/pipeline/srtm_terrain.py` | SRTM elevation tile fetcher. Caches tiles on disk under `.cache/srtm/`. |
| `ardalink-engine/ardalink_engine/src/pipeline/obstacles.py` | OSM-derived obstacle loader. Used by `routing.py` to weight graph edges. |
| `ardalink-engine/ardalink_engine/src/pipeline/grid_ingest.py` | Snapshot ingester for OSM obstacles + SRTM per ward. |
| `ardalink-engine/ardalink_engine/src/api/grid_query.py` | FastAPI surface for grid queries. Calls into `geo/grid.py`. |
| `ardalink-engine/ardalink_engine/src/geo/routing.py` | Journey planner. Consumes obstacles + grid + (optionally) live vegetation. |
| `ardalink-engine/tests/test_energy.py`, `test_main.py`, `test_wards.py` | Unit + integration tests. All live calls wrapped in `safeRun()` so an upstream outage does not break the test suite. |

---

## 5. Why these choices

The engine consumes three categories of data:

- **Live satellite (GEE)** — what the vegetation looks like right now
- **Terrain (SRTM)** — the physical shape of the ward, used to bias
  routing away from impassable slopes
- **Human geography (OSM)** — where the obstacles are (water points,
  settlements, fenced-off areas)

Each provider is independently optional. The engine always responds,
either with a real answer (all sources live) or with a clear **HTTP 503**
naming which provider is missing. The system never silently returns
stale numbers because a vendor API is down.

---

*Maintained by the ArdaLink engineering team. Last verified: 2026-06-29.*