# API Data Sources — Inventory & Integration Notes

**Service**: `ardalink-api` (TypeScript, Node 24)
**Audience**: API maintainers, backend engineers
**Scope**: every data feed the **API** itself touches, with attribution,
license, and the exact code path that consumes it.

> **Cross-service:** Google Earth Engine, SRTM, and OSM-derived obstacles
> are consumed by the **engine** service. See
> [`ardalink-engine/docs/data-sources.md`](../ardalink-engine/docs/data-sources.md)
> for those.

---

## 1. Active integrations (live)

| Provider | Endpoint | Auth | Attribution | What it gives | Used by |
|---|---|---|---|---|---|
| **Open-Meteo Forecast** | `https://api.open-meteo.com/v1/forecast` | none | Open-Meteo (CC-BY 4.0) — blends ECMWF / GFS / ICON / GEM / JMA | Hourly + 16-day weather (temperature, precipitation, ET₀, soil moisture) for any lat/lon | `src/lib/climate.ts` → `/api/climate/*` (live 30-day snapshot), the 6-hour scheduler |
| **Open-Meteo Archive (ERA5 + CHIRPS)** | `https://archive-api.open-meteo.com/v1/archive` | none | Open-Meteo (CC-BY 4.0) — backed by ERA5 reanalysis + CHIRPS for rainfall | Daily historical climate back to 1940 — used for year-over-year baselines | `src/lib/openData.ts` → `/api/open-data/year-over-year` |
| **Open-Meteo Air Quality (CAMS)** | `https://air-quality-api.open-meteo.com/v1/air-quality` | none | Open-Meteo (CC-BY 4.0) — Copernicus Atmosphere Monitoring Service ensemble | Hourly PM2.5 / PM10 — dust-storm context | `src/lib/openData.ts` → `/api/open-data/air-quality` |
| **Microsoft Planetary Computer STAC** | `https://planetarycomputer.microsoft.com/api/stac/v1` | none for search; SAS for assets | Microsoft AI for Earth (per-collection open licenses — CC-BY, CC0, etc.) | Discovery of Sentinel-2 (10 m), MODIS MOD13Q1 (NDVI 250 m / 16-day), JRC GSW (surface water), SMAP (soil moisture), CHIRPS daily rainfall | `src/lib/openData.ts` → `/api/open-data/satellite/discover` |

All four are confirmed live during the bring-up:

```
== Open data sources ==
  open-meteo-forecast         healthy  984ms
  open-meteo-archive          healthy  1281ms
  open-meteo-air-quality      healthy  834ms
  planetary-computer-stac     healthy  938ms
  4/4 healthy
```

---

## 2. Wired but disabled (need a credential)

| Provider | What it gives | Why it sits behind a flag | Code path |
|---|---|---|---|
| **Azure OpenAI** (gpt-4o chat + Realtime) | Conversation-grounded chat replies; real-time bilingual voice bridging via WebRTC | Requires `AZURE_OPENAI_API_KEY`. The chat and voice routes still call the Azure endpoint directly; the `/api/intelligence/brief` route uses the provider-agnostic LLM layer (`src/lib/llm/`) which falls back to `MockClient` when no key is set. | `src/lib/llm/providers/{azure,registry}.ts`, `src/routes/chat.ts`, `src/routes/voice.ts` |
| **Azure Cosmos DB** (pre-computed 11-year pixel grids) | Per-pixel, per-month NDVI / NDRE / RED_EDGE baseline so the live composite (from GEE) can be compared to history | Requires `COSMOS_DB_*`. Without it, `fetchLiveVegetation()` throws because `loadCosmosGrid()` finds no chunks. Routes that require baseline comparison return **HTTP 503** with a clear "Cosmos baseline not configured" message. | `src/lib/cosmos.ts` |
| **Africa's Talking** (SMS / USSD / voice telephony) | Outbound SMS, inbound USSD `*123*8#`, voice call bridging | Requires `AT_API_KEY`, `AT_USERNAME`. The voice-stream routes still attempt to connect; without credentials the call-control endpoint returns **HTTP 503** with a clear "Africa's Talking not configured" message. | `src/lib/voiceStream.ts`, `src/routes/{sms,ussd,voice}.ts` |

> **Degraded mode is loud.** When any of the above providers is missing,
> the affected route returns **HTTP 503** with a clear, human-readable
> message naming the unavailable provider and the feature surface it
> gates. See [`README.md`](../README.md) → "Degraded Mode" for the full
> contract.

