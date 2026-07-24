/**
 * Supabase client for ArdaLink.
 *
 * Supabase is now the **source of truth** for reference data (wards,
 * satellite_indices, weather_data, ward_neighbors, ward_cells) AND
 * operational data (pastoralists, ground_truth_calls) — with our local
 * Postgres kept as a resilient backup mirror. Reads try Supabase first
 * and fall back to local; writes go to Supabase primary + local backup.
 *
 * The connection is HTTP-only (PostgREST via `${SUPABASE_URL}/rest/v1/`)
 * so we don't need to open a second Postgres pool. The service-role /
 * secret key must never reach the browser — every call goes through
 * ardalink-api.
 *
 * We keep a small in-process cache for reference-table reads (wards,
 * views) since those change slowly. Operational reads (pastoralist
 * lookup by phone) always hit the wire.
 */

import { logger } from "./logger.js";
import {
  mirrorLeadInteraction,
  mirrorPastoralistLead,
  mirrorWeatherData,
} from "./localMirror.js";
import { type InsertLeadInteraction } from "@workspace/db";

const CACHE_TTL_MS = parseInt(
  process.env.SUPABASE_CACHE_TTL_MS ?? "60000",
  10,
);

// Two-tier timeouts. USSD sessions have a ~10 s AT budget end-to-end
// and voice openers must return before AT plays the "no key received"
// fallback, so herder-facing paths use a tight `interactive` timeout
// and fall through to the local mirror without blocking the response.
// Backend jobs (dashboards, schedulers, sync workers) use the longer
// `batch` timeout since a few extra seconds don't hurt them.
const TIMEOUT_INTERACTIVE_MS = parseInt(
  process.env.SUPABASE_TIMEOUT_INTERACTIVE_MS ?? "2500",
  10,
);
const TIMEOUT_BATCH_MS = parseInt(
  process.env.SUPABASE_TIMEOUT_BATCH_MS ?? "8000",
  10,
);

export type SupabaseMode = "interactive" | "batch";
const DEFAULT_MODE: SupabaseMode = "interactive";

interface SupabaseCfg {
  base: string;
  key: string;
}

export function isSupabaseConfigured(): boolean {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SECRET_KEY);
}

function cfg(): SupabaseCfg {
  const base = (process.env.SUPABASE_URL ?? "").trim().replace(/\/$/, "");
  const key = (process.env.SUPABASE_SECRET_KEY ?? "").trim();
  if (!base || !key) {
    throw new Error(
      "SUPABASE_URL and SUPABASE_SECRET_KEY must be set to use the Supabase client",
    );
  }
  return { base, key };
}

interface CacheEntry {
  value: unknown;
  expiresAt: number;
}
const cache = new Map<string, CacheEntry>();

async function sbFetch(
  path: string,
  init: RequestInit & { sbMode?: SupabaseMode } = {},
): Promise<Response> {
  const { base, key } = cfg();
  const url = `${base}/rest/v1/${path.replace(/^\/+/, "")}`;
  const mode = init.sbMode ?? DEFAULT_MODE;
  const timeoutMs =
    mode === "batch" ? TIMEOUT_BATCH_MS : TIMEOUT_INTERACTIVE_MS;
  return fetch(url, {
    ...init,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(init.headers as Record<string, string> | undefined),
    },
    signal: init.signal ?? AbortSignal.timeout(timeoutMs),
  });
}

/**
 * GET helper. When `cache=true` the response is memoised for
 * `CACHE_TTL_MS`. Returns `null` on 5xx / network failure so callers
 * can fall back to the local Postgres mirror.
 */
async function sbGet<T>(
  path: string,
  opts: { cache?: boolean; mode?: SupabaseMode } = {},
): Promise<T[] | null> {
  if (opts.cache) {
    const hit = cache.get(path);
    if (hit && hit.expiresAt > Date.now()) return hit.value as T[];
  }
  try {
    const res = await sbFetch(path, { sbMode: opts.mode });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logger.warn(
        { status: res.status, path, body: body.slice(0, 200) },
        "[Supabase] GET non-2xx — falling back",
      );
      return null;
    }
    const data = (await res.json()) as T[];
    if (opts.cache) {
      cache.set(path, { value: data, expiresAt: Date.now() + CACHE_TTL_MS });
    }
    return data;
  } catch (err) {
    logger.warn({ err, path }, "[Supabase] GET failed — falling back");
    return null;
  }
}

/**
 * POST an insert. Uses `Prefer: return=representation` so we get the
 * inserted row back. Returns `null` on failure so callers can log and
 * carry on with the local write.
 */
