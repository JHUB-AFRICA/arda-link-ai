/**
 * Rainfall / temperature forecast job.
 *
 * Every 6 h (configurable), hits Open-Meteo's ensemble endpoint for
 * each ward centroid and persists a 14-day forecast row per day to
 * Supabase `weather_forecast`. Confidence bands are computed from
 * the ensemble members' p5 / p50 / p95 of daily precipitation.
 *
 * Why ensemble not deterministic:
 *   Herders decide whether to move stock based on "will it rain?",
 *   not "will it rain 3.2 mm on Tuesday?". The ensemble gives us
 *   probability-of-rain per day, which is a directly-actionable
 *   signal a deterministic run can't produce.
 *
 * Why persist:
 *   The api's opener currently computes a forecast at request time
 *   (~1 s of Open-Meteo latency per call). Persisting lets us:
 *     - Serve the herder brief without an external round-trip
 *     - Trend forecast-vs-actual for model quality tracking
 *     - Trigger threshold alerts (e.g. p50 <5mm and p95<15mm for
 *       14 days → drought alert)
 *
 * Never blocks server start — failures are warn-logged and the
 * scheduler continues.
 */

import { logger } from "../lib/logger.js";
import {
  isSupabaseConfigured,
  listActiveWards,
  refreshSatelliteIndicesLatest,
} from "../lib/supabase.js";

// 5 Isiolo Sub-County ward centroids. Duplicated from wpdx.ts's
// WARD_CENTROIDS because we lookup by ward_id here rather than
// tenant slug and the two mappings drift independently.
const WARD_CENTROIDS_BY_ID: Record<string, { lat: number; lon: number }> = {
  "241": { lat: 0.3746, lon: 37.5921 }, // Wabera
  "242": { lat: 0.3453, lon: 37.5810 }, // Bulla Pesa
  "245": { lat: 0.6614, lon: 37.9040 }, // Ngare Mara
  "246": { lat: 0.4375, lon: 37.4785 }, // Burat
  "247": { lat: 0.6392, lon: 37.1345 }, // Oldonyiro
};

const FORECAST_HORIZON_DAYS = 14;
// The `ensemble-api.open-meteo.com` host was intermittently unreachable
// from our environment (verified 2026-07-12 by successful curl but
// failed node fetch). Fall back to the standard forecast endpoint,
// which returns deterministic daily values; we synthesise p5/p95
// bands using horizon-scaled uncertainty (GFS skill drops ~15% per
// forecast day beyond day 3). Same host that openData.ts uses.
const OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast";

let forecastTimer: NodeJS.Timeout | null = null;
let forecastEnabled = true;

interface OpenMeteoEnsembleResponse {
  latitude: number;
  longitude: number;
  daily?: {
    time: string[];
    // Daily arrays keyed by variable name; ensemble members come as
    // separate keys like precipitation_sum_member01..member30.
    [key: string]: unknown;
  };
  daily_units?: Record<string, string>;
}

interface ForecastRow {
  ward_id: string;
  generated_at: string;
  target_date: string;
  horizon_days: number;
  rainfall_mm_p5: number;
  rainfall_mm_p50: number;
  rainfall_mm_p95: number;
  precipitation_probability: number;
  temperature_c_mean: number | null;
  temperature_c_max: number | null;
  et0_mm: number | null;
  source: string;
  raw_response: unknown;
}

function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0]!;
  const idx = (sorted.length - 1) * q;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo);
}

/**
 * Widen a deterministic rainfall prediction into p5/p95 bounds
 * based on the forecast horizon. GFS skill degrades roughly linearly
 * — bounds double from day 1 (±30 %) to day 14 (±110 %). Values
 * clamped at 0 mm below.
 */
function synthesiseBounds(
  meanRainMm: number,
  horizonDays: number,
): { p5: number; p50: number; p95: number } {
  const fraction = 0.3 + Math.min(1, (horizonDays - 1) / 13) * 0.8;
  const spread = Math.max(1.5, meanRainMm * fraction); // 1.5mm floor so probs make sense on dry days
  return {
    p5: Math.max(0, meanRainMm - spread),
    p50: Math.max(0, meanRainMm),
    p95: Math.max(0, meanRainMm + spread),
  };
}

