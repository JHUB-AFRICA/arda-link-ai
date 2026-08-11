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
  upsertWeatherData,
} from "../lib/supabase/index.js";
import { mirrorWeatherForecastBatch } from "../lib/localMirror.js";
import type { InsertWeatherForecast } from "@workspace/db";

const FORECAST_HORIZON_DAYS = 14;
// Real ensemble endpoint — 39-member DWD ICON global ensemble, free,
// no key. `ensemble-api.open-meteo.com` was verified unreachable from
// Node (but not curl) on 2026-07-12; re-verified reachable from both
// curl and Node on 2026-07-30, so it's primary again. Falls back to
// the deterministic endpoint + synthesised bounds below if it's ever
// unreachable again — see fetchWardEnsemble().
const ENSEMBLE_URL = "https://ensemble-api.open-meteo.com/v1/ensemble";
const ENSEMBLE_MODEL = "icon_seamless";
// Deterministic fallback + same host openData.ts uses.
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

/**
 * Real ensemble forecast — 39-member ICON global ensemble. p5/p50/p95
 * are the actual percentiles across members (via the existing
 * `percentile()` helper), not a synthesised spread, and
 * `precipitation_probability` is the fraction of members with >0.1mm
 * rain that day — a proper ensemble probability-of-rain, not a
 * deterministic-model derived stat. Returns `null` on any failure so
 * the caller falls back to `fetchWardDeterministicFallback`.
 */
function collectMemberValues(
  daily: Record<string, unknown>,
  baseKey: string,
  dayIdx: number,
): number[] {
  const prefix = `${baseKey}_member`;
  const values: number[] = [];
  for (const key of Object.keys(daily)) {
    if (!key.startsWith(prefix)) continue;
    const arr = daily[key];
    if (!Array.isArray(arr)) continue;
    const v = Number(arr[dayIdx]);
    if (Number.isFinite(v)) values.push(v);
  }
  return values;
}

function meanOf(values: number[]): number | null {
  return values.length
    ? values.reduce((a, b) => a + b, 0) / values.length
    : null;
}

async function fetchWardEnsembleReal(
  wardId: string,
  centroid: { lat: number; lon: number },
): Promise<ForecastRow[] | null> {
  const params = new URLSearchParams({
    latitude: String(centroid.lat),
    longitude: String(centroid.lon),
    models: ENSEMBLE_MODEL,
    daily:
      "precipitation_sum,temperature_2m_mean,temperature_2m_max,et0_fao_evapotranspiration",
    forecast_days: String(FORECAST_HORIZON_DAYS),
    timezone: "auto",
  });

  const url = `${ENSEMBLE_URL}?${params.toString()}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logger.warn(
        { wardId, status: res.status, body: body.slice(0, 200) },
        "[ForecastJob] Ensemble API non-2xx — falling back to deterministic",
      );
      return null;
    }
    const data = (await res.json()) as OpenMeteoEnsembleResponse;
    if (!data.daily?.time?.length) return null;

    const daily = data.daily as unknown as Record<string, unknown>;
    const days = data.daily.time;
    const now = new Date().toISOString();
    const rows: ForecastRow[] = [];

    for (let dayIdx = 0; dayIdx < days.length; dayIdx++) {
      const targetDate = days[dayIdx];
      if (!targetDate) continue;

      const precipMembers = collectMemberValues(daily, "precipitation_sum", dayIdx);
      if (precipMembers.length === 0) continue;
      const sortedPrecip = precipMembers.slice().sort((a, b) => a - b);
      const p5 = Math.max(0, percentile(sortedPrecip, 0.05));
      const p50 = Math.max(0, percentile(sortedPrecip, 0.5));
      const p95 = Math.max(0, percentile(sortedPrecip, 0.95));
      const wetMembers = precipMembers.filter((v) => v > 0.1).length;
      const precipProb = wetMembers / precipMembers.length;

      const tempMean = meanOf(collectMemberValues(daily, "temperature_2m_mean", dayIdx));
      const tempMax = meanOf(collectMemberValues(daily, "temperature_2m_max", dayIdx));
      const et0 = meanOf(collectMemberValues(daily, "et0_fao_evapotranspiration", dayIdx));

      rows.push({
        ward_id: wardId,
        generated_at: now,
        target_date: targetDate,
        horizon_days: dayIdx + 1,
        rainfall_mm_p5: round2(p5),
        rainfall_mm_p50: round2(p50),
        rainfall_mm_p95: round2(p95),
        precipitation_probability: round2(precipProb),
        temperature_c_mean: tempMean != null ? round2(tempMean) : null,
        temperature_c_max: tempMax != null ? round2(tempMax) : null,
        et0_mm: et0 != null ? round2(et0) : null,
        source: "open-meteo-ensemble",
        raw_response: null,
      });
    }
    return rows.length > 0 ? rows : null;
  } catch (err) {
    logger.warn(
      { err: String(err), wardId },
      "[ForecastJob] Ensemble fetch failed — falling back to deterministic",
    );
    return null;
  }
}

/**
 * Deterministic Open-Meteo forecast + synthesised p5/p95 bounds
 * (GFS skill drops ~15% per forecast day beyond day 3). Used only
 * when the real ensemble endpoint above is unreachable.
 */
async function fetchWardDeterministicFallback(
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

/**
 * Try the real ensemble endpoint first; fall back to the deterministic
 * endpoint + synthesised bounds on any failure. Same fail-soft shape
 * as the rest of this codebase — the primary/fallback roles just
 * flipped back to what the file header always said they should be.
 */
async function fetchWardEnsemble(
  wardId: string,
  centroid: { lat: number; lon: number },
): Promise<ForecastRow[] | null> {
  const real = await fetchWardEnsembleReal(wardId, centroid);
  if (real) return real;
  return fetchWardDeterministicFallback(wardId, centroid);
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

/**
 * Fetch today's observation summary for a ward: 30-day rolling
 * rainfall + latest temperature / humidity / ET0. Open-Meteo returns
 * both past and forecast in one response — we request `past_days=30`
 * and slice the past portion for the rolling sum. Falls through to
 * null on non-2xx so the caller can carry on.
 */
async function fetchWardObservation(
  wardId: string,
  centroid: { lat: number; lon: number },
): Promise<{
  ward_id: string;
  observed_date: string;
  rainfall_mm_30d: number;
  humidity_pct: number;
  temperature_c: number;
  evapotranspiration_mm: number;
} | null> {
  const params = new URLSearchParams({
    latitude: String(centroid.lat),
    longitude: String(centroid.lon),
    daily:
      "precipitation_sum,temperature_2m_mean,relative_humidity_2m_mean," +
      "et0_fao_evapotranspiration",
    past_days: "30",
    forecast_days: "1",
    timezone: "auto",
  });
  const url = `${OPEN_METEO_URL}?${params.toString()}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) {
      logger.warn(
        { wardId, status: res.status },
        "[ForecastJob] observation fetch non-2xx",
      );
      return null;
    }
    const data = (await res.json()) as OpenMeteoEnsembleResponse;
    const days = data.daily?.time;
    if (!days || days.length === 0) return null;
    // The last 30 entries (index 0..29) are past; index 30 is today
    // (forecast). Rainfall_mm_30d = sum of the past 30 including today.
    const rainArr = data.daily?.["precipitation_sum"];
    let rainSum = 0;
    if (Array.isArray(rainArr)) {
      for (const v of rainArr) {
        const n = Number(v);
        if (Number.isFinite(n)) rainSum += n;
      }
    }
    // Latest day (today, position -1 in the array) for the point readings.
    const lastIdx = days.length - 1;
    const observedDate = days[lastIdx] ?? new Date().toISOString().slice(0, 10);
    const temp = numberAt(data.daily ?? {}, "temperature_2m_mean", lastIdx) ?? 0;
    const humidity =
      numberAt(data.daily ?? {}, "relative_humidity_2m_mean", lastIdx) ?? 0;
    const et0 = numberAt(data.daily ?? {}, "et0_fao_evapotranspiration", lastIdx) ?? 0;
    return {
      ward_id: wardId,
      observed_date: observedDate,
      rainfall_mm_30d: round2(rainSum),
      humidity_pct: round2(humidity),
      temperature_c: round2(temp),
      evapotranspiration_mm: round2(et0),
    };
  } catch (err) {
    logger.warn(
      { err: String(err), wardId },
      "[ForecastJob] observation fetch failed",
    );
    return null;
  }
}