async function sbInsert<T>(
  table: string,
  row: Record<string, unknown>,
  opts: { mode?: SupabaseMode } = {},
): Promise<T | null> {
  try {
    const res = await sbFetch(table, {
      method: "POST",
      body: JSON.stringify(row),
      headers: { Prefer: "return=representation" },
      sbMode: opts.mode,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logger.warn(
        { status: res.status, table, body: body.slice(0, 300) },
        "[Supabase] INSERT non-2xx — local backup still saved",
      );
      return null;
    }
    const rows = (await res.json()) as T[];
    return rows[0] ?? null;
  } catch (err) {
    logger.warn({ err, table }, "[Supabase] INSERT failed");
    return null;
  }
}

// ── Typed row shapes ──────────────────────────────────────────────────────

export interface SbWard {
  ward_id: string;
  name: string;
  county: string;
  centroid: { type: "Point"; coordinates: [number, number] } | null;
  created_at: string;
}

export interface SbWardWithGeometry extends SbWard {
  geometry:
    | {
        type: "MultiPolygon";
        coordinates: number[][][][];
      }
    | null;
}

export interface SbWardNeighbor {
  ward_id: string;
  neighbor_ward_id: string;
  shared_boundary_km: number;
}

export interface SbLatestSatelliteIndex {
  ward_id: string;
  period_start: string;
  period_end: string;
  calendar_month: number;
  calendar_year: number;
  ndvi_mean: number | null;
  ndre_mean: number | null;
  vci_value: number | null;
  prosopis_share: number | null;
  source_collection: string | null;
  updated_at: string;
}

export interface SbLatestWeather {
  ward_id: string;
  observed_date: string;
  rainfall_mm_30d: number | null;
  humidity_pct: number | null;
  temperature_c: number | null;
  evapotranspiration_mm: number | null;
  source: string | null;
  updated_at: string;
}

export interface SbPastoralist {
  pastoralist_id: string;
  full_name: string | null;
  phone_number: string | null;
  preferred_language: string | null;
  cbo_referral: string | null;
  herd_size: number | null;
  ward_id: string | null;
  location_text: string | null;
  created_at: string;
  updated_at: string;
}

export interface SbCallContext {
  pastoralist_id: string;
  full_name: string | null;
  phone_number: string | null;
  preferred_language: string | null;
  ward_id: string | null;
  ward_name: string | null;
  ndvi_mean: number | null;
  ndre_mean: number | null;
  vci_value: number | null;
  prosopis_share: number | null;
  rainfall_mm_30d: number | null;
  humidity_pct: number | null;
  temperature_c: number | null;
  evapotranspiration_mm: number | null;
  weather_observed_date: string | null;
  satellite_period_end: string | null;
}

/**
 * Read shape of Supabase `ground_truth_calls`. Nullable everywhere except
 * the columns Supabase's schema requires (call_id, pastoralist_id,
 * ward_id, call_timestamp). We pull pastoralist phone + name via
 * PostgREST's embedded-select syntax on public helpers below.
 */
export interface SbGroundTruthCallRead {
  call_id: string;
  pastoralist_id: string;
  ward_id: string;
  call_timestamp: string;
  bcs_score: number | null;
  mortality_rate: number | null;
  offtake_rate: number | null;
  water_point_status: string | null;
  milk_production_liters: number | null;
  water_trek_distance_km: number | null;
  supplementary_feeding: boolean | null;
  trust_score: number | null;
  source_language: string | null;
  transcript: string | null;
  created_at: string;
  // Embedded pastoralist (via `pastoralists(...)` select in PostgREST)
  pastoralists?: {
    phone_number: string | null;
    full_name: string | null;
    preferred_language: string | null;
    ward_id: string | null;
  } | null;
}

export interface SbGroundTruthCallInsert {
  pastoralist_id?: string | null;
  ward_id?: string | null;
  call_timestamp?: string;
  bcs_score?: number | null;
  mortality_rate?: number | null;
  offtake_rate?: number | null;
  water_point_status?: string | null;
  milk_production_liters?: number | null;
  water_trek_distance_km?: number | null;
  supplementary_feeding?: boolean | null;
  trust_score?: number | null;
  source_language?: string | null;
  transcript?: string | null;
}

// ── Public typed helpers ──────────────────────────────────────────────────

/** All wards, cached. Reference data. */
export const listWards = (mode: SupabaseMode = "interactive") =>
  sbGet<SbWard>(
    "wards?select=ward_id,name,county,centroid,created_at&order=ward_id.asc",
    { cache: true, mode },
  );

/** Active/finished wards only (view). Cached. */
export const listActiveWards = (mode: SupabaseMode = "interactive") =>
  sbGet<SbWard>(
    "active_wards?select=ward_id,name,county,centroid,created_at&order=ward_id.asc",
    { cache: true, mode },
  );

/**
 * Active wards WITH the full MultiPolygon geometry — 5 rows total, each
 * with hundreds of coordinate pairs. Cached because ward boundaries
 * don't change. Batch mode by default (dashboard, not USSD).
 */
export const listActiveWardsWithGeometry = (
  mode: SupabaseMode = "batch",
) =>
  sbGet<SbWardWithGeometry>(
    "active_wards?select=ward_id,name,county,centroid,geometry,created_at&order=ward_id.asc",
    { cache: true, mode },
  );

/** Neighbors of a ward. Cached. */
export const listWardNeighbors = (
  wardId: string,
  mode: SupabaseMode = "interactive",
) =>
  sbGet<SbWardNeighbor>(
    `ward_neighbors?ward_id=eq.${encodeURIComponent(wardId)}&select=ward_id,neighbor_ward_id,shared_boundary_km&order=shared_boundary_km.desc`,
    { cache: true, mode },
  );

/**
 * Best-scoring neighboring ward for cross-ward advice.
 *
 * Combines `ward_neighbors` (adjacency) with `api_latest_satellite_indices`
 * (NDVI) so the deterministic voice opener can say "in your neighbor
 * Wabera, NDVI is higher — consider moving that way". Returns null if
 * we can't beat the caller's own ward by `minNdviDelta` (default +0.1).
 *
 * All queries are cached and use interactive mode so the herder-facing
 * opener stays under AT's timeout budget.
 */
export interface SbNeighborAdvice {
  wardId: string;
  wardName: string | null;
  ndviMean: number;
  ndviDelta: number;
  sharedBoundaryKm: number;
}

export async function bestNeighborForAdvice(
  callerWardId: string,
  callerNdvi: number | null,
  minNdviDelta = 0.1,
): Promise<SbNeighborAdvice | null> {
  if (callerNdvi == null) return null;
  const neighbors = await listWardNeighbors(callerWardId);
  if (!neighbors || neighbors.length === 0) return null;

  // Pull neighbor NDVI + ward name in parallel. Each of these is
  // individually cached so back-to-back calls for the same ward
  // don't re-hit Supabase.
  const results = await Promise.all(
    neighbors.map(async (n) => {
      const [sat, ward] = await Promise.all([
        latestSatelliteFor(n.neighbor_ward_id),
        sbGet<SbWard>(
          `wards?ward_id=eq.${encodeURIComponent(n.neighbor_ward_id)}&select=ward_id,name,county,centroid,created_at&limit=1`,
          { cache: true },
        ),
      ]);
      const ndvi = sat?.ndvi_mean ?? null;
      const delta = ndvi != null ? ndvi - callerNdvi : null;
      return {
        wardId: n.neighbor_ward_id,
        wardName: ward?.[0]?.name ?? null,
        ndviMean: ndvi,
        ndviDelta: delta,
        sharedBoundaryKm: n.shared_boundary_km,
      };
    }),
  );

  // Only surface a neighbor when NDVI is meaningfully higher — otherwise
  // the "consider moving" line is noise. Pick the biggest improvement.
  let best: SbNeighborAdvice | null = null;
  for (const r of results) {
    if (r.ndviDelta == null || r.ndviMean == null) continue;
    if (r.ndviDelta < minNdviDelta) continue;
    if (best == null || r.ndviDelta > best.ndviDelta) {
      best = {
        wardId: r.wardId,
        wardName: r.wardName,
        ndviMean: r.ndviMean,
        ndviDelta: r.ndviDelta,
        sharedBoundaryKm: r.sharedBoundaryKm,
      };
    }
  }
  return best;
}

/** Latest ward-level satellite indices. Cached. */
export const latestSatelliteFor = async (
  wardId: string,
  mode: SupabaseMode = "interactive",
): Promise<SbLatestSatelliteIndex | null> => {
  const rows = await sbGet<SbLatestSatelliteIndex>(
    `api_latest_satellite_indices?ward_id=eq.${encodeURIComponent(wardId)}&limit=1`,
    { cache: true, mode },
  );
  return rows?.[0] ?? null;
};

// ── Historical baseline (per-ward, per-month percentile envelope) ──────

/**
 * Statistical summary of a ward's NDVI/NDRE history for one calendar
 * month, computed from Supabase `satellite_indices` rows going back to
 * 2015. This IS the baseline the deterministic opener anchors real
 * anomaly claims against — "driest June since 2017", "VCI 12/100",
 * "below the 15th percentile of the last 10 Junes".
 *
 * Returns `null` when fewer than 3 non-null historical values exist —
 * you can't meaningfully call P5/P95 on 2 points. Callers should treat
 * `null` as "no baseline yet, fall back to a static threshold".
 */
export interface WardMonthlyBaseline {
  wardId: string;
  month: number; // 1..12
  years: number; // count of non-null NDVI values used
  yearsSpan: [number, number]; // [firstYear, lastYear]
  ndvi: {
    min: number;
    max: number;
    p5: number;
    p25: number;
    p50: number;
    p75: number;
    p95: number;
    mean: number;
    stdev: number;
    minYear: number;
    maxYear: number;
  };
  ndre: {
    p50: number;
    mean: number;
  } | null;
}

// Baselines shift at monthly cadence, not per-request. A day is fine.
const BASELINE_TTL_MS = 24 * 60 * 60 * 1000;

function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  if (sorted.length === 1) return sorted[0]!;
  const idx = (sorted.length - 1) * q;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo);
}