async function fetchWardEnsemble(
  wardId: string,
  centroid: { lat: number; lon: number },
): Promise<ForecastRow[] | null> {
  const params = new URLSearchParams({
    latitude: String(centroid.lat),
    longitude: String(centroid.lon),
    daily:
      "precipitation_sum,precipitation_probability_max," +
      "temperature_2m_mean,temperature_2m_max,et0_fao_evapotranspiration",
    forecast_days: String(FORECAST_HORIZON_DAYS),
    timezone: "auto",
  });

  const url = `${OPEN_METEO_URL}?${params.toString()}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logger.warn(
        { wardId, status: res.status, body: body.slice(0, 200) },
        "[ForecastJob] Open-Meteo non-2xx — skipping ward",
      );
      return null;
    }
    const data = (await res.json()) as OpenMeteoEnsembleResponse;
    if (!data.daily?.time?.length) {
      logger.warn({ wardId }, "[ForecastJob] Empty daily block");
      return null;
    }

    const days = data.daily.time;
    const now = new Date().toISOString();
    const rows: ForecastRow[] = [];

    for (let dayIdx = 0; dayIdx < days.length; dayIdx++) {
      const targetDate = days[dayIdx];
      if (!targetDate) continue;

      const meanRain = numberAt(data.daily, "precipitation_sum", dayIdx) ?? 0;
      // Open-Meteo reports probability as 0..100 (percentage).
      const rawProb = numberAt(
        data.daily,
        "precipitation_probability_max",
        dayIdx,
      );
      const precipProb =
        rawProb != null ? Math.max(0, Math.min(1, rawProb / 100)) : 0;
      const { p5, p50, p95 } = synthesiseBounds(meanRain, dayIdx + 1);

      const tempMean = numberAt(data.daily, "temperature_2m_mean", dayIdx);
      const tempMax = numberAt(data.daily, "temperature_2m_max", dayIdx);
      const et0 = numberAt(data.daily, "et0_fao_evapotranspiration", dayIdx);

      rows.push({
        ward_id: wardId,
        generated_at: now,
        target_date: targetDate,
        horizon_days: dayIdx + 1,
        rainfall_mm_p5: round2(p5),
        rainfall_mm_p50: round2(p50),
        rainfall_mm_p95: round2(p95),
        precipitation_probability: round2(precipProb),
        temperature_c_mean: tempMean,
        temperature_c_max: tempMax,
        et0_mm: et0,
        source: "open-meteo",
        raw_response: null,
      });
    }
    return rows;
  } catch (err) {
    logger.warn({ err: String(err), wardId }, "[ForecastJob] fetch failed");
    return null;
  }
}

function numberAt(
  daily: Record<string, unknown>,
  key: string,
  idx: number,
): number | null {
  const arr = daily[key];
  if (!Array.isArray(arr)) return null;
  const v = Number(arr[idx]);
  return Number.isFinite(v) ? round2(v) : null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

async function persistForecast(rows: ForecastRow[]): Promise<boolean> {
  const url = `${(process.env.SUPABASE_URL ?? "").replace(/\/$/, "")}/rest/v1/weather_forecast`;
  const key = (process.env.SUPABASE_SECRET_KEY ?? "").trim();
  if (!url || !key) return false;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify(rows),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logger.warn(
        { status: res.status, body: body.slice(0, 300) },
        "[ForecastJob] Supabase insert non-2xx",
      );
      return false;
    }
    return true;
  } catch (err) {
    logger.warn({ err: String(err) }, "[ForecastJob] Supabase insert crashed");
    return false;
  }
}

export async function runForecastJob(): Promise<void> {
  if (!isSupabaseConfigured()) {
    logger.info(
      "[ForecastJob] Supabase not configured — skipping (nothing to persist to)",
    );
    return;
  }
  const wards = await listActiveWards();
  if (!wards || wards.length === 0) {
    logger.warn("[ForecastJob] No active wards from Supabase");
    return;
  }
  const startedAt = Date.now();
  let totalRows = 0;
  let wardsOk = 0;
  for (const w of wards) {
    const centroid = WARD_CENTROIDS_BY_ID[w.ward_id];
    if (!centroid) {
      logger.warn(
        { wardId: w.ward_id },
        "[ForecastJob] No centroid for ward — skipping",
      );
      continue;
    }
    const rows = await fetchWardEnsemble(w.ward_id, centroid);
    if (!rows || rows.length === 0) continue;
    const ok = await persistForecast(rows);
    if (ok) {
      totalRows += rows.length;
      wardsOk += 1;
    }
  }
  // Piggy-back the materialised-view refresh onto the forecast job
  // so `api_latest_satellite_indices` stays current. Idempotent, and
  // sending it every 6 h matches the forecast cadence — cheap enough
  // to run in the same loop rather than a separate scheduler entry.
  const refresh = await refreshSatelliteIndicesLatest();
  logger.info(
    {
      wardsOk,
      totalWards: wards.length,
      totalRows,
      latestViewUpserted: refresh?.upserted ?? null,
      latestPeriodEnd: refresh?.latest_period_end ?? null,
      durationMs: Date.now() - startedAt,
    },
    "[ForecastJob] Refresh completed",
  );
}

/**
 * Start the forecast refresh job. Runs immediately on startup, then
 * every FORECAST_JOB_INTERVAL_MS (default 6 h). Idempotent.
 */
export function startForecastJob(): void {
  if (forecastTimer) {
    logger.warn("[ForecastJob] Job already running — stopping previous timer");
    stopForecastJob();
  }
  forecastEnabled = process.env.FORECAST_JOB_ENABLED !== "false";
  if (!forecastEnabled) {
    logger.info("[ForecastJob] Job disabled — will not start");
    return;
  }
  const interval = Number(
    process.env.FORECAST_JOB_INTERVAL_MS ?? String(6 * 60 * 60 * 1000),
  );
  void runForecastJob().then(() => {
    forecastTimer = setInterval(() => {
      void runForecastJob();
    }, interval);
    logger.info(
      { interval },
      "[ForecastJob] Scheduled next run",
    );
  });
}

export function stopForecastJob(): void {
  if (forecastTimer) {
    clearInterval(forecastTimer);
    forecastTimer = null;
    logger.info("[ForecastJob] Job stopped");
  }
}

export function isForecastJobEnabled(): boolean {
  return forecastEnabled;
}
