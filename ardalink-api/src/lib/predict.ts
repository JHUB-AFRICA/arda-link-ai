/**
 * predict.ts — Vegetation stress forecast for Bula Pesa Ward
 *
 * Combines three signals:
 *  1. 14-day weather forecast from Open-Meteo (free, no API key)
 *  2. Engine's `baseline_aggregate` table — seasonal NDVI trajectory
 *  3. Current satellite state (stressed pixel %, anomaly, MAI)
 *
 * Output: 14-day vegetation risk outlook + recovery estimate + recommendation.
 */

import { fetchBaselineAggregate } from "./engine.js";
import { logger } from "./logger.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export type RiskLevel = "low" | "moderate" | "high" | "critical";
export type StressDir = "improving" | "stable" | "worsening";
export type Confidence = "low" | "medium" | "high";
export type SeasonTrend = "improving" | "declining" | "stable";

export interface DailyForecast {
  date: string;
  precipMm: number;
  et0Mm: number;
  maxTempC: number;
}

export interface ForecastWindow {
  totalPrecipMm: number;
  totalET0Mm: number;
  /**
   * Rain that actually reaches roots = max(0, precip − ET₀ × 0.40).
   * In semi-arid areas ~40 % of ET₀ is satisfied by bare-soil evaporation
   * before plant-available water accumulates.
   */
  effectiveRainMm: number;
  forecastMAI: number; // precip / ET₀ — <0.3 = deficit, >0.7 = adequate
  rainyDays: number;
  peakPrecipDate: string;
  peakPrecipMm: number;
  daily: DailyForecast[];
}

export interface SeasonalContext {
  currentMonthNDVI: number;
  nextMonthNDVI: number;
  twoMonthsNDVI: number;
  trend: SeasonTrend;
  trendPct: number; // % change expected current → next month
}

export interface VegetationForecast {
  generatedAt: string;
  horizon: 14;
  /** 14-day precipitation & evaporation outlook */
  forecast14d: ForecastWindow;
  /** Expected seasonal NDVI trajectory from the engine's baseline_aggregate */
  seasonal: SeasonalContext;
  /** Combined 44-day MAI (30-day past + 14-day future) */
  combinedMAI: number;
  outlook: {
    stressDirection: StressDir;
    riskLevel: RiskLevel;
    confidence: Confidence;
    /**
     * Estimated days until stressed-pixel percentage drops below 25 %.
     * null = no recovery expected this season based on forecast.
     */
    estimatedRecoveryDays: number | null;
    summary: string;
    recommendation: string;
    keyDrivers: string[];
  };
}

// ── Ward climate coordinates ──────────────────────────────────────────────────

const WARD_LAT = parseFloat(process.env.WARD_CLIMATE_LAT ?? "0.355");
const WARD_LON = parseFloat(process.env.WARD_CLIMATE_LON ?? "37.583");

// ── Fetch 14-day weather forecast from Open-Meteo ────────────────────────────