/**
 * Fetch historical `satellite_indices` for one ward/month and compute
 * the percentile envelope + record-year metadata. Cached for 24 h.
 *
 * Cache is separate from the generic `sbGet` cache so we can hold it
 * for a full day without polluting the short-TTL general cache.
 */
const baselineCache = new Map<
  string,
  { value: WardMonthlyBaseline | null; expiresAt: number }
>();

export async function fetchWardMonthlyBaseline(
  wardId: string,
  month: number,
  opts: { mode?: SupabaseMode; excludeCurrentYear?: boolean } = {},
): Promise<WardMonthlyBaseline | null> {
  const currentYear = new Date().getUTCFullYear();
  const cacheKey = `${wardId}:${month}:${opts.excludeCurrentYear !== false ? currentYear : "incl"}`;
  const hit = baselineCache.get(cacheKey);
  if (hit && hit.expiresAt > Date.now()) return hit.value;

  // Historical baseline should EXCLUDE the current year's reading so a
  // caller comparing "today vs history" isn't comparing to themselves.
  // Callers who want the raw envelope including the current year can
  // pass excludeCurrentYear=false.
  const excludeFilter =
    opts.excludeCurrentYear === false
      ? ""
      : `&calendar_year=lt.${currentYear}`;
  const path =
    `satellite_indices?ward_id=eq.${encodeURIComponent(wardId)}` +
    `&calendar_month=eq.${month}` +
    excludeFilter +
    `&select=calendar_year,ndvi_mean,ndre_mean` +
    `&order=calendar_year.asc`;

  interface Row {
    calendar_year: number;
    ndvi_mean: number | null;
    ndre_mean: number | null;
  }
  const rows = await sbGet<Row>(path, { mode: opts.mode ?? "batch" });
  if (!rows) {
    baselineCache.set(cacheKey, {
      value: null,
      expiresAt: Date.now() + 60_000, // short retry on failure
    });
    return null;
  }

  const ndviPairs = rows
    .filter((r): r is Row & { ndvi_mean: number } => r.ndvi_mean != null)
    .map((r) => ({ year: r.calendar_year, ndvi: r.ndvi_mean }));
  if (ndviPairs.length < 3) {
    baselineCache.set(cacheKey, {
      value: null,
      expiresAt: Date.now() + BASELINE_TTL_MS,
    });
    return null;
  }

  const ndviValues = ndviPairs.map((p) => p.ndvi).sort((a, b) => a - b);
  const mean = ndviValues.reduce((s, v) => s + v, 0) / ndviValues.length;
  const variance =
    ndviValues.reduce((s, v) => s + (v - mean) ** 2, 0) /
    Math.max(1, ndviValues.length - 1);
  const minPair = ndviPairs.reduce((a, b) => (a.ndvi <= b.ndvi ? a : b));
  const maxPair = ndviPairs.reduce((a, b) => (a.ndvi >= b.ndvi ? a : b));

  const ndreValues = rows
    .map((r) => r.ndre_mean)
    .filter((v): v is number => v != null)
    .sort((a, b) => a - b);
  const ndre =
    ndreValues.length >= 3
      ? {
          p50: percentile(ndreValues, 0.5),
          mean:
            ndreValues.reduce((s, v) => s + v, 0) / ndreValues.length,
        }
      : null;

  const baseline: WardMonthlyBaseline = {
    wardId,
    month,
    years: ndviPairs.length,
    yearsSpan: [
      ndviPairs[0]!.year,
      ndviPairs[ndviPairs.length - 1]!.year,
    ],
    ndvi: {
      min: ndviValues[0]!,
      max: ndviValues[ndviValues.length - 1]!,
      p5: percentile(ndviValues, 0.05),
      p25: percentile(ndviValues, 0.25),
      p50: percentile(ndviValues, 0.5),
      p75: percentile(ndviValues, 0.75),
      p95: percentile(ndviValues, 0.95),
      mean,
      stdev: Math.sqrt(variance),
      minYear: minPair.year,
      maxYear: maxPair.year,
    },
    ndre,
  };
  baselineCache.set(cacheKey, {
    value: baseline,
    expiresAt: Date.now() + BASELINE_TTL_MS,
  });
  return baseline;
}

// ── Anomaly helpers (pure functions, exercised by baseline consumers) ──

/**
 * Vegetation Condition Index — the classical drought indicator.
 * Normalises the current NDVI against the historical min/max for the
 * same calendar month at the same ward. Returns 0..100.
 *
 *   VCI = 100 * (current - min) / (max - min)
 *
 * 0  = worst month on record
 * 50 = median for this month
 * 100 = best month on record
 *
 * Returns null when the range is degenerate (min==max), which happens
 * on very short baselines and would divide by zero otherwise.
 */
export function computeVci(
  current: number | null | undefined,
  baseline: WardMonthlyBaseline | null,
): number | null {
  if (current == null || baseline == null) return null;
  const { min, max } = baseline.ndvi;
  if (max - min < 1e-6) return null;
  const raw = 100 * ((current - min) / (max - min));
  return Math.max(0, Math.min(100, raw));
}

/**
 * How many historical years the current reading is worse than.
 * "worseThanYears: 8 of 10 Junes" reads as an intuitive risk signal.
 *
 * The count includes ties as "worse-or-equal". Returns null if no
 * baseline or no current reading.
 */
export function countWorseThanYears(
  current: number | null | undefined,
  baseline: WardMonthlyBaseline | null,
): { worseThan: number; totalYears: number } | null {
  if (current == null || baseline == null) return null;
  // We don't retain the raw values on the baseline (they're not needed
  // for the herder-facing string), so we estimate via the percentile
  // rank on the summary. `current` at or below P5 → worseThan ~= 95%
  // of years; at P50 → 50%. This is a good-enough approximation for
  // "worse than 8 of 10" phrasing.
  const { min, max, p5, p25, p50, p75, p95 } = baseline.ndvi;
  if (max - min < 1e-6) return null;
  let percentileRank: number;
  if (current <= min) percentileRank = 0;
  else if (current >= max) percentileRank = 1;
  else if (current <= p5) percentileRank = 0.05 * ((current - min) / Math.max(1e-9, p5 - min));
  else if (current <= p25) percentileRank = 0.05 + 0.2 * ((current - p5) / Math.max(1e-9, p25 - p5));
  else if (current <= p50) percentileRank = 0.25 + 0.25 * ((current - p25) / Math.max(1e-9, p50 - p25));
  else if (current <= p75) percentileRank = 0.5 + 0.25 * ((current - p50) / Math.max(1e-9, p75 - p50));
  else if (current <= p95) percentileRank = 0.75 + 0.2 * ((current - p75) / Math.max(1e-9, p95 - p75));
  else percentileRank = 0.95 + 0.05 * ((current - p95) / Math.max(1e-9, max - p95));
  const worseThan = Math.round((1 - percentileRank) * baseline.years);
  return { worseThan, totalYears: baseline.years };
}

