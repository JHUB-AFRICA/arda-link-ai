/**
 * satellite_indices — ward-level NDVI/VCI reads, historical baseline
 * computation, and the live-GEE VCI write path (see
 * `persistSatelliteVciSnapshot` at the bottom).
 */

import { sbFetch, sbGet, type SupabaseMode } from "./client.js";
import { logger } from "../logger.js";

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

// ── satellite_indices VCI snapshot write ───────────────────────────────

export interface SatelliteVciSnapshotArgs {
  periodStart: string;    // "YYYY-MM-01"
  periodEnd: string;      // "YYYY-MM-DD"
  calendarMonth: number;
  calendarYear: number;
  ndviMean: number | null;
  ndviMin: number | null;
  ndviMax: number | null;
  vciValue: number | null;
  prosopisCorrected: boolean;
  runId: string;
}

/**
 * Persist a live GEE VCI snapshot to `satellite_indices` with
 * `vci_value` already computed — so the hourly backfill job has
 * nothing to patch on its next run.
 *
 * Strategy: GET the existing row first.
 *   • Exists + has vci_value → skip (idempotent).
 *   • Exists + vci_value null → PATCH the two known columns.
 *   • Missing → INSERT a minimal row with the columns GEE provides.
 *
 * Columns not available from the live trigger (ndre_mean, ndwi_mean,
 * etc.) are left NULL in the INSERT path — the full upsert_satellite_indices
 * RPC fills them when the comprehensive ingest script runs.
 */
export async function persistSatelliteVciSnapshot(
  wardId: string,
  args: SatelliteVciSnapshotArgs,
): Promise<boolean> {
  if (args.vciValue == null) return false;
  try {
    // Check for an existing row this period.
    const existing = await sbGet<{
      satellite_index_id: number;
      vci_value: number | null;
    }>(
      `satellite_indices?ward_id=eq.${encodeURIComponent(wardId)}&period_start=eq.${encodeURIComponent(args.periodStart)}&select=satellite_index_id,vci_value&limit=1`,
      { mode: "batch" },
    );

    if (existing && existing.length > 0) {
      if (existing[0]!.vci_value != null) return true; // already set
      const patchRes = await sbFetch(
        `satellite_indices?ward_id=eq.${encodeURIComponent(wardId)}&period_start=eq.${encodeURIComponent(args.periodStart)}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            vci_value: args.vciValue,
            ndvi_mean: args.ndviMean,
          }),
          headers: { Prefer: "return=minimal" },
          sbMode: "batch",
        },
      );
      if (!patchRes.ok) {
        const body = await patchRes.text().catch(() => "");
        logger.warn(
          { status: patchRes.status, wardId, body: body.slice(0, 200) },
          "[Supabase] satellite_indices VCI patch non-2xx",
        );
        return false;
      }
      return true;
    }

    // Insert new row with the columns the live trigger provides.
    const payload: Record<string, unknown> = {
      ward_id: wardId,
      period_start: args.periodStart,
      period_end: args.periodEnd,
      calendar_month: args.calendarMonth,
      calendar_year: args.calendarYear,
      ndvi_mean: args.ndviMean,
      vci_value: args.vciValue,
      prosopis_corrected: args.prosopisCorrected,
      source_collection: "MODIS/061/MOD13Q1",
      run_id: args.runId,
    };
    if (args.ndviMin != null) payload.ndvi_min = args.ndviMin;
    if (args.ndviMax != null) payload.ndvi_max = args.ndviMax;

    const insertRes = await sbFetch("satellite_indices", {
      method: "POST",
      body: JSON.stringify(payload),
      headers: { Prefer: "return=minimal" },
      sbMode: "batch",
    });
    if (!insertRes.ok) {
      const body = await insertRes.text().catch(() => "");
      logger.warn(
        { status: insertRes.status, wardId, body: body.slice(0, 300) },
        "[Supabase] satellite_indices VCI insert non-2xx",
      );
      return false;
    }
    return true;
  } catch (err) {
    logger.warn(
      { err: String(err), wardId },
      "[Supabase] satellite_indices VCI snapshot write crashed",
    );
    return false;
  }
}
