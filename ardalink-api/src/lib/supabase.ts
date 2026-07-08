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

export function clearSupabaseCache(): void {
  cache.clear();
}