async function persistForecast(rows: ForecastRow[]): Promise<boolean> {
  const url = `${(process.env.SUPABASE_URL ?? "").replace(/\/$/, "")}/rest/v1/weather_forecast`;
  const key = (process.env.SUPABASE_SECRET_KEY ?? "").trim();
  if (!url || !key) return false;
  let supabaseOk = false;
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
    } else {
      supabaseOk = true;
    }
  } catch (err) {
    logger.warn({ err: String(err) }, "[ForecastJob] Supabase insert crashed");
  }
  // Local mirror runs regardless of Supabase outcome so a Supabase
  // outage doesn't leave local `weather_forecast` empty.
  const mirrorRows: InsertWeatherForecast[] = rows.map((r) => ({
    wardId: r.ward_id,
    targetDate: r.target_date,
    horizonDays: r.horizon_days,
    rainfallMmP5: String(r.rainfall_mm_p5),
    rainfallMmP50: String(r.rainfall_mm_p50),
    rainfallMmP95: String(r.rainfall_mm_p95),
    precipitationProbability: String(r.precipitation_probability),
    temperatureCMean:
      r.temperature_c_mean != null ? String(r.temperature_c_mean) : null,
    temperatureCMax:
      r.temperature_c_max != null ? String(r.temperature_c_max) : null,
    et0Mm: r.et0_mm != null ? String(r.et0_mm) : null,
    source: r.source,
    rawResponse: r.raw_response ?? null,
    tenantId: null,
  }));
  await mirrorWeatherForecastBatch(mirrorRows);
  return supabaseOk;
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
  let observationsWritten = 0;
  for (const w of wards) {
    // Read straight off the row `listActiveWards()` already fetched —
    // no second lookup needed, `active_wards` carries `centroid`
    // directly. Replaces a hand-copied WARD_CENTROIDS_BY_ID table that
    // could silently drift from Supabase's real values (the exact
    // pattern already fixed once in wpdx.ts's centroidForTenant on
    // 2026-08-06 — this file just never got the same fix).
    const coords = w.centroid?.coordinates;
    const centroid = coords ? { lat: coords[1], lon: coords[0] } : null;
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
    // Also upsert today's observation summary so weather_data stays
    // fresh (previously stale by 7+ days). Runs after persistForecast
    // so a forecast-side failure doesn't block observation writes.
    const obs = await fetchWardObservation(w.ward_id, centroid);
    if (obs) {
      const wrote = await upsertWeatherData({
        p_ward_id: obs.ward_id,
        p_observed_date: obs.observed_date,
        p_rainfall_mm_30d: obs.rainfall_mm_30d,
        p_humidity_pct: obs.humidity_pct,
        p_temperature_c: obs.temperature_c,
        p_evapotranspiration_mm: obs.evapotranspiration_mm,
        p_source: "open-meteo",
      });
      if (wrote != null) observationsWritten += 1;
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
      observationsWritten,
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
