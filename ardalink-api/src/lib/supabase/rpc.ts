/**
 * Typed wrappers around the Postgres RPCs Supabase exposes for our
 * write paths. Signatures come from the PostgREST OpenAPI at
 * `${SUPABASE_URL}/rest/v1/` — every arg name matches `p_*` exactly.
 *
 * Kept separate from the read helpers because the RPC call
 * conventions (POST to `/rpc/:name`, args in a flat object) differ
 * from PostgREST table reads. Returns `null` on non-2xx so callers
 * can log + carry on with local backup writes if they need to.
 */

import { logger } from "../logger.js";
import { mirrorWeatherData } from "../localMirror.js";
import { sbFetch, sbGet, type SupabaseMode } from "./client.js";

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
    // Some Postgres functions (e.g. upsert_weather_data) are void-returning
    // and PostgREST answers 2xx with an empty body — that's success, not
    // malformed JSON. Previously this went straight to res.json(), which
    // threw "Unexpected end of JSON input" on every single successful call
    // and logged it identically to a real RPC failure. Read as text first
    // so an empty-but-ok body returns null quietly; a genuinely malformed
    // non-empty body still gets logged.
    const text = await res.text();
    if (!text) return null;
    try {
      return JSON.parse(text) as T;
    } catch (err) {
      logger.warn(
        { err, rpc: name, body: text.slice(0, 300) },
        "[Supabase] RPC returned invalid JSON",
      );
      return null;
    }
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
