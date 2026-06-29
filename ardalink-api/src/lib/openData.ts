/**
 * Open-source data layer.
 *
 * Wraps three families of free, key-less, attribution-required APIs that
 * ArdaLink can use in production without paying a vendor or registering
 * an account:
 *
 *   1. Open-Meteo (Forecast + Archive + Air Quality)
 *      - https://api.open-meteo.com       — current + 30-day forecast
 *      - https://archive-api.open-meteo.com — ERA5 / CHIRPS-equivalent historical
 *      - https://air-quality-api.open-meteo.com — PM2.5/PM10
 *      - Free for non-commercial. CC-BY 4.0 attribution required.
 *
 *   2. Microsoft Planetary Computer STAC
 *      - https://planetarycomputer.microsoft.com/api/stac/v1/search
 *      - Free for any use, no auth for catalog search; signed URLs for assets.
 *      - Sentinel-2 L2A (10m), MOD13Q1 (NDVI/EVI 250m / 16-day),
 *        JRC GSW (surface water), SMAP (soil moisture), CHIRPS (daily rainfall).
 *
 *   3. ReliefWeb / FEWS NET / FAOSTAT (catalog only; data downloads are
 *      a separate exercise — listed in the `/api/open-data/sources` doc).
 *
 * Why this module exists: the operator dashboard needs accurate data to
 * make drought-relief calls. Each provider here either complements
 * (Open-Meteo gives us rainfall + temperature on demand) or replaces
 * (MOD13Q1 on Planetary Computer replaces Earth Engine for NDVI) the
 * paid / credentialed paths so the system keeps working when keys
 * are missing.
 */

import { sql, count, avg, gte } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  groundTruthReportsTable,
  pastoralistsTable,
} from "@workspace/db";
import { logger } from "./logger.js";
import { CLIMATE_LAT_DEFAULT, CLIMATE_LON_DEFAULT } from "./climate.js";
import { withTenantContext } from "./tenancy-context.js";

// ── Open-Meteo — historical climate (ERA5-based; archive goes back to 1940) ─

export interface HistoricalClimateWindow {
  startDate: string; // YYYY-MM-DD
  endDate: string;
  days: number;
  totalPrecipMm: number;
  totalET0Mm: number;
  rainyDays: number;
  meanTempC: number;
  meanMaxTempC: number;
  moistureAdequacyIndex: number; // totalPrecip / totalET0
  droughtSeverity:
    | "none"
    | "mild"
    | "moderate"
    | "severe"
    | "extreme";
  source: "open-meteo-archive";
  license: "CC-BY 4.0 (Open-Meteo / ERA5 / CHIRPS blend)";
}

function classifyDrought(mai: number): HistoricalClimateWindow["droughtSeverity"] {
  if (mai >= 0.8) return "none";
  if (mai >= 0.5) return "mild";
  if (mai >= 0.3) return "moderate";
  if (mai >= 0.1) return "severe";
  return "extreme";
}

/**
 * Fetch a climate window from Open-Meteo's historical archive.
 * Same shape as the rolling-30-day block we compute for the live climate
 * snapshot, so callers can compare "now" vs "this window last year".
 */