/** Latest weather snapshot. Cached. */
export const latestWeatherFor = async (
  wardId: string,
  mode: SupabaseMode = "interactive",
): Promise<SbLatestWeather | null> => {
  const rows = await sbGet<SbLatestWeather>(
    `api_latest_weather_data?ward_id=eq.${encodeURIComponent(wardId)}&limit=1`,
    { cache: true, mode },
  );
  return rows?.[0] ?? null;
};

/**
 * Latest weather for every ward in one call. Backs the dashboard
 * timeseries panel so we can render 5 wards without 5 parallel
 * fetches. Cached — the underlying view refreshes when the
 * forecast job upserts weather_data.
 */
export const latestWeatherAll = (
  mode: SupabaseMode = "batch",
): Promise<SbLatestWeather[] | null> =>
  sbGet<SbLatestWeather>(
    `api_latest_weather_data?select=*&order=ward_id.asc&limit=50`,
    { cache: true, mode },
  );

/**
 * Pastoralist lookup by canonical phone. NOT cached — profile edits
 * should be visible instantly, and the volume is small.
 */
export const pastoralistByPhone = async (
  phone: string,
  mode: SupabaseMode = "interactive",
): Promise<SbPastoralist | null> => {
  const rows = await sbGet<SbPastoralist>(
    `pastoralists?phone_number=eq.${encodeURIComponent(phone)}&select=*&limit=1`,
    { mode },
  );
  return rows?.[0] ?? null;
};

/**
 * The full call-context view — Supabase joins pastoralist + ward +
 * latest satellite + latest weather in a single row for us. Returns
 * `null` if no pastoralist matches the phone.
 */
export const callContextByPhone = async (
  phone: string,
  mode: SupabaseMode = "interactive",
): Promise<SbCallContext | null> => {
  const rows = await sbGet<SbCallContext>(
    `api_call_context?phone_number=eq.${encodeURIComponent(phone)}&select=*&limit=1`,
    { mode },
  );
  return rows?.[0] ?? null;
};

/**
 * Insert a ground-truth call. This is the Supabase mirror of our local
 * `ground_truth_reports` insert; called from the deterministic pipeline
 * after every completed call. Returns the inserted row (or null on
 * failure — the local backup insert should always succeed).
 */
export const insertGroundTruthCall = (
  row: SbGroundTruthCallInsert,
  mode: SupabaseMode = "batch",
) =>
  // Ground truth writes happen in the deterministic pipeline's
  // fire-and-forget worker AFTER the AT XML response has already been
  // sent. Slower `batch` timeout is fine — the herder isn't waiting.
  sbInsert<{ call_id: string; call_timestamp: string }>(
    "ground_truth_calls",
    row as unknown as Record<string, unknown>,
    { mode },
  );

/** Insert or upsert a pastoralist. Used when a call comes in from an
 * unknown phone — we create the profile in Supabase so future calls
 * have the context. Uses `Prefer: resolution=merge-duplicates` so a
 * repeat call harmlessly no-ops. */
