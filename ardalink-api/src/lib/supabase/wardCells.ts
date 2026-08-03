/**
 * Ward/cell-granularity signals: peer reports, water-point ground
 * truth overrides, and the ward_cells grid + per-cell satellite
 * indices. Grouped together because they're all "what's happening at
 * finer-than-ward granularity" reads, each individually small.
 */

import { logger } from "../logger.js";
import { sbFetch, sbGet, type SupabaseMode } from "./client.js";

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
  call_id: string;
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
    `ground_truth_calls?select=call_id,water_point_name,water_point_status,call_timestamp,ward_id` +
    `&water_point_name=not.is.null&water_point_status=not.is.null` +
    `&call_timestamp=gte.${encodeURIComponent(cutoff)}` +
    `&order=call_timestamp.desc&limit=200`;
  return sbGet<SbWaterPointGroundTruth>(path, { mode, cache: true });
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
