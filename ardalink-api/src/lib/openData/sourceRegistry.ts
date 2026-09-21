/**
 * Static manifest of every open-source data provider the system
 * touches, plus a health probe. Surfaced via `/api/open-data/sources`
 * so the dashboard can render an "Open data sources" panel and the
 * engineering team can audit what feeds what.
 */

import { logger } from "../logger.js";
import { CLIMATE_LAT_DEFAULT, CLIMATE_LON_DEFAULT } from "../climate.js";
import { PC_STAC } from "./planetaryComputer.js";

export interface OpenDataSourceInfo {
  id: string;
  name: string;
  baseUrl: string;
  auth: "none" | "optional" | "required" | string;
  attribution: string;
  whatItGives: string;
  integratedAsOf: string;
}

export const OPEN_DATA_SOURCES: OpenDataSourceInfo[] = [
  {
    id: "open-meteo-forecast",
    name: "Open-Meteo Forecast",
    baseUrl: "https://api.open-meteo.com/v1/forecast",
    auth: "none",
    attribution:
      "Weather data by Open-Meteo (CC-BY 4.0). Forecasts blend ECMWF, GFS, ICON, GEM, JMA.",
    whatItGives:
      "Hourly + daily weather (temperature, precipitation, ET₀, soil moisture) for any lat/lon.",
    integratedAsOf: "v0.1.0",
  },
  {
    id: "open-meteo-archive",
    name: "Open-Meteo Archive (ERA5 + CHIRPS blend)",
    baseUrl: "https://archive-api.open-meteo.com/v1/archive",
    auth: "none",
    attribution:
      "Historical weather data by Open-Meteo (CC-BY 4.0). Backed by ERA5 reanalysis and CHIRPS for rainfall.",
    whatItGives:
      "Daily historical climate from 1940 — used for year-over-year baselines.",
    integratedAsOf: "v0.2.0",
  },
  {
    id: "open-meteo-air-quality",
    name: "Open-Meteo Air Quality (CAMS)",
    baseUrl: "https://air-quality-api.open-meteo.com/v1/air-quality",
    auth: "none",
    attribution:
      "Air-quality data by Open-Meteo (CC-BY 4.0). Backed by the Copernicus Atmosphere Monitoring Service (CAMS) ensemble.",
    whatItGives:
      "Hourly PM2.5 and PM10 — dust-storm context for herder briefings.",
    integratedAsOf: "v0.2.0",
  },
  {
    id: "planetary-computer-stac",
    name: "Microsoft Planetary Computer (STAC catalog)",
    baseUrl: "https://planetarycomputer.microsoft.com/api/stac/v1",
    auth: "none (catalog) / optional (assets)",
    attribution:
      "Hosted by Microsoft AI for Earth. Each collection carries its own open license (CC-BY, CC0, etc.); see STAC asset metadata.",
    whatItGives:
      "Discovery of Sentinel-2 (10m), MODIS MOD13Q1 (NDVI 250m / 16-day), JRC GSW (surface water), SMAP (soil moisture), CHIRPS daily rainfall.",
    integratedAsOf: "v0.2.0",
  },
];

/** Probe each source with a cheap request so the dashboard can show
 *  green / red dots next to each provider in the open-data panel. */
export async function probeOpenDataSources(): Promise<
  Array<OpenDataSourceInfo & { healthy: boolean; latencyMs: number; error?: string }>
> {
  const probes: Array<Promise<{ id: string; healthy: boolean; latencyMs: number; error?: string }>> = [
    (async () => {
      const start = Date.now();
      try {
        const url = new URL("https://api.open-meteo.com/v1/forecast");
        url.searchParams.set("latitude", String(CLIMATE_LAT_DEFAULT));
        url.searchParams.set("longitude", String(CLIMATE_LON_DEFAULT));
        url.searchParams.set("current", "temperature_2m");
        const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
        return {
          id: "open-meteo-forecast",
          healthy: r.ok,
          latencyMs: Date.now() - start,
          error: r.ok ? undefined : `HTTP ${r.status}`,
        };
      } catch (e) {
        return { id: "open-meteo-forecast", healthy: false, latencyMs: Date.now() - start, error: String(e) };
      }
    })(),
    (async () => {
      const start = Date.now();
      try {
        const url = new URL("https://archive-api.open-meteo.com/v1/archive");
        url.searchParams.set("latitude", String(CLIMATE_LAT_DEFAULT));
        url.searchParams.set("longitude", String(CLIMATE_LON_DEFAULT));
        url.searchParams.set("start_date", "2025-06-01");
        url.searchParams.set("end_date", "2025-06-07");
        url.searchParams.set("daily", "precipitation_sum");
        const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
        return {
          id: "open-meteo-archive",
          healthy: r.ok,
          latencyMs: Date.now() - start,
          error: r.ok ? undefined : `HTTP ${r.status}`,
        };
      } catch (e) {
        return { id: "open-meteo-archive", healthy: false, latencyMs: Date.now() - start, error: String(e) };
      }
    })(),
    (async () => {
      const start = Date.now();
      try {
        const url = new URL("https://air-quality-api.open-meteo.com/v1/air-quality");
        url.searchParams.set("latitude", String(CLIMATE_LAT_DEFAULT));
        url.searchParams.set("longitude", String(CLIMATE_LON_DEFAULT));
        url.searchParams.set("current", "pm10");
        const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
        return {
          id: "open-meteo-air-quality",
          healthy: r.ok,
          latencyMs: Date.now() - start,
          error: r.ok ? undefined : `HTTP ${r.status}`,
        };
      } catch (e) {
        return { id: "open-meteo-air-quality", healthy: false, latencyMs: Date.now() - start, error: String(e) };
      }
    })(),
    (async () => {
      const start = Date.now();
      try {
        const r = await fetch(PC_STAC, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            collections: ["modis-13Q1-061"],
            bbox: [37.0, -0.1, 38.0, 0.7],
            datetime: "2026-06-15/2026-06-22",
            limit: 1,
          }),
          signal: AbortSignal.timeout(10_000),
        });
        return {
          id: "planetary-computer-stac",
          healthy: r.ok,
          latencyMs: Date.now() - start,
          error: r.ok ? undefined : `HTTP ${r.status}`,
        };
      } catch (e) {
        return { id: "planetary-computer-stac", healthy: false, latencyMs: Date.now() - start, error: String(e) };
      }
    })(),
  ];

  const results = await Promise.all(probes);
  const byId = new Map(results.map((r) => [r.id, r] as const));
  logger.info(
    {
      sources: results.map((r) => ({
        id: r.id,
        healthy: r.healthy,
        latencyMs: r.latencyMs,
      })),
    },
    "[OpenData] Probed open data sources",
  );
  return OPEN_DATA_SOURCES.map((info) => {
    const probe = byId.get(info.id);
    return {
      ...info,
      healthy: probe?.healthy ?? false,
      latencyMs: probe?.latencyMs ?? 0,
      error: probe?.error,
    };
  });
}