async function fetchForecastWindow(): Promise<ForecastWindow> {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", String(WARD_LAT));
  url.searchParams.set("longitude", String(WARD_LON));
  url.searchParams.set("forecast_days", "14");
  url.searchParams.set(
    "daily",
    [
      "precipitation_sum",
      "et0_fao_evapotranspiration",
      "temperature_2m_max",
    ].join(","),
  );
  url.searchParams.set("timezone", "Africa/Nairobi");

  const res = await fetch(url.toString(), {
    headers: { "User-Agent": "ArdaLink-AI/1.0" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(
      `Open-Meteo forecast error ${res.status}: ${t.slice(0, 200)}`,
    );
  }

  const body = (await res.json()) as Record<string, unknown>;
  const daily = (body["daily"] ?? {}) as Record<string, unknown>;

  const dates = (daily["time"] as string[] | undefined) ?? [];
  const precip =
    (daily["precipitation_sum"] as (number | null)[] | undefined) ?? [];
  const et0 =
    (daily["et0_fao_evapotranspiration"] as (number | null)[] | undefined) ??
    [];
  const maxTemp =
    (daily["temperature_2m_max"] as (number | null)[] | undefined) ?? [];

  const safeNum = (v: number | null | undefined) =>
    v != null && isFinite(v) ? v : 0;

  const dailyRecords: DailyForecast[] = dates.map((date, i) => ({
    date,
    precipMm: safeNum(precip[i]),
    et0Mm: safeNum(et0[i]),
    maxTempC: safeNum(maxTemp[i]),
  }));

  const totalPrecip = dailyRecords.reduce((s, d) => s + d.precipMm, 0);
  const totalET0 = dailyRecords.reduce((s, d) => s + d.et0Mm, 0);
  const rainyDays = dailyRecords.filter((d) => d.precipMm > 0.5).length;

  // ET₀ = total water demand; 40% is met by bare-soil evaporation, leaving
  // 60% that must be met by rain for plants to have any. Beyond ET₀×0.6,
  // excess rain becomes effective root-zone moisture.
  const ET0_EVAP_FRACTION = 0.4;
  const effectiveRain = Math.max(0, totalPrecip - totalET0 * ET0_EVAP_FRACTION);

  const peakDay = dailyRecords.reduce(
    (best, d) => (d.precipMm > best.precipMm ? d : best),
    dailyRecords[0] ?? { date: "", precipMm: 0, et0Mm: 0, maxTempC: 0 },
  );

  const forecastMAI = totalET0 > 0 ? totalPrecip / totalET0 : 0;

  logger.info(
    {
      totalPrecip: totalPrecip.toFixed(1),
      totalET0: totalET0.toFixed(1),
      effectiveRain: effectiveRain.toFixed(1),
      forecastMAI: forecastMAI.toFixed(3),
      rainyDays,
      peakPrecipDate: peakDay.date,
    },
    "[Forecast] 14-day weather window fetched",
  );

  return {
    totalPrecipMm: parseFloat(totalPrecip.toFixed(1)),
    totalET0Mm: parseFloat(totalET0.toFixed(1)),
    effectiveRainMm: parseFloat(effectiveRain.toFixed(1)),
    forecastMAI: parseFloat(forecastMAI.toFixed(3)),
    rainyDays,
    peakPrecipDate: peakDay.date,
    peakPrecipMm: parseFloat(peakDay.precipMm.toFixed(1)),
    daily: dailyRecords,
  };
}

// ── Load seasonal context from the engine's baseline_aggregate ──────────────

async function fetchSeasonalContext(
  currentMonth: number,
): Promise<SeasonalContext> {
  const nextMonth = (currentMonth % 12) + 1;
  const twoMonthsAhead = (nextMonth % 12) + 1;

  // Pull (current, next, +2 months) NDVI p50 from the engine. Missing
  // months fall back to 0; the caller treats that as "no baseline yet" via
  // the trend direction (stable).
  // Tenant slug → ward display name. The engine resolves name → wardcode.
  const { TENANT_HOME_WARD } = await import("./geoHelpers.js");
  const wardName = TENANT_HOME_WARD["bula-pesa"] ?? "Bulla Pesa";
  const months = [currentMonth, nextMonth, twoMonthsAhead];
  const results = await Promise.all(
    months.map((m) =>
      fetchBaselineAggregate(wardName, m).then((row) => row?.ndvi_p50 ?? 0),
    ),
  );

  const [curNDVI, nxtNDVI, t2NDVI] = results as [number, number, number];

  const trendPct =
    curNDVI > 0
      ? parseFloat((((nxtNDVI - curNDVI) / Math.abs(curNDVI)) * 100).toFixed(2))
      : 0;

  const trend: SeasonTrend =
    trendPct > 5 ? "improving" : trendPct < -5 ? "declining" : "stable";

  logger.info(
    { currentMonth, nextMonth, curNDVI, nxtNDVI, t2NDVI, trendPct, trend },
    "[Forecast] Seasonal NDVI trajectory loaded",
  );

  return {
    currentMonthNDVI: curNDVI,
    nextMonthNDVI: nxtNDVI,
    twoMonthsNDVI: t2NDVI,
    trend,
    trendPct,
  };
}

// ── Core forecast computation ─────────────────────────────────────────────────

/**
 * Estimate how many days until the ward recovers below a 25% stress threshold.
 *
 * Model: semi-arid grass responds to accumulated effective rain.
 *   - Each 10mm of effective rain reduces stressed pixels by ~4–6%
 *   - We use 5% per 10mm as a central estimate
 *   - We then check if the linear recovery path crosses 25% within 90 days
 */
function estimateRecoveryDays(
  stressedPct: number,
  effectiveRain14d: number,
  seasonal: SeasonalContext,
): number | null {
  const TARGET_STRESS = 25; // recovery threshold
  const deficit = stressedPct - TARGET_STRESS;
  if (deficit <= 0) return 0; // already recovered

  // Recovery rate: % stress reduction per 10mm effective rain
  const RECOVERY_RATE = 5;
  const effectiveRainPerDay = effectiveRain14d / 14;

  // Also add seasonal recovery contribution if trend is improving
  // (natural phenological recovery even without rain)
  const seasonalBonus =
    seasonal.trend === "improving"
      ? Math.abs(seasonal.trendPct) * 0.03 // ~3% of the NDVI gain translates to stress relief per day
      : 0;

  const dailyRecoveryPct =
    (effectiveRainPerDay / 10) * RECOVERY_RATE + seasonalBonus;

  if (dailyRecoveryPct <= 0.02) return null; // effectively no recovery

  const days = Math.ceil(deficit / dailyRecoveryPct);
  return days > 90 ? null : days;
}

function classifyRisk(
  stressedPct: number,
  forecastMAI: number,
  seasonal: SeasonalContext,
): RiskLevel {
  const declining = seasonal.trend === "declining";
  const improving = seasonal.trend === "improving";

  if (stressedPct > 50 && forecastMAI < 0.15 && declining) return "critical";
  if (stressedPct > 50 && forecastMAI < 0.2) return "critical";
  if (stressedPct > 40 && forecastMAI < 0.3 && declining) return "high";
  if (stressedPct > 40 || forecastMAI < 0.25) return "high";
  if (stressedPct > 20 || (forecastMAI < 0.5 && !improving)) return "moderate";
  return "low";
}

function classifyDirection(
  forecastMAI: number,
  seasonal: SeasonalContext,
  currentMAI: number,
): StressDir {
  if (
    forecastMAI >= 0.65 ||
    (forecastMAI >= 0.45 && seasonal.trend === "improving")
  )
    return "improving";
  if (
    forecastMAI < 0.2 ||
    (forecastMAI < 0.35 && seasonal.trend === "declining")
  )
    return "worsening";
  // Slight improvement vs past — call stable
  if (forecastMAI > currentMAI * 1.2 && seasonal.trend !== "declining")
    return "improving";
  return "stable";
}

function classifyConfidence(
  forecastMAI: number,
  stressedPct: number,
): Confidence {
  // High confidence when signals align strongly
  if (
    (forecastMAI < 0.2 && stressedPct > 45) ||
    (forecastMAI > 0.7 && stressedPct < 20)
  )
    return "high";
  if (forecastMAI < 0.35 || forecastMAI > 0.6) return "medium";
  return "low";
}

function buildSummary(
  direction: StressDir,
  riskLevel: RiskLevel,
  forecast14d: ForecastWindow,
  seasonal: SeasonalContext,
): string {
  const rain = forecast14d.totalPrecipMm.toFixed(0);
  const eff = forecast14d.effectiveRainMm.toFixed(0);

  if (direction === "improving") {
    return seasonal.trend === "improving"
      ? `${rain}mm of rain expected + seasonal recovery underway — stress likely to ease over the next 2–3 weeks.`
      : `${rain}mm of rain forecast; effective root-zone input ${eff}mm — moderate recovery likely.`;
  }
  if (direction === "worsening") {
    return forecast14d.effectiveRainMm < 5
      ? `Only ${rain}mm expected over 14 days — far below ${forecast14d.totalET0Mm.toFixed(0)}mm evaporation demand. Stress will deepen.`
      : `Rain (${rain}mm) will not keep up with evaporation (${forecast14d.totalET0Mm.toFixed(0)}mm). ${riskLevel === "critical" ? "Critical" : "High"} stress likely to persist.`;
  }
  // stable
  return `${rain}mm of rain expected — enough to slow further deterioration but unlikely to trigger significant recovery.`;
}

function buildRecommendation(
  riskLevel: RiskLevel,
  direction: StressDir,
  worstQuadrant: string,
  seasonal: SeasonalContext,
  forecast14d: ForecastWindow,
): string {
  const seasonNote =
    seasonal.trend === "improving"
      ? "Rainy season is historically approaching — recovery should follow."
      : seasonal.trend === "declining"
        ? "Dry season is deepening; plan for extended stress."
        : "";

  if (riskLevel === "critical") {
    return (
      `Reduce herd load urgently — remaining vegetation cannot support current numbers. ` +
      `Move animals away from the ${worstQuadrant} area where stress is most severe. ` +
      `Locate and secure all water points now. ` +
      (seasonNote
        ? seasonNote
        : "No natural recovery expected in the next 2–3 weeks.")
    );
  }
  if (riskLevel === "high") {
    if (direction === "worsening") {
      return (
        `Begin rotational grazing immediately — rest the ${worstQuadrant} area for at least 3 weeks. ` +
        `Monitor water points daily and plan supplementary feeding if rain does not arrive. ` +
        (seasonNote || "")
      );
    }
    return (
      `Restrict grazing pressure on the ${worstQuadrant}. ` +
      (forecast14d.effectiveRainMm > 10
        ? `${forecast14d.effectiveRainMm.toFixed(0)}mm of effective rain expected — partial recovery possible in 2–3 weeks if grazing pressure is reduced.`
        : "Conserve remaining grass by reducing stocking density.") +
      (seasonNote ? " " + seasonNote : "")
    );
  }
  if (riskLevel === "moderate") {
    return (
      `Rotate away from ${worstQuadrant !== "uniform" ? `the ${worstQuadrant}` : "stressed areas"} and allow 3 weeks rest. ` +
      (forecast14d.totalPrecipMm > 20
        ? `${forecast14d.totalPrecipMm.toFixed(0)}mm of rain expected — monitor recovery closely.`
        : "Avoid overgrazing recovering patches.") +
      (seasonNote ? " " + seasonNote : "")
    );
  }
  // low
  return (
    `Conditions manageable — continue current grazing pattern. ` +
    (worstQuadrant !== "uniform"
      ? `Watch the ${worstQuadrant} area for early stress signs. `
      : "") +
    (seasonNote || "")
  );
}

function buildKeyDrivers(
  forecast14d: ForecastWindow,
  seasonal: SeasonalContext,
  stressedPct: number,
  currentMAI: number,
): string[] {
  const drivers: string[] = [];

  // Forecast signal
  if (forecast14d.forecastMAI < 0.25) {
    drivers.push(
      `14-day forecast: only ${forecast14d.totalPrecipMm.toFixed(0)}mm rain vs ` +
        `${forecast14d.totalET0Mm.toFixed(0)}mm potential evaporation — soil will lose more water than it gains`,
    );
  } else if (forecast14d.forecastMAI >= 0.65) {
    drivers.push(
      `${forecast14d.totalPrecipMm.toFixed(0)}mm of rain expected — ` +
        `${forecast14d.effectiveRainMm.toFixed(0)}mm will reach roots and ease vegetation stress`,
    );
  } else {
    drivers.push(
      `Partial rainfall expected (${forecast14d.totalPrecipMm.toFixed(0)}mm / ` +
        `${forecast14d.totalET0Mm.toFixed(0)}mm demand) — not enough for full recovery`,
    );
  }

  // Seasonal signal
  if (seasonal.trend === "declining") {
    drivers.push(
      `Seasonal dry-down: NDVI historically drops ${Math.abs(seasonal.trendPct).toFixed(0)}% ` +
        `in the coming weeks — natural conditions will not compensate for current deficit`,
    );
  } else if (seasonal.trend === "improving") {
    drivers.push(
      `Rainy season onset: NDVI historically rises ${seasonal.trendPct.toFixed(0)}% ` +
        `in the coming weeks — seasonal recovery expected even without exceptional rainfall`,
    );
  }

  // Current stress signal
  if (stressedPct > 45) {
    drivers.push(
      `Current stress is severe (${stressedPct.toFixed(0)}% of pixels below 11-year norm) — ` +
        `high stress slows vegetation response to rain`,
    );
  } else if (stressedPct < 20) {
    drivers.push(
      `Relatively few pixels stressed (${stressedPct.toFixed(0)}%) — resilient baseline means faster recovery`,
    );
  }

  // MAI trend
  if (currentMAI < 0.3 && forecast14d.forecastMAI > currentMAI * 1.5) {
    drivers.push(
      `Forecast MAI (${forecast14d.forecastMAI.toFixed(2)}) better than recent 30-day MAI ` +
        `(${currentMAI.toFixed(2)}) — conditions improving relative to recent past`,
    );
  }

  return drivers.slice(0, 3); // cap at 3 drivers
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface ForecastInputs {
  /** Current ward stressed pixel percentage */
  stressedPixelPct: number;
  /** Worst-stressed quadrant from satellite */
  worstQuadrant: string;
  /** 30-day Moisture Adequacy Index from climate layer */
  currentMAI: number;
  /** Current calendar month (1–12) */
  month: number;
}

/**
 * Compute a 14-day vegetation stress forecast.
 * Fetches the Open-Meteo forecast + Cosmos DB seasonal baselines in parallel.
 */
export async function computeForecast(
  inputs: ForecastInputs,
): Promise<VegetationForecast> {
  const { stressedPixelPct, worstQuadrant, currentMAI, month } = inputs;

  // Parallel fetch: weather forecast + seasonal baselines
  const [forecast14d, seasonal] = await Promise.all([
    fetchForecastWindow(),
    fetchSeasonalContext(month),
  ]);

  // Combined 44-day MAI
  // Assume 30-day past precipitation ≈ currentMAI × typical ET₀
  // (We normalise by holding ET₀ constant; the ratio is the key signal.)
  const combinedMAI = parseFloat(
    (
      ((currentMAI * 30 * forecast14d.totalET0Mm) / 14 +
        forecast14d.totalPrecipMm) /
      ((30 * forecast14d.totalET0Mm) / 14 + forecast14d.totalET0Mm)
    ).toFixed(3),
  );

  const direction = classifyDirection(
    forecast14d.forecastMAI,
    seasonal,
    currentMAI,
  );
  const riskLevel = classifyRisk(
    stressedPixelPct,
    forecast14d.forecastMAI,
    seasonal,
  );
  const confidence = classifyConfidence(
    forecast14d.forecastMAI,
    stressedPixelPct,
  );
  const estimatedRecoveryDays = estimateRecoveryDays(
    stressedPixelPct,
    forecast14d.effectiveRainMm,
    seasonal,
  );

  const summary = buildSummary(direction, riskLevel, forecast14d, seasonal);
  const recommendation = buildRecommendation(
    riskLevel,
    direction,
    worstQuadrant,
    seasonal,
    forecast14d,
  );
  const keyDrivers = buildKeyDrivers(
    forecast14d,
    seasonal,
    stressedPixelPct,
    currentMAI,
  );

  const forecast: VegetationForecast = {
    generatedAt: new Date().toISOString(),
    horizon: 14,
    forecast14d,
    seasonal,
    combinedMAI,
    outlook: {
      stressDirection: direction,
      riskLevel,
      confidence,
      estimatedRecoveryDays,
      summary,
      recommendation,
      keyDrivers,
    },
  };

  logger.info(
    {
      forecastMAI: forecast14d.forecastMAI,
      combinedMAI,
      direction,
      riskLevel,
      confidence,
      estimatedRecoveryDays,
    },
    "[Forecast] Vegetation outlook computed",
  );

  return forecast;
}