---

## 3. Evaluated but not yet wired

| Provider | Free tier? | Why we held off | When to revisit |
|---|---|---|---|
| **EMPRES-i / WOAH WAHIS** (animal disease) | Yes — registration | Disease-outbreak bulletins would slot into the brief as a "nearby outbreak" recommendation, but the data shape is irregular (PDFs + bulletin IDs), and we'd need an opinionated parser. | Post-launch Q3. |
| **FEWS NET Data Portal** (food security) | Yes — registration | FEWS NET classifications (IPC phases) are aggregated monthly per livelihood zone — fits the brief perfectly, but the integration needs a calendar of when the latest classification was published and a tenant→livelihood-zone mapping. | Q3 |
| **ACLED** (conflict / security) | Yes — registration, free for non-commercial | A herder won't travel to a water point that's in a contested zone. ACLED's monthly CSVs would feed the brief's "this week" recommendation. | Q3 |
| **HDX / OCHA** (humanitarian data) | Yes | Useful for "what else is happening in this ward" context. | Backlog |

---

## 4. Source code map

| File | Purpose |
|---|---|
| `ardalink-api/src/lib/openData.ts` | Single module wrapping Open-Meteo Forecast/Archive/Air-Quality + Planetary Computer STAC. Exports `OPEN_DATA_SOURCES` (manifest), `probeOpenDataSources()` (live health check), `discoverAllForWard()` (multi-collection STAC search), `fetchYearOverYearClimate()` (year-over-year climate comparison), `fetchAirQualitySnapshot()`. |
| `ardalink-api/src/routes/openData.ts` | HTTP surface: `GET /api/open-data/sources`, `/open-data/sources/manifest`, `/open-data/year-over-year`, `/open-data/air-quality`, `/open-data/satellite/discover`. Tenant-scoped where it makes sense; the manifest endpoint is also useful to ops folks and stays unauthenticated for the demo. |
| `ardalink-api/src/lib/climate.ts` | Original Open-Meteo Forecast wrapper for the live climate snapshot. The `CLIMATE_LAT_DEFAULT` / `CLIMATE_LON_DEFAULT` constants are re-exported so `openData.ts` can use the same ward centre. |
| `ardalink-api/src/lib/cosmos.ts` | Azure Cosmos DB client. Used by `fetchLiveVegetation()` for the 11-year baseline grid. Returns **HTTP 503** when credentials are missing. |
| `ardalink-api/src/lib/llm/{registry,providers/*}.ts` | Provider-agnostic LLM layer. Routes between Azure, Mock, and any future provider. The Mock client is the default fallback. |
| `ardalink-api/src/lib/voiceStream.ts` | Africa's Talking voice-stream bridge. Returns **HTTP 503** when credentials are missing. |
| `ardalink-web/dashboard/src/components/OpenDataCard.tsx` | Operator-facing widget. Live probe every 5 minutes, plus a "climate vs last year" card and a "PM2.5 / PM10 right now" line. |
| `ardalink-api/tests/openData.test.ts` | Live integration tests. All upstream calls wrapped in `safeRun()` so an outage at Open-Meteo or Planetary Computer doesn't break `make verify`. |

---

## 5. Why these choices

The brief generated by the LLM is only as accurate as the data we feed
it. Each provider above gives a different dimension:

- **Climate (Open-Meteo Forecast)** — what the air is doing right now
- **Climate baseline (Open-Meteo Archive)** — what the same week has
  looked like historically, so the brief can compare
- **Air quality (Open-Meteo CAMS)** — dust storms, biomass burning,
  volcanic haze — direct herder-safety context
- **Satellite discovery (Planetary Computer)** — what NDVI / surface
  water / soil-moisture products are available *right now* for the
  ward, so we can either ingest them today or schedule a refresh
- **Baseline (Cosmos)** — what the same month has looked like over the
  past 11 years, so the brief can say "below baseline" instead of
  "below absolute threshold"
- **LLM (Azure OpenAI)** — the synthesis layer that turns the above
  numbers into a one-paragraph herder-facing recommendation

Everything free-and-key-less carries the operator when paid credentials
are absent. Paid providers are additive, never required. The system
never goes dark because a vendor API is down.

---

*Maintained by the ArdaLink engineering team. Last verified: 2026-06-29.*