export async function fetchHistoricalClimateWindow(
  lat: number,
  lon: number,
  startDate: string,
  endDate: string,
): Promise<HistoricalClimateWindow> {
  const url = new URL("https://archive-api.open-meteo.com/v1/archive");
  url.searchParams.set("latitude", String(lat));
  url.searchParams.set("longitude", String(lon));
  url.searchParams.set("start_date", startDate);
  url.searchParams.set("end_date", endDate);
  url.searchParams.set("timezone", "Africa/Nairobi");
  url.searchParams.set(
    "daily",
    [
      "temperature_2m_max",
      "temperature_2m_min",
      "temperature_2m_mean",
      "precipitation_sum",
      "et0_fao_evapotranspiration",
    ].join(","),
  );

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 20_000);
  let res: Response;
  try {
    res = await fetch(url, { signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(
      `Open-Meteo Archive ${res.status}: ${text.slice(0, 200)}`,
    );
  }
  const data = (await res.json()) as {
    daily: {
      time: string[];
      precipitation_sum: (number | null)[];
      temperature_2m_max: (number | null)[];
      temperature_2m_min: (number | null)[];
      temperature_2m_mean: (number | null)[];
      et0_fao_evapotranspiration: (number | null)[];
    };
  };

  const numOrZero = (v: number | null | undefined) =>
    typeof v === "number" && Number.isFinite(v) ? v : 0;
  const sum = (arr: (number | null | undefined)[]) =>
    arr.reduce<number>((acc, v) => acc + numOrZero(v), 0);
  const mean = (arr: (number | null | undefined)[]) => {
    const valid = arr.filter(
      (v): v is number => typeof v === "number" && Number.isFinite(v),
    );
    return valid.length ? sum(valid) / valid.length : 0;
  };

  const totalPrecip = sum(data.daily.precipitation_sum);
  const totalET0 = sum(data.daily.et0_fao_evapotranspiration);
  const rainyDays = data.daily.precipitation_sum.filter(
    (v) => numOrZero(v) > 0.5,
  ).length;
  const mai = totalET0 > 0 ? totalPrecip / totalET0 : 0;

  return {
    startDate,
    endDate,
    days: data.daily.time.length,
    totalPrecipMm: parseFloat(totalPrecip.toFixed(2)),
    totalET0Mm: parseFloat(totalET0.toFixed(2)),
    rainyDays,
    meanTempC: parseFloat(mean(data.daily.temperature_2m_mean).toFixed(2)),
    meanMaxTempC: parseFloat(mean(data.daily.temperature_2m_max).toFixed(2)),
    moistureAdequacyIndex: parseFloat(mai.toFixed(3)),
    droughtSeverity: classifyDrought(mai),
    source: "open-meteo-archive",
    license: "CC-BY 4.0 (Open-Meteo / ERA5 / CHIRPS blend)",
  };
}

/**
 * Compute the same calendar window one year earlier (used as a "last
 * year" baseline) for comparison with the live rolling 30-day snapshot.
 */
export async function fetchYearOverYearClimate(
  lat = CLIMATE_LAT_DEFAULT,
  lon = CLIMATE_LON_DEFAULT,
  windowDays = 30,
): Promise<{
  current: HistoricalClimateWindow;
  lastYear: HistoricalClimateWindow;
  comparison: {
    precipDeltaMm: number;
    precipDeltaPct: number;
    tempDeltaC: number;
    severityShift: string;
    interpretation: string;
  };
}> {
  const today = new Date();
  const currentEnd = new Date(today);
  const currentStart = new Date(today);
  currentStart.setDate(currentStart.getDate() - windowDays);
  const lastYearEnd = new Date(currentEnd);
  lastYearEnd.setFullYear(lastYearEnd.getFullYear() - 1);
  const lastYearStart = new Date(currentStart);
  lastYearStart.setFullYear(lastYearStart.getFullYear() - 1);

  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  // Sequential rather than parallel — Open-Meteo Archive occasionally
  // throws ETIMEDOUT when two requests share the same TLS connection.
  const current = await fetchHistoricalClimateWindow(
    lat,
    lon,
    fmt(currentStart),
    fmt(currentEnd),
  );
  const lastYear = await fetchHistoricalClimateWindow(
    lat,
    lon,
    fmt(lastYearStart),
    fmt(lastYearEnd),
  );

  const precipDeltaMm = current.totalPrecipMm - lastYear.totalPrecipMm;
  const precipDeltaPct =
    lastYear.totalPrecipMm > 0
      ? parseFloat(((precipDeltaMm / lastYear.totalPrecipMm) * 100).toFixed(1))
      : 0;
  const tempDeltaC = parseFloat(
    (current.meanTempC - lastYear.meanTempC).toFixed(2),
  );
  const severityShift =
    current.droughtSeverity === lastYear.droughtSeverity
      ? "no change"
      : `${lastYear.droughtSeverity} → ${current.droughtSeverity}`;

  let interpretation: string;
  if (precipDeltaMm < -10) {
    interpretation = `Significantly drier than the same window last year (−${Math.abs(precipDeltaMm).toFixed(1)} mm). Pasture stress likely elevated.`;
  } else if (precipDeltaMm < -2) {
    interpretation = `Drier than last year (−${Math.abs(precipDeltaMm).toFixed(1)} mm). Monitor grazing pressure.`;
  } else if (precipDeltaMm > 10) {
    interpretation = `Wetter than last year (+${precipDeltaMm.toFixed(1)} mm). Conditions have improved.`;
  } else {
    interpretation = `Within ±2 mm of last year — no major climatic shift.`;
  }

  return {
    current,
    lastYear,
    comparison: {
      precipDeltaMm: parseFloat(precipDeltaMm.toFixed(2)),
      precipDeltaPct,
      tempDeltaC,
      severityShift,
      interpretation,
    },
  };
}

// ── Open-Meteo — air quality (PM2.5, PM10) ─────────────────────────────────

export interface AirQualitySnapshot {
  fetchedAt: string;
  wardCentre: { lat: number; lon: number };
  pm2_5UgM3: number;
  pm10UgM3: number;
  source: "open-meteo-air-quality";
  license: "CC-BY 4.0 (Open-Meteo / CAMS ensemble)";
}

/**
 * Open-Meteo Air Quality — CAMS-based PM2.5 and PM10. Useful for
 * dust-storm context during dry-season herder briefings ("the air is
 * bad today, stay close to water").
 */
export async function fetchAirQualitySnapshot(
  lat = CLIMATE_LAT_DEFAULT,
  lon = CLIMATE_LON_DEFAULT,
): Promise<AirQualitySnapshot> {
  const url = new URL("https://air-quality-api.open-meteo.com/v1/air-quality");
  url.searchParams.set("latitude", String(lat));
  url.searchParams.set("longitude", String(lon));
  url.searchParams.set("current", "pm10,pm2_5");
  url.searchParams.set("timezone", "Africa/Nairobi");

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 15_000);
  let res: Response;
  try {
    res = await fetch(url, { signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(
      `Open-Meteo Air Quality ${res.status}: ${text.slice(0, 200)}`,
    );
  }
  const data = (await res.json()) as {
    current: {
      pm10: number;
      pm2_5: number;
      time: string;
    };
  };
  return {
    fetchedAt: data.current.time ?? new Date().toISOString(),
    wardCentre: { lat, lon },
    pm2_5UgM3: parseFloat(data.current.pm2_5.toFixed(1)),
    pm10UgM3: parseFloat(data.current.pm10.toFixed(1)),
    source: "open-meteo-air-quality",
    license: "CC-BY 4.0 (Open-Meteo / CAMS ensemble)",
  };
}

// ── Microsoft Planetary Computer — STAC discovery ──────────────────────────

const PC_STAC = "https://planetarycomputer.microsoft.com/api/stac/v1/search";

export type PlanetaryComputerCollection =
  | "sentinel-2-l2a"
  | "modis-13Q1-061"
  | "jrc-gsw"
  | "smap-msl"
  | "chirps-daygrid-001";

export interface StacItemSummary {
  id: string;
  collection: PlanetaryComputerCollection;
  datetime: string | null;
  cloudCover: number | null;
  bbox: [number, number, number, number] | null;
  assets: string[];
}

/**
 * Search Microsoft Planetary Computer for satellite scenes over the
 * given bbox + date range. Returns a normalised list of items (no
 * asset downloads — discovery only). Asset signing would be a separate
 * step using the collection-level SAS token from
 * https://planetarycomputer.microsoft.com/api/sas/v1/token/<collection>.
 */
export async function discoverPlanetaryComputer(
  collection: PlanetaryComputerCollection,
  bbox: [number, number, number, number],
  startDate: string,
  endDate: string,
  options: { maxCloudCoverPct?: number; limit?: number } = {},
): Promise<{ collection: PlanetaryComputerCollection; count: number; items: StacItemSummary[]; license: string }> {
  const { maxCloudCoverPct, limit = 10 } = options;

  const body: Record<string, unknown> = {
    collections: [collection],
    bbox,
    datetime: `${startDate}/${endDate}`,
    limit,
  };
  if (collection === "sentinel-2-l2a" && maxCloudCoverPct !== undefined) {
    body["query"] = { "eo:cloud_cover": { lt: maxCloudCoverPct } };
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 25_000);
  let res: Response;
  try {
    res = await fetch(PC_STAC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(
      `Planetary Computer ${res.status}: ${text.slice(0, 200)}`,
    );
  }
  const data = (await res.json()) as {
    features: Array<{
      id: string;
      collection: string;
      properties: Record<string, unknown>;
      bbox?: [number, number, number, number];
      assets: Record<string, unknown>;
    }>;
  };

  const items: StacItemSummary[] = data.features.map((f) => {
    const cloud = f.properties["eo:cloud_cover"];
    return {
      id: f.id,
      collection: collection,
      datetime: (f.properties["datetime"] as string | null) ?? null,
      cloudCover: typeof cloud === "number" ? cloud : null,
      bbox: f.bbox ?? null,
      assets: Object.keys(f.assets),
    };
  });

  return {
    collection,
    count: items.length,
    items,
    license: "Microsoft Planetary Computer — various open licenses (CC-BY, CC0, etc.) per collection",
  };
}

/**
 * Discovery batch for the ward — useful for an "available satellite
 * scenes" widget on the dashboard.
 */
export async function discoverAllForWard(
  bbox: [number, number, number, number],
  lookbackDays = 60,
): Promise<
  Record<
    PlanetaryComputerCollection,
    { count: number; items: StacItemSummary[]; license: string }
  >
> {
  const endDate = new Date().toISOString().slice(0, 10);
  const start = new Date();
  start.setDate(start.getDate() - lookbackDays);
  const startDate = start.toISOString().slice(0, 10);

  const collections: PlanetaryComputerCollection[] = [
    "sentinel-2-l2a",
    "modis-13Q1-061",
    "jrc-gsw",
  ];
  const results = await Promise.all(
    collections.map((c) =>
      discoverPlanetaryComputer(c, bbox, startDate, endDate, {
        maxCloudCoverPct: c === "sentinel-2-l2a" ? 30 : undefined,
        limit: 5,
      }),
    ),
  );
  const out = {} as Record<
    PlanetaryComputerCollection,
    { count: number; items: StacItemSummary[]; license: string }
  >;
  for (const r of results) {
    out[r.collection] = {
      count: r.count,
      items: r.items,
      license: r.license,
    };
  }
  return out;
}

// ── Source registry — for the `/api/open-data/sources` discovery endpoint ──

/**
 * Per-county aggregates for the dashboard's choropleth.
 *
 * Returns a Map of county name → numeric value for the chosen metric.
 * Counties without data are NOT included in the map (the client
 * renders them gray with a "no data" tooltip).
 *
 * Today every demo tenant sits inside Isiolo County, so the
 * tenant-scoped path returns just one county ("ISIOLO"). The admin
 * role (which can read across tenants via the admin_users table —
 * same DB, no RLS on admin_users) gets a national roll-up that
 * reflects the seeded data across all three wards.
 */

export interface PerCountyAggregate {
  byCounty: Record<string, number | null>;
  unit: string;
  description: string;
}

// ── Time-slice presets ───────────────────────────────────────────────────

export type TimeSlice =
  | "live" // last 24h
  | "7d"
  | "30d"
  | "90d"
  | "1y"
  | "all";

export const TIME_SLICE_LABELS: Record<TimeSlice, string> = {
  live: "Live (24h)",
  "7d": "Past 7 days",
  "30d": "Past 30 days",
  "90d": "Past 90 days",
  "1y": "Past year",
  all: "All time",
};

export function timeSliceStart(slice: TimeSlice): Date | null {
  const now = Date.now();
  switch (slice) {
    case "live":
      return new Date(now - 24 * 60 * 60 * 1000);
    case "7d":
      return new Date(now - 7 * 24 * 60 * 60 * 1000);
    case "30d":
      return new Date(now - 30 * 24 * 60 * 60 * 1000);
    case "90d":
      return new Date(now - 90 * 24 * 60 * 60 * 1000);
    case "1y":
      return new Date(now - 365 * 24 * 60 * 60 * 1000);
    case "all":
      return null;
  }
}

// ── Time-slice presets ───────────────────────────────────────────────────

/**
 * Compute per-county aggregates for the given metric + time slice.
 * 
 * Scoped to the caller's tenant unless the caller has the admin role
 * (in which case we roll up across all 3 demo tenants). Each tenant
 * has data in Isiolo County (the home county of all three wards),
 * so the "byCounty" map always has at most one entry.
 *
 * Future: per-tenant counties can be added by storing the tenant's
 * county in the tenants table; for the demo we map every tenant to
 * ISIOLO and use admin mode to roll up.
 */
export async function computePerCountyAggregates(
  tenantId: string,
  metric: string,
  slice: TimeSlice = "30d",
): Promise<PerCountyAggregate> {
  const wantsAdmin = tenantId === "admin"; // sentinel — see auth.ts
  const tenantIds = wantsAdmin
    ? ["bula-pesa", "garbatulla", "merti"]
    : [tenantId];
  const since = timeSliceStart(slice);

  switch (metric) {
    case "reports": {
      const out: Record<string, number> = { ISIOLO: 0 };
      for (const t of tenantIds) {
        const rows = await withTenantContext(t, async (tx) => {
          const q = tx
            .select({ n: count() })
            .from(groundTruthReportsTable);
          return since ? q.where(gte(groundTruthReportsTable.createdAt, since)) : q;
        });
        out["ISIOLO"] = (out["ISIOLO"] ?? 0) + Number(rows[0]?.n ?? 0);
      }
      return {
        byCounty: out,
        unit: "reports",
        description: `Ground-truth reports in the ${TIME_SLICE_LABELS[slice]} window. Counties without source data are omitted.`,
      };
    }
    case "bcs": {
      const out: Record<string, number | null> = { ISIOLO: null };
      let sum = 0;
      let n = 0;
      for (const t of tenantIds) {
        const rows = await withTenantContext(t, async (tx) => {
          const q = tx
            .select({ v: avg(groundTruthReportsTable.bcsScore) })
            .from(groundTruthReportsTable);
          return since ? q.where(gte(groundTruthReportsTable.createdAt, since)) : q;
        });
        const v = Number(rows[0]?.v ?? 0);
        if (v > 0) {
          sum += v;
          n += 1;
        }
      }
      out["ISIOLO"] = n > 0 ? parseFloat((sum / n).toFixed(2)) : null;
      return {
        byCounty: out,
        unit: "BCS (1-5)",
        description: `Average Body Condition Score in the ${TIME_SLICE_LABELS[slice]} window (1=emaciated, 5=fat).`,
      };
    }
    case "ndvi": {
      const out: Record<string, number | null> = { ISIOLO: null };
      let sum = 0;
      let n = 0;
      for (const t of tenantIds) {
        const rows = await withTenantContext(t, async (tx) => {
          const q = tx
            .select({ v: avg(groundTruthReportsTable.ndviVsBaselinePercent) })
            .from(groundTruthReportsTable);
          return since ? q.where(gte(groundTruthReportsTable.createdAt, since)) : q;
        });
        const v = Number(rows[0]?.v ?? 0);
        if (v !== 0) {
          sum += v;
          n += 1;
        }
      }
      out["ISIOLO"] = n > 0 ? parseFloat((sum / n).toFixed(1)) : null;
      return {
        byCounty: out,
        unit: "% vs 11-yr baseline",
        description: `Mean NDVI delta vs 11-year baseline (negative = stress) in the ${TIME_SLICE_LABELS[slice]} window.`,
      };
    }
    case "herd": {
      // Herd is "as of now" — a count of registered pastoralists, not
      // bounded by the time slice. The slice still applies to the
      // description so the UI can label what the panel means.
      const out: Record<string, number> = { ISIOLO: 0 };
      for (const t of tenantIds) {
        const rows = await withTenantContext(t, async (tx) =>
          tx
            .select({
              cattle: sql<number>`COALESCE(SUM(${pastoralistsTable.cattle}), 0)`,
              goats: sql<number>`COALESCE(SUM(${pastoralistsTable.goats}), 0)`,
              camels: sql<number>`COALESCE(SUM(${pastoralistsTable.camels}), 0)`,
            })
            .from(pastoralistsTable),
        );
        const r = rows[0];
        const total =
          Number(r?.cattle ?? 0) +
          Number(r?.goats ?? 0) +
          Number(r?.camels ?? 0);
        out["ISIOLO"] = (out["ISIOLO"] ?? 0) + total;
      }
      return {
        byCounty: out,
        unit: "animals",
        description:
          "Total registered herd size (cattle + goats + camels) per county.",
      };
    }
    default:
      return {
        byCounty: { ISIOLO: null },
        unit: "?",
        description: `Unknown metric '${metric}'`,
      };
  }
}

// ── County presets & insights ────────────────────────────────────────────

/**
 * Counties the choropleth is allowed to render. We deliberately do NOT
 * render all 48 — that produces a "huge, unreadable" map. The dashboard
 * presents two groups:
 *
 *   - **Pastoral demo** — always visible, always-on the map. Every
 *     demo tenant lives in one of these counties. (Bula Pesa, Garbatulla
 *     and Merti are all wards of Isiolo County, so for the demo we
 *     surface Isiolo as the home county.)
 *   - **Main reference** — selectable. The operator toggles these
 *     to set the comparison set. Nairobi is the canonical urban
 *     reference; Mombasa / Kisumu / Nakuru / Eldoret / Kakamega round
 *     out a representative cross-section of Kenya's diverse climates.
 */
export interface CountyPreset {
  name: string;
  displayName: string;
  group: "pastoral" | "main";
  /** Short rationale shown in the UI. */
  why: string;
}

export const COUNTY_PRESETS: CountyPreset[] = [
  { name: "ISIOLO", displayName: "Isiolo", group: "pastoral",
    why: "Bula Pesa · Garbatulla · Merti — all three demo wards sit here." },
  { name: "NAIROBI", displayName: "Nairobi", group: "main",
    why: "Urban reference (cool, green, high livestock density)." },
  { name: "MOMBASA", displayName: "Mombasa", group: "main",
    why: "Coastal — wetter climate, contrast for pastoral drylands." },
  { name: "KISUMU", displayName: "Kisumu", group: "main",
    why: "Lake Victoria basin — humid, intense rainfall." },
  { name: "NAKURU", displayName: "Nakuru", group: "main",
    why: "Rift Valley — mixed agro-pastoral, key transit county." },
  { name: "ELDORET", displayName: "Eldoret (Uasin Gishu)", group: "main",
    why: "Uasin Gishu — highland maize belt, contrast altitude." },
  { name: "KAKAMEGA", displayName: "Kakamega", group: "main",
    why: "Western — high rainfall, dense smallholder farming." },
  { name: "MARSABIT", displayName: "Marsabit", group: "main",
    why: "Pastoral neighbour to Isiolo — direct comparator." },
  { name: "SAMBURU", displayName: "Samburu", group: "main",
    why: "Pastoral neighbour to Isiolo — direct comparator." },
  { name: "LAIKIPIA", displayName: "Laikipia", group: "main",
    why: "Pastoral rangeland north of the equator — direct comparator." },
];

export const DEFAULT_MAIN_COUNTIES: string[] = [
  "NAIROBI", "MARSABIT", "SAMBURU",
];

/**
 * Auto-generated insights for the current selection. Returns 3-5
 * plain-English bullets comparing the selected counties.
 *
 * For now every insight is computed deterministically from the
 * aggregates + the year-over-year climate data. In the future we
 * can route this through the LLM layer too.
 */
export async function computeInsights(
  tenantId: string,
  slice: TimeSlice,
  selectedCounties: string[],
): Promise<{ bullets: string[]; generatedAt: string }> {
  const bullets: string[] = [];
  // Pull the four metrics in parallel.
  const [reports, bcs, ndvi, herd, yoy] = await Promise.all([
    computePerCountyAggregates(tenantId, "reports", slice),
    computePerCountyAggregates(tenantId, "bcs", slice),
    computePerCountyAggregates(tenantId, "ndvi", slice),
    computePerCountyAggregates(tenantId, "herd", slice),
    fetchYearOverYearClimate().catch(() => null),
  ]);

  const isioloReports = reports.byCounty["ISIOLO"] ?? 0;
  if (isioloReports > 0) {
    bullets.push(
      `${isioloReports} ground-truth report${isioloReports === 1 ? "" : "s"} from Isiolo in the ${TIME_SLICE_LABELS[slice]} window.`,
    );
  } else {
    bullets.push(
      `No ground-truth reports from Isiolo in the ${TIME_SLICE_LABELS[slice]} window — coverage may have dropped.`,
    );
  }

  const isioloBcs = bcs.byCounty["ISIOLO"];
  if (isioloBcs != null) {
    const verdict =
      isioloBcs < 2.5
        ? "emaciated — urgent supplemental feeding advised"
        : isioloBcs < 3
          ? "below average — monitor grazing pressure"
          : "within healthy range";
    bullets.push(
      `Isiolo average BCS is ${isioloBcs.toFixed(2)} (${verdict}).`,
    );
  }

  const isioloNdvi = ndvi.byCounty["ISIOLO"];
  if (isioloNdvi != null) {
    const stress =
      isioloNdvi <= -30
        ? "critical stress"
        : isioloNdvi <= -15
          ? "high stress"
          : isioloNdvi <= -5
            ? "mild stress"
            : "near baseline";
    bullets.push(
      `Isiolo NDVI is ${isioloNdvi >= 0 ? "+" : ""}${isioloNdvi.toFixed(1)}% vs the 11-year baseline (${stress}).`,
    );
  }

  const isioloHerd = herd.byCounty["ISIOLO"] ?? 0;
  if (isioloHerd > 0) {
    bullets.push(
      `Isiolo registered herd totals ${isioloHerd.toLocaleString()} animals across cattle, goats and camels.`,
    );
  }

  if (yoy) {
    bullets.push(
      `Climate in the ${TIME_SLICE_LABELS[slice]} window vs the same dates last year: ${yoy.comparison.interpretation}`,
    );
  }

  // Comparison hint: if the operator added main counties we tell them
  // those don't have direct ground-truth data and what that means.
  const mainCounties = selectedCounties.filter(
    (c) => c !== "ISIOLO" && reports.byCounty[c] == null,
  );
  if (mainCounties.length > 0) {
    bullets.push(
      `${mainCounties.join(", ")} ${mainCounties.length === 1 ? "is" : "are"} reference counties — they have no ArdaLink ground-truth reports, so per-county metrics will show 'no data'. Year-over-year climate applies to Isiolo only today; per-county climate will land in Q3 once we wire the planetary-computer NDVI ingest.`,
    );
  }

  return {
    bullets: bullets.slice(0, 5),
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Severity ranking across selected counties for the active metric.
 * Returns each county's normalised value (0–1) plus a human label
 * so the dashboard can render a horizontal bar chart.
 */
export async function computeRankings(
  tenantId: string,
  metric: string,
  slice: TimeSlice,
  selectedCounties: string[],
): Promise<{
  metric: string;
  unit: string;
  slice: TimeSlice;
  rows: Array<{ county: string; value: number | null; rank: number; normalised: number }>;
}> {
  const agg = await computePerCountyAggregates(tenantId, metric, slice);
  // Each selected county gets a row; counties without data show null.
  const values = selectedCounties.map((c) => ({
    county: c,
    value: agg.byCounty[c] ?? null,
  }));

  // Compute normalised 0..1 — for "lower is worse" metrics (NDVI delta,
  // BCS, mortality) we sort ascending; for "higher is worse" metrics
  // (reports, herd) we sort descending. For now we treat NDVI specially.
  const ordered = [...values];
  if (metric === "ndvi") {
    // Want lowest (most stressed) at rank 1
    ordered.sort((a, b) => {
      if (a.value == null && b.value == null) return 0;
      if (a.value == null) return 1;
      if (b.value == null) return -1;
      return a.value - b.value;
    });
  } else if (metric === "bcs") {
    ordered.sort((a, b) => {
      if (a.value == null && b.value == null) return 0;
      if (a.value == null) return 1;
      if (b.value == null) return -1;
      // Lower BCS is worse, so lower first.
      return a.value - b.value;
    });
  } else {
    // reports, herd — higher means more activity, sort desc
    ordered.sort((a, b) => {
      if (a.value == null && b.value == null) return 0;
      if (a.value == null) return 1;
      if (b.value == null) return -1;
      return b.value - a.value;
    });
  }

  // Compute normalisation: scale by min/max within the row set.
  const numericVals = ordered
    .map((r) => r.value)
    .filter((v): v is number => v != null);
  const lo = numericVals.length ? Math.min(...numericVals) : 0;
  const hi = numericVals.length ? Math.max(...numericVals) : 1;
  const range = hi - lo || 1;

  return {
    metric,
    unit: agg.unit,
    slice,
    rows: ordered.map((r, i) => ({
      county: r.county,
      value: r.value,
      rank: i + 1,
      normalised:
        r.value == null ? 0 : Math.max(0, Math.min(1, (r.value - lo) / range)),
    })),
  };
}

/**
 * Active alert markers for the choropleth's pulsing alert overlay.
 * Returns one entry per mortality_critical report in the time slice,
 * bucketed to Isiolo for the demo.
 */
export async function computeAlertMarkers(
  tenantId: string,
  slice: TimeSlice,
): Promise<
  Array<{
    id: number;
    county: string;
    severity: "red" | "yellow";
    kind: string;
    message: string;
    quadrant: string | null;
    createdAt: string;
  }>
> {
  const wantsAdmin = tenantId === "admin";
  const tenantIds = wantsAdmin
    ? ["bula-pesa", "garbatulla", "merti"]
    : [tenantId];
  const since = timeSliceStart(slice);
  const out: Array<{
    id: number;
    county: string;
    severity: "red" | "yellow";
    kind: string;
    message: string;
    quadrant: string | null;
    createdAt: string;
  }> = [];
  for (const t of tenantIds) {
    const rows = await withTenantContext(t, async (tx) => {
      const q = tx
        .select({
          id: groundTruthReportsTable.id,
          createdAt: groundTruthReportsTable.createdAt,
          bcsScore: groundTruthReportsTable.bcsScore,
          mortalityRate: groundTruthReportsTable.mortalityRate,
          waterPointStatus: groundTruthReportsTable.waterPointStatus,
          waterPointName: groundTruthReportsTable.waterPointName,
          reportedLocation: groundTruthReportsTable.reportedLocation,
          reportedQuadrant: groundTruthReportsTable.reportedQuadrant,
        })
        .from(groundTruthReportsTable);
      return since
        ? q.where(gte(groundTruthReportsTable.createdAt, since))
        : q;
    });
    for (const r of rows) {
      if (r.bcsScore != null && r.bcsScore <= 2) {
        out.push({
          id: r.id,
          county: "ISIOLO",
          severity: "red",
          kind: "bcs_critical",
          message: `Animals reported emaciated (BCS ${r.bcsScore.toFixed(1)})`,
          quadrant: r.reportedQuadrant ?? null,
          createdAt: r.createdAt.toISOString(),
        });
      }
      if (r.mortalityRate === "4-plus") {
        out.push({
          id: r.id,
          county: "ISIOLO",
          severity: "red",
          kind: "mortality_critical",
          message: "4+ animal deaths reported",
          quadrant: r.reportedQuadrant ?? null,
          createdAt: r.createdAt.toISOString(),
        });
      }
      if (r.waterPointStatus === "dry" || r.waterPointStatus === "not_operational") {
        out.push({
          id: r.id,
          county: "ISIOLO",
          severity: "yellow",
          kind: "water_point_broken",
          message: `Water point ${r.waterPointName ?? "(unnamed)"} — ${r.waterPointStatus === "dry" ? "dry" : "not operational"}`,
          quadrant: r.reportedQuadrant ?? null,
          createdAt: r.createdAt.toISOString(),
        });
      }
    }
  }
  return out;
}

export interface OpenDataSourceInfo {
  id: string;
  name: string;
  baseUrl: string;
  auth: "none" | "optional" | "required" | string;
  attribution: string;
  whatItGives: string;
  integratedAsOf: string;
}

/**
 * Static manifest of every open-source data provider the system
 * touches. Surfaced via `/api/open-data/sources` so the dashboard
 * can render an "Open data sources" panel and the engineering
 * team can audit what feeds what.
 */
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