export const upsertPastoralist = async (
  row: Partial<SbPastoralist> & { phone_number: string },
  mode: SupabaseMode = "batch",
): Promise<SbPastoralist | null> => {
  try {
    const res = await sbFetch("pastoralists", {
      method: "POST",
      body: JSON.stringify(row),
      headers: {
        Prefer: "return=representation,resolution=merge-duplicates",
      },
      sbMode: mode,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logger.warn(
        { status: res.status, body: body.slice(0, 300) },
        "[Supabase] pastoralist upsert non-2xx",
      );
      return null;
    }
    const rows = (await res.json()) as SbPastoralist[];
    return rows[0] ?? null;
  } catch (err) {
    logger.warn({ err }, "[Supabase] pastoralist upsert crashed");
    return null;
  }
};

/**
 * Recent ground_truth_calls with pastoralist name + phone joined in.
 * Not cached — the operator dashboard needs fresh data every reload.
 * `batch` mode by default because this powers the dashboard, not USSD.
 */
export const recentGroundTruthCalls = (
  limit = 20,
  mode: SupabaseMode = "batch",
) => {
  const safeLimit = Math.min(Math.max(limit, 1), 100);
  return sbGet<SbGroundTruthCallRead>(
    `ground_truth_calls?select=call_id,pastoralist_id,ward_id,call_timestamp,bcs_score,mortality_rate,offtake_rate,water_point_status,milk_production_liters,water_trek_distance_km,supplementary_feeding,trust_score,source_language,transcript,created_at,pastoralists(phone_number,full_name,preferred_language,ward_id)&order=call_timestamp.desc&limit=${safeLimit}`,
    { mode },
  );
};

// ── Pastoralist leads (self-enrolled via USSD/SMS/inbound-call) ────────

/**
 * A self-subscribed pastoralist. Distinct from `pastoralists` — leads
 * live in a separate table and never enter analytics or drill batches
 * until ops promotes them via the leads panel. See feedback memory
 * "Pastoralist two-tier writes" for the policy.
 */
export interface SbPastoralistLead {
  lead_id: string;
  phone_number: string;
  full_name: string | null;
  preferred_language: "sw" | "en" | null;
  ward_id: string | null;
  location_text: string | null;
  herd_size: number | null;
  enrollment_source:
    | "ussd_self"
    | "sms_self"
    | "inbound_call"
    | "field_agent";
  status:
    | "lead"
    | "contacted"
    | "verified"
    | "declined"
    | "opted_out";
  alerts_enabled: boolean;
  first_contact_at: string;
  last_contact_at: string;
  verified_at: string | null;
  verified_by: string | null;
  promoted_pastoralist_id: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * A row from the `api_phone_identity` view — a union of verified
 * pastoralists + non-declined leads, tagged with a `tier` column so
 * downstream callers can gate behaviour. Never returns a phone that
 * appears in both tables (the view suppresses the lead row when a
 * verified pastoralist exists for the same phone).
 */
export interface SbPhoneIdentity {
  tier: "verified" | "lead";
  phone_number: string;
  identity_id: string;
  full_name: string | null;
  preferred_language: string | null;
  ward_id: string | null;
  location_text: string | null;
}

/**
 * Lookup any phone in the identity view. Interactive mode (2.5 s
 * timeout) so USSD/voice paths stay inside the AT budget. Returns
 * null for an unknown phone.
 */
export const identityForPhone = async (
  phone: string,
  mode: SupabaseMode = "interactive",
): Promise<SbPhoneIdentity | null> => {
  const rows = await sbGet<SbPhoneIdentity>(
    `api_phone_identity?phone_number=eq.${encodeURIComponent(phone)}&limit=1`,
    { mode },
  );
  return rows?.[0] ?? null;
};

/**
 * Insert or update a lead. Uses PostgREST's on-conflict merge on
 * `phone_number` so the second USSD subscribe from the same number
 * updates last_contact_at + any fields the caller supplied, rather
 * than 409-ing. Never writes to `pastoralists` — that's ops-only.
 *
 * Returns the resulting row (freshly inserted OR updated) so the
 * caller can pipe it back into HerderContext for the closing SMS.
 */
export const upsertPastoralistLead = async (
  row: Partial<SbPastoralistLead> & { phone_number: string },
  mode: SupabaseMode = "batch",
): Promise<SbPastoralistLead | null> => {
  const payload: Record<string, unknown> = {
    phone_number: row.phone_number,
    last_contact_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  // Only include fields the caller supplied — undefined would otherwise
  // wipe existing values on the merge.
  if (row.full_name != null) payload.full_name = row.full_name;
  if (row.preferred_language != null)
    payload.preferred_language = row.preferred_language;
  if (row.ward_id != null) payload.ward_id = row.ward_id;
  if (row.location_text != null) payload.location_text = row.location_text;
  if (row.herd_size != null) payload.herd_size = row.herd_size;
  if (row.enrollment_source != null)
    payload.enrollment_source = row.enrollment_source;
  if (row.status != null) payload.status = row.status;
  if (row.alerts_enabled != null) payload.alerts_enabled = row.alerts_enabled;
  if (row.notes != null) payload.notes = row.notes;

  try {
    const res = await sbFetch(
      "pastoralist_leads?on_conflict=phone_number",
      {
        method: "POST",
        body: JSON.stringify(payload),
        headers: {
          Prefer: "return=representation,resolution=merge-duplicates",
        },
        sbMode: mode,
      },
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logger.warn(
        { status: res.status, body: body.slice(0, 300) },
        "[Supabase] pastoralist_leads upsert non-2xx",
      );
      return null;
    }
    const rows = (await res.json()) as SbPastoralistLead[];
    const primary = rows[0] ?? null;
    // Local mirror. Best-effort; runs even if the Supabase branch
    // above returned null so a Supabase outage doesn't drop the lead.
    await mirrorPastoralistLead({
      phoneNumber: row.phone_number,
      fullName: row.full_name ?? undefined,
      preferredLanguage: row.preferred_language ?? undefined,
      wardId: row.ward_id ?? undefined,
      herdSize: row.herd_size ?? undefined,
      enrollmentSource: row.enrollment_source ?? undefined,
      status: row.status ?? undefined,
      alertsEnabled: row.alerts_enabled ?? undefined,
      notes: row.notes ?? undefined,
    });
    return primary;
  } catch (err) {
    logger.warn({ err }, "[Supabase] pastoralist_leads upsert crashed");
    // Still attempt the local mirror on Supabase-side crash.
    await mirrorPastoralistLead({
      phoneNumber: row.phone_number,
      fullName: row.full_name ?? undefined,
      preferredLanguage: row.preferred_language ?? undefined,
      wardId: row.ward_id ?? undefined,
      herdSize: row.herd_size ?? undefined,
      enrollmentSource: row.enrollment_source ?? undefined,
      status: row.status ?? undefined,
      alertsEnabled: row.alerts_enabled ?? undefined,
      notes: row.notes ?? undefined,
    });
    return null;
  }
};

/**
 * Set a lead's status (declined / opted_out / contacted). Called from
 * ops actions and from the SMS STOP handler.
 */
export const setLeadStatus = async (
  phone: string,
  status: SbPastoralistLead["status"],
  mode: SupabaseMode = "batch",
): Promise<boolean> => {
  try {
    const res = await sbFetch(
      `pastoralist_leads?phone_number=eq.${encodeURIComponent(phone)}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          status,
          updated_at: new Date().toISOString(),
        }),
        headers: { Prefer: "return=minimal" },
        sbMode: mode,
      },
    );
    return res.ok;
  } catch (err) {
    logger.warn({ err, phone, status }, "[Supabase] setLeadStatus crashed");
    return false;
  }
};

/**
 * Recent leads for the ops panel. Sorted by newest last-contact so
 * fresh subscribers surface at the top. Filters out declined /
 * opted_out by default; callers can pass `includeInactive=true`
 * for a full audit view.
 */
export const recentLeads = (
  limit = 50,
  opts: { includeInactive?: boolean; mode?: SupabaseMode } = {},
) => {
  const safeLimit = Math.min(Math.max(limit, 1), 200);
  const statusFilter = opts.includeInactive
    ? ""
    : "&status=in.(lead,contacted,verified)";
  return sbGet<SbPastoralistLead>(
    `pastoralist_leads?select=*${statusFilter}&order=last_contact_at.desc&limit=${safeLimit}`,
    { mode: opts.mode ?? "batch" },
  );
};

// ── Peer signal — what other herders in the ward reported ────────────

/**
 * Ward-scoped aggregate of recent herder reports. The brief uses this
 * to write a peer line: "6 wachungaji karibu nawe wameripoti hali
 * kama hii wiki hii" — turns an isolated caller into part of a
 * community signal.
 *
 * Sources: ground_truth_calls (Supabase — verified pastoralists) +
 * lead_interactions (Supabase — leads' inbound touches). Local
 * ground_truth_reports mirror is not queried here because the ops
 * dashboard reads the merged /api/ground-truth/merged view.
 */
export interface SbPeerSignal {
  ward_id: string;
  windowDays: number;
  totalReports: number;
  callerCount: number;
  thinAnimalsCount: number; // reports with bcs_score < 2.5
  mortalityCount: number; // reports with mortality_rate not null and > 0
  brokenWaterCount: number; // reports with water_point_status broken/mbovu
  interactionCount: number; // total lead_interactions in the window (any channel)
}

export const peerSignalForWard = async (
  wardId: string,
  windowDays = 7,
  mode: SupabaseMode = "interactive",
): Promise<SbPeerSignal | null> => {
  const cutoff = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000)
    .toISOString();

  // We deliberately query the raw tables rather than a materialised
  // view — the 200-row cap on ground_truth_calls per ward is generous
  // for a 7-day window even at pilot-scale, and it avoids adding a
  // Supabase view for a computation the api will change often.
  const gtPath =
    `ground_truth_calls?select=call_id,ward_id,bcs_score,mortality_rate,water_point_status,pastoralist_id` +
    `&ward_id=eq.${encodeURIComponent(wardId)}` +
    `&call_timestamp=gte.${encodeURIComponent(cutoff)}&limit=200`;
  const intPath =
    `lead_interactions?select=phone_number` +
    `&ward_id=eq.${encodeURIComponent(wardId)}` +
    `&occurred_at=gte.${encodeURIComponent(cutoff)}&limit=500`;

  const [gtRows, intRows] = await Promise.all([
    sbGet<{
      call_id: string;
      bcs_score: number | null;
      mortality_rate: number | null;
      water_point_status: string | null;
      pastoralist_id: string | null;
    }>(gtPath, { mode, cache: true }),
    sbGet<{ phone_number: string }>(intPath, { mode, cache: true }),
  ]);

  if (!gtRows && !intRows) return null;

  const callers = new Set<string>();
  let thinAnimalsCount = 0;
  let mortalityCount = 0;
  let brokenWaterCount = 0;
  for (const r of gtRows ?? []) {
    if (r.pastoralist_id) callers.add(r.pastoralist_id);
    if (r.bcs_score != null && r.bcs_score < 2.5) thinAnimalsCount++;
    if (r.mortality_rate != null && r.mortality_rate > 0) mortalityCount++;
    const ws = (r.water_point_status ?? "").toLowerCase();
    if (ws.includes("brok") || ws.includes("mbovu") || ws.includes("dry")) {
      brokenWaterCount++;
    }
  }
  for (const r of intRows ?? []) callers.add(r.phone_number);

  return {
    ward_id: wardId,
    windowDays,
    totalReports: gtRows?.length ?? 0,
    callerCount: callers.size,
    thinAnimalsCount,
    mortalityCount,
    brokenWaterCount,
    interactionCount: intRows?.length ?? 0,
  };
};

// ── Water-point ground-truth overrides ────────────────────────────────

/**
 * A ground-truth override for a water point. Herders can update WPDx
 * status via voice ("water at Burat is working now") or SMS. Rows
 * are extracted from ground_truth_calls.water_point_status +
 * water_point_name, filtered to a recency window (default 90 days).
 * When present, this overrides WPDx snapshot status per point.
 */
export interface SbWaterPointGroundTruth {
  water_point_name: string;
  water_point_status: string;
  call_timestamp: string;
  ward_id: string | null;
}

/**
 * Recent ground-truth updates about water points. Read from
 * ground_truth_calls where water_point_status is populated within
 * `daysWindow`. Cached briefly (60s) — herder briefs will fetch this
 * many times per minute during a busy period.
 */
export const recentWaterPointGroundTruth = async (
  daysWindow = 90,
  mode: SupabaseMode = "interactive",
): Promise<SbWaterPointGroundTruth[] | null> => {
  const cutoff = new Date(Date.now() - daysWindow * 24 * 60 * 60 * 1000)
    .toISOString();
  const path =
    `ground_truth_calls?select=water_point_name,water_point_status,call_timestamp,ward_id` +
    `&water_point_name=not.is.null&water_point_status=not.is.null` +
    `&call_timestamp=gte.${encodeURIComponent(cutoff)}` +
    `&order=call_timestamp.desc&limit=200`;
  return sbGet<SbWaterPointGroundTruth>(path, { mode, cache: true });
};

// ── lead_interactions — audit log of every AT surface hit ────────────

/**
 * Row shape for `lead_interactions`. Written from every AT-facing
 * route (ussd/sms/voice) on every hit — the operational audit
 * trail behind the ops CallbackLog dashboard, and feature source
 * for the trust-score model.
 *
 * `tier` is snapshot at the time of the interaction — a lead who
 * later gets verified still shows as tier='lead' on their old rows.
 */
export interface SbLeadInteractionInsert {
  phone_number: string;
  tier: "verified" | "lead" | "unknown";
  channel: "ussd" | "sms" | "voice" | "voice_event";
  session_id?: string | null;
  keyword?: string | null;
  input_text?: string | null;
  reply_text?: string | null;
  ward_id?: string | null;
  raw_body?: unknown;
}

/**
 * Fire-and-forget log write. Never blocks — the caller's AT
 * response has already been formulated. Dual-writes: Supabase primary
 * (source of truth) + local Postgres mirror (best-effort, keeps the
 * audit trail alive during a Supabase outage). Both failures are
 * warn-logged and swallowed.
 */
export const logLeadInteraction = async (
  row: SbLeadInteractionInsert,
): Promise<void> => {
  try {
    const res = await sbFetch("lead_interactions", {
      method: "POST",
      body: JSON.stringify(row),
      headers: { Prefer: "return=minimal" },
      sbMode: "batch",
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logger.warn(
        { status: res.status, body: body.slice(0, 200), channel: row.channel },
        "[Supabase] lead_interactions insert non-2xx",
      );
    }
  } catch (err) {
    logger.warn({ err, channel: row.channel }, "[Supabase] lead_interactions insert crashed");
  }
  // Local mirror runs regardless of Supabase outcome — if Supabase is
  // down we still capture the interaction; if the local pool is down
  // Supabase still has the row.
  await mirrorLeadInteraction({
    phoneNumber: row.phone_number,
    tier: row.tier,
    channel: row.channel,
    sessionId: row.session_id ?? null,
    keyword: row.keyword ?? null,
    inputText: row.input_text ?? null,
    replyText: row.reply_text ?? null,
    wardId: row.ward_id ?? null,
    rawBody: (row.raw_body ?? null) as InsertLeadInteraction["rawBody"],
    tenantId: null,
  });
};

/**
 * Recent interactions for the ops CallbackLog panel. Filterable by
 * channel + ward + phone. Sorted newest first.
 */
export interface SbLeadInteractionRead extends SbLeadInteractionInsert {
  interaction_id: string;
  occurred_at: string;
}

export const recentLeadInteractions = (
  opts: {
    limit?: number;
    channel?: "ussd" | "sms" | "voice" | "voice_event";
    ward_id?: string;
    phone?: string;
    mode?: SupabaseMode;
  } = {},
) => {
  const safeLimit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const filters: string[] = [];
  if (opts.channel) filters.push(`channel=eq.${opts.channel}`);
  if (opts.ward_id) filters.push(`ward_id=eq.${encodeURIComponent(opts.ward_id)}`);
  if (opts.phone) filters.push(`phone_number=eq.${encodeURIComponent(opts.phone)}`);
  const filterStr = filters.length > 0 ? "&" + filters.join("&") : "";
  return sbGet<SbLeadInteractionRead>(
    `lead_interactions?select=*${filterStr}&order=occurred_at.desc&limit=${safeLimit}`,
    { mode: opts.mode ?? "batch" },
  );
};

// ── Ward cells (grid geometry) + per-cell satellite indices ─────────────

/**
 * A single grid cell inside a ward. `cell_size_m` is typically 1000
 * (a 1 km cell) but nothing in code assumes that — always read it
 * from the row. Geometry is a MultiPolygon in EPSG:4326.
 */
export interface SbWardCell {
  ward_cell_id: string;
  ward_id: string;
  cell_i: number;
  cell_j: number;
  cell_size_m: number;
  area_ha: number;
  centroid: {
    type: "Point";
    coordinates: [number, number];
  } | null;
}

/**
 * Latest per-cell satellite indices (view over ward_cells JOIN
 * satellite_cell_indices, latest row per ward_cell_id). Flat shape
 * lets us query without embedding.
 */
export interface SbLatestCellSatelliteIndex {
  ward_cell_id: string;
  ward_id: string;
  // cell_size_m, area_ha, and centroid all live in ward_cells (the
  // geometry table). This shape used to include them because the view
  // materialised the join; now that we skip the view (see
  // latestCellIndicesForWard), callers must merge with listWardCells
  // for cell geometry.
  cell_size_m?: number;
  area_ha?: number;
  centroid_lat?: number;
  centroid_lon?: number;
  period_start: string;
  period_end: string;
  calendar_month: number;
  calendar_year: number;
  ndvi_mean: number | null;
  ndre_mean: number | null;
  ndwi_mean: number | null;
  ndmi_mean: number | null;
  evi_mean: number | null;
  savi_mean: number | null;
  bsi_mean: number | null;
  vci_value: number | null;
  ndvi_anomaly: number | null;
  ndre_anomaly: number | null;
  moisture_anomaly: number | null;
  prosopis_corrected: boolean;
  prosopis_share: number | null;
  grazing_condition_score: number | null;
  movement_advisory_score: number | null;
  source_collection: string | null;
  updated_at: string;
}

/**
 * List every cell in a ward. Cached — cell geometry is static.
 * Small wards (Wabera=17, Bulla Pesa=21) return instantly; larger
 * rural wards (Oldonyiro=1287, Ngare Mara=1116, Burat=833) fit
 * comfortably in one PostgREST page. We cap at 2000 to be explicit.
 */
export const listWardCells = (
  wardId: string,
  mode: SupabaseMode = "batch",
): Promise<SbWardCell[] | null> =>
  sbGet<SbWardCell>(
    `ward_cells?select=ward_cell_id,ward_id,cell_i,cell_j,cell_size_m,area_ha,centroid` +
      `&ward_id=eq.${encodeURIComponent(wardId)}&order=ward_cell_id.asc&limit=2000`,
    { cache: true, mode },
  );

/**
 * Latest indices for every cell in a ward.
 *
 * We deliberately do NOT read the `api_latest_cell_satellite_indices`
 * view — it does a per-cell DISTINCT ON join across 2.36 M rows and
 * blows past Supabase's statement-timeout for any ward with more than
 * ~100 cells (245 / 246 / 247 all fail). Instead:
 *
 *   1. Find the ward's most-recent period_end via a light query on
 *      `satellite_cell_indices`.
 *   2. Fetch every row for that period in Range-paginated pages
 *      (PostgREST caps individual responses at 1 000 rows regardless
 *      of ?limit=). Biggest ward is Oldonyiro at ~1 287 cells, so we
 *      cap at 3 pages (3 000 cells) with a defensive break-on-empty.
 *
 * Rows lack centroid_lat / centroid_lon (those live in `ward_cells`);
 * callers that need the geometry should merge in listWardCells result.
 */
export const latestCellIndicesForWard = async (
  wardId: string,
  mode: SupabaseMode = "batch",
): Promise<SbLatestCellSatelliteIndex[] | null> => {
  const wardFilter = `ward_id=eq.${encodeURIComponent(wardId)}`;
  const latestUrl =
    `satellite_cell_indices?${wardFilter}` +
    `&select=period_end&order=period_end.desc&limit=1`;
  const latest = await sbGet<{ period_end: string }>(latestUrl, {
    cache: true,
    mode,
  });
  if (!latest) return null;
  if (latest.length === 0) return [];
  const period = latest[0].period_end;

  // Columns that actually live on satellite_cell_indices. cell_size_m /
  // area_ha / centroid are on ward_cells (the geometry table); callers
  // merge them in from listWardCells.
  const PAGE = 1000;
  const MAX_PAGES = 3;
  const cols =
    "ward_cell_id,ward_id,period_start,period_end,calendar_month," +
    "calendar_year,ndvi_mean,ndre_mean,ndwi_mean,ndmi_mean,evi_mean,savi_mean," +
    "bsi_mean,vci_value,ndvi_anomaly,ndre_anomaly,moisture_anomaly," +
    "prosopis_corrected,prosopis_share,grazing_condition_score," +
    "movement_advisory_score,source_collection,updated_at";
  const rows: SbLatestCellSatelliteIndex[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const from = page * PAGE;
    const to = from + PAGE - 1;
    const res = await sbFetch(
      `satellite_cell_indices?${wardFilter}` +
        `&period_end=eq.${encodeURIComponent(period)}` +
        `&select=${cols}&order=ward_cell_id.asc`,
      {
        sbMode: mode,
        headers: { Range: `${from}-${to}`, "Range-Unit": "items" },
      },
    );
    if (!res.ok) {
      logger.warn(
        { status: res.status, wardId, page },
        "[Supabase] cell-indices page fetch failed",
      );
      break;
    }
    const chunk = (await res.json()) as SbLatestCellSatelliteIndex[];
    for (const r of chunk) rows.push(r);
    if (chunk.length < PAGE) break;
  }
  return rows;
};

/** Latest indices for a single cell, uncached. Queries the base table
 *  directly (see latestCellIndicesForWard for why we skip the view). */
export const latestCellSnapshot = async (
  wardCellId: string,
  mode: SupabaseMode = "interactive",
): Promise<SbLatestCellSatelliteIndex | null> => {
  const rows = await sbGet<SbLatestCellSatelliteIndex>(
    `satellite_cell_indices?ward_cell_id=eq.${encodeURIComponent(wardCellId)}` +
      `&order=period_end.desc&limit=1`,
    { mode },
  );
  return rows?.[0] ?? null;
};

/**
 * Nearest cell to (lat, lon), optionally scoped to a ward. Pulls the
 * ward's cells from cache and picks the minimum-haversine centroid.
 * PostgREST has no spatial-order primitive without a custom RPC, and
 * we already cache ward_cells, so client-side is cheapest.
 */
export const nearestCellForCoordinates = async (
  lat: number,
  lon: number,
  wardId: string,
  mode: SupabaseMode = "interactive",
): Promise<SbWardCell | null> => {
  const cells = await listWardCells(wardId, mode);
  if (!cells || cells.length === 0) return null;
  let best: SbWardCell | null = null;
  let bestKm = Number.POSITIVE_INFINITY;
  for (const cell of cells) {
    if (!cell.centroid) continue;
    const [cLon, cLat] = cell.centroid.coordinates;
    const km = haversineKm(lat, lon, cLat, cLon);
    if (km < bestKm) {
      bestKm = km;
      best = cell;
    }
  }
  return best;
};

function haversineKm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Ward-level cell stress summary. Aggregates per-cell latest NDVI +
 * VCI + anomaly across every cell in the ward. `stressedCellCount`
 * uses NDVI < 0.25 as a coarse dry-veg threshold — the same cut-off
 * the WardMap heatmap will render red.
 */
export interface SbWardCellStressSummary {
  ward_id: string;
  cellCount: number;
  cellsWithData: number;
  stressedCellCount: number;
  stressedFraction: number;
  ndviMin: number | null;
  ndviMax: number | null;
  ndviMedian: number | null;
  vciMedian: number | null;
  anomalyMedian: number | null;
  latestPeriodEnd: string | null;
}

export const wardCellStressSummary = async (
  wardId: string,
  mode: SupabaseMode = "batch",
): Promise<SbWardCellStressSummary | null> => {
  const rows = await latestCellIndicesForWard(wardId, mode);
  if (!rows) return null;
  const cellCount = rows.length;
  const ndvi = rows
    .map((r) => r.ndvi_mean)
    .filter((v): v is number => v != null)
    .sort((a, b) => a - b);
  const vci = rows
    .map((r) => r.vci_value)
    .filter((v): v is number => v != null)
    .sort((a, b) => a - b);
  const anomaly = rows
    .map((r) => r.ndvi_anomaly)
    .filter((v): v is number => v != null)
    .sort((a, b) => a - b);
  const stressedCellCount = rows.filter(
    (r) => r.ndvi_mean != null && r.ndvi_mean < 0.25,
  ).length;
  const latestPeriodEnd = rows
    .map((r) => r.period_end)
    .sort()
    .pop() ?? null;
  return {
    ward_id: wardId,
    cellCount,
    cellsWithData: ndvi.length,
    stressedCellCount,
    stressedFraction: cellCount > 0 ? stressedCellCount / cellCount : 0,
    ndviMin: ndvi[0] ?? null,
    ndviMax: ndvi[ndvi.length - 1] ?? null,
    ndviMedian: median(ndvi),
    vciMedian: median(vci),
    anomalyMedian: median(anomaly),
    latestPeriodEnd,
  };
};

function median(sorted: number[]): number | null {
  const n = sorted.length;
  if (n === 0) return null;
  const mid = Math.floor(n / 2);
  return n % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// ── Server-side RPC wrappers ─────────────────────────────────────────

/**
 * Typed wrappers around the Postgres RPCs Supabase exposes for our
 * write paths. Signatures come from the PostgREST OpenAPI at
 * `${SUPABASE_URL}/rest/v1/` — every arg name matches `p_*` exactly.
 *
 * We keep these separate from the read helpers because the RPC call
 * conventions (POST to `/rpc/:name`, args in a flat object) differ
 * from PostgREST table reads. Returns `null` on non-2xx so callers
 * can log + carry on with local backup writes if they need to.
 */

async function sbRpc<T>(
  name: string,
  args: object,
  opts: { mode?: SupabaseMode } = {},
): Promise<T | null> {
  try {
    const res = await sbFetch(`rpc/${name}`, {
      method: "POST",
      body: JSON.stringify(args),
      sbMode: opts.mode ?? "batch",
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logger.warn(
        { status: res.status, rpc: name, body: body.slice(0, 300) },
        "[Supabase] RPC non-2xx",
      );
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    logger.warn({ err, rpc: name }, "[Supabase] RPC failed");
    return null;
  }
}

/**
 * Refresh the `api_latest_satellite_indices` materialised view.
 * Idempotent — pass no args. Returns `{ ok, run_id, upserted,
 * latest_period_end }` on success.
 */
export const refreshSatelliteIndicesLatest = () =>
  sbRpc<{
    ok: boolean;
    run_id: string;
    upserted: number;
    latest_period_end: string | null;
  }>("refresh_satellite_indices_latest", {});

/** One-row upsert into `satellite_indices`. All p_* names match the RPC. */
export interface UpsertSatelliteIndicesArgs {
  p_ward_id: string;
  p_period_start: string;
  p_period_end: string;
  p_calendar_month: number;
  p_calendar_year: number;
  p_ndvi_mean: number;
  p_ndre_mean: number;
  p_ndwi_mean: number;
  p_ndmi_mean: number;
  p_evi_mean: number;
  p_savi_mean: number;
  p_bsi_mean: number;
  p_vci_value: number;
  p_ndvi_anomaly: number;
  p_ndre_anomaly: number;
  p_moisture_anomaly: number;
  p_prosopis_corrected: boolean;
  p_prosopis_share: number;
  p_water_pixel_share: number;
  p_dry_season_persistence: number;
  p_grazing_condition_score: number;
  p_movement_advisory_score: number;
  p_source_collection: string;
  p_run_id: string;
  // Optional metadata columns.
  p_pixel_count?: number;
  p_quality_flag?: string;
  p_data_source?: string;
  p_computed_by?: string;
}
export const upsertSatelliteIndices = (args: UpsertSatelliteIndicesArgs) =>
  sbRpc<{ satellite_index_id?: number } | null>("upsert_satellite_indices", args);

/** One-row upsert into `satellite_cell_indices`. Same shape as ward-level
 *  plus `p_ward_cell_id`. */
export interface UpsertSatelliteCellIndicesArgs
  extends UpsertSatelliteIndicesArgs {
  p_ward_cell_id: string;
}
export const upsertSatelliteCellIndices = (
  args: UpsertSatelliteCellIndicesArgs,
) =>
  sbRpc<{ satellite_cell_index_id?: number } | null>(
    "upsert_satellite_cell_indices",
    args,
  );

/** One-row upsert into `weather_data`. */
export interface UpsertWeatherDataArgs {
  p_ward_id: string;
  p_observed_date: string;
  p_rainfall_mm_30d: number;
  p_humidity_pct: number;
  p_temperature_c: number;
  p_evapotranspiration_mm: number;
  p_source?: string;
}
export const upsertWeatherData = async (
  args: UpsertWeatherDataArgs,
): Promise<{ weather_data_id?: number } | null> => {
  const primary = await sbRpc<{ weather_data_id?: number } | null>(
    "upsert_weather_data",
    args,
  );
  // Local mirror. Runs regardless of Supabase outcome so the forecast
  // job keeps local `weather_data` warm during a Supabase outage.
  await mirrorWeatherData({
    wardId: args.p_ward_id,
    observedDate: args.p_observed_date,
    rainfallMm30d:
      args.p_rainfall_mm_30d != null ? String(args.p_rainfall_mm_30d) : null,
    humidityPct:
      args.p_humidity_pct != null ? String(args.p_humidity_pct) : null,
    temperatureC:
      args.p_temperature_c != null ? String(args.p_temperature_c) : null,
    evapotranspirationMm:
      args.p_evapotranspiration_mm != null
        ? String(args.p_evapotranspiration_mm)
        : null,
    source: args.p_source ?? null,
    tenantId: null,
  });
  return primary;
};

/** Rebuild the `ward_cells` grid (~1 km default). Ops-only — recomputes
 *  ~27 k rows in one call. Do not fire in a request path. */
export const rebuildWardCells = (cellSizeM = 1000) =>
  sbRpc<{ ok: boolean; cell_size_m: number; upserted: number } | null>(
    "rebuild_ward_cells",
    { p_cell_size_m: cellSizeM },
  );

export function clearSupabaseCache(): void {
  cache.clear();
}

/**
 * Generic PostgREST GET for internal batch consumers (sync workers,
 * backfill jobs). Always uses the `batch` timeout; never caches.
 * Returns `null` on network error or non-2xx so callers can skip and
 * retry on the next cycle.
 */
export async function sbQuery<T>(
  path: string,
  opts: { mode?: SupabaseMode } = {},
): Promise<T[] | null> {
  return sbGet<T>(path, { mode: opts.mode ?? "batch" });
}
