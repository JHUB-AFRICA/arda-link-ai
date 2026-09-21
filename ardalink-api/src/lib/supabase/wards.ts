/**
 * Ward reference data (wards, neighbors, geometry) and ward-level
 * weather reads. Cross-ward advice (`bestNeighborForAdvice`) combines
 * `ward_neighbors` with satellite NDVI from `./satelliteIndices.js`.
 */

import { sbGet, type SupabaseMode } from "./client.js";
import { latestSatelliteFor } from "./satelliteIndices.js";

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
