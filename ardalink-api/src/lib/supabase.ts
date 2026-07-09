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

export function clearSupabaseCache(): void {
  cache.clear();
}
