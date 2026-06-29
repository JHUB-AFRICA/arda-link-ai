import { logger } from "./logger.js";

// Ward centre — used as the representative point for climate queries.
// Override with WARD_CLIMATE_LAT / WARD_CLIMATE_LON env vars if needed.
export const CLIMATE_LAT_DEFAULT = parseFloat(
  process.env.WARD_CLIMATE_LAT ?? "0.355",
);
export const CLIMATE_LON_DEFAULT = parseFloat(
  process.env.WARD_CLIMATE_LON ?? "37.583",
);
const CLIMATE_LAT = CLIMATE_LAT_DEFAULT;
const CLIMATE_LON = CLIMATE_LON_DEFAULT;

// ── Types ────────────────────────────────────────────────────────────────────

export interface DailyClimate {
  date: string;
  maxTempC: number;
  minTempC: number;
  meanTempC: number;
  precipMm: number; // mm of rainfall
  et0Mm: number; // reference evapotranspiration (mm/day)
  soilMoisture0_1cm: number; // volumetric water content m³/m³, 0–1 cm layer
}

export type DroughtSeverity =
  | "none"
  | "mild"
  | "moderate"
  | "severe"
  | "extreme";

export interface ClimateSnapshot {
  fetchedAt: string;
  wardCentre: { lat: number; lon: number };
  /** Current (or latest available) conditions */
  current: {
    temperatureC: number;
    humidityPct: number;
    precipitationMm: number; // accumulated since midnight local time
  };
  /** Rolling 30-day aggregate statistics */
  rolling30Day: {
    totalPrecipMm: number;
    rainyDays: number; // days with precip > 0.5 mm
    meanTempC: number;
    maxTempC: number;
    meanET0Mm: number; // mean daily reference ET₀
    totalET0Mm: number; // cumulative 30-day ET₀
    meanSoilMoisture: number; // mean volumetric water content 0–1 cm (m³/m³)
    /**
     * Moisture Adequacy Index (MAI) = totalPrecipMm / totalET0Mm.
     * > 1.0 surplus · 0.5–1.0 adequate · 0.3–0.5 mild deficit
     * 0.1–0.3 moderate · < 0.1 severe/extreme deficit
     */
    moistureAdequacyIndex: number;
    droughtSeverity: DroughtSeverity;
    daily: DailyClimate[];
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function classifyDrought(mai: number): DroughtSeverity {
  if (mai >= 0.8) return "none";
  if (mai >= 0.5) return "mild";
  if (mai >= 0.3) return "moderate";
  if (mai >= 0.1) return "severe";
  return "extreme";
}

function mean(arr: number[]): number {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

function safeNum(v: unknown, fallback = 0): number {
  const n = Number(v);
  return isFinite(n) ? n : fallback;
}

// ── Fetcher ──────────────────────────────────────────────────────────────────

/**
 * Fetch 30-day rolling climate data for the ward from Open-Meteo.
 *
 * Uses a single API call to:
 *   https://api.open-meteo.com/v1/forecast
 * with past_days=30 — returns current conditions, daily summaries, and
 * hourly soil moisture (averaged to daily by this function).
 *
 * No API key required. Free tier covers up to 10 000 requests/day.
 */
export async function fetchClimateSnapshot(): Promise<ClimateSnapshot> {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", String(CLIMATE_LAT));
  url.searchParams.set("longitude", String(CLIMATE_LON));
  url.searchParams.set("past_days", "30");
  url.searchParams.set(
    "daily",
    [
      "temperature_2m_max",
      "temperature_2m_min",
      "temperature_2m_mean",
      "precipitation_sum",
      "et0_fao_evapotranspiration",
    ].join(","),
  );
  // Soil moisture at 0–1 cm is only available hourly — we average to daily
  url.searchParams.set("hourly", "soil_moisture_0_to_1cm");
  url.searchParams.set(
    "current",
    "temperature_2m,relative_humidity_2m,precipitation",
  );
  url.searchParams.set("timezone", "Africa/Nairobi");

  logger.info(
    { lat: CLIMATE_LAT, lon: CLIMATE_LON },
    "[Climate] Fetching Open-Meteo 30-day snapshot",
  );

  const res = await fetch(url.toString(), {
    headers: { "User-Agent": "ArdaLink-AI/1.0" },
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Open-Meteo error ${res.status}: ${text.slice(0, 200)}`);
  }

  const body = (await res.json()) as Record<string, unknown>;

  // ── Parse current conditions ──────────────────────────────────────────────
  const cur = (body["current"] ?? {}) as Record<string, unknown>;
  const current = {
    temperatureC: safeNum(cur["temperature_2m"]),
    humidityPct: safeNum(cur["relative_humidity_2m"]),
    precipitationMm: safeNum(cur["precipitation"]),
  };

  // ── Parse daily arrays ────────────────────────────────────────────────────
  const daily = (body["daily"] ?? {}) as Record<string, unknown>;
  const dates = (daily["time"] as string[] | undefined) ?? [];
  const maxTemps = (daily["temperature_2m_max"] as number[] | undefined) ?? [];
  const minTemps = (daily["temperature_2m_min"] as number[] | undefined) ?? [];
  const meanTemps =
    (daily["temperature_2m_mean"] as number[] | undefined) ?? [];
  const precipDays = (daily["precipitation_sum"] as number[] | undefined) ?? [];
  const et0Days =
    (daily["et0_fao_evapotranspiration"] as number[] | undefined) ?? [];

  // ── Average hourly soil moisture to daily ─────────────────────────────────
  const hourly = (body["hourly"] ?? {}) as Record<string, unknown>;
  const hourlyTimes = (hourly["time"] as string[] | undefined) ?? [];
  const hourlySM =
    (hourly["soil_moisture_0_to_1cm"] as (number | null)[] | undefined) ?? [];

  // Group 24 hourly values per date → daily mean
  const smByDate: Record<string, number[]> = {};
  for (let h = 0; h < hourlyTimes.length; h++) {
    const date = (hourlyTimes[h] ?? "").slice(0, 10);
    const val = hourlySM[h];
    if (date && val != null && isFinite(val)) {
      (smByDate[date] ??= []).push(val);
    }
  }

  // ── Build daily records (last 30 days, excluding today's forecast) ────────
  const today = new Date().toISOString().slice(0, 10);
  const dailyRecords: DailyClimate[] = [];

  for (let i = 0; i < dates.length; i++) {
    const date = dates[i] ?? "";
    if (!date || date > today) continue; // skip future dates
    if (dailyRecords.length >= 30) break; // cap at 30 days

    const sm = smByDate[date] ? mean(smByDate[date]!) : 0;

    dailyRecords.push({
      date,
      maxTempC: safeNum(maxTemps[i]),
      minTempC: safeNum(minTemps[i]),
      meanTempC: safeNum(meanTemps[i]),
      precipMm: safeNum(precipDays[i]),
      et0Mm: safeNum(et0Days[i]),
      soilMoisture0_1cm: parseFloat(sm.toFixed(4)),
    });
  }

  // ── Aggregate 30-day stats ────────────────────────────────────────────────
  const totalPrecip = dailyRecords.reduce((s, d) => s + d.precipMm, 0);
  const totalET0 = dailyRecords.reduce((s, d) => s + d.et0Mm, 0);
  const rainyDays = dailyRecords.filter((d) => d.precipMm > 0.5).length;
  const meanTemp = parseFloat(
    mean(dailyRecords.map((d) => d.meanTempC)).toFixed(1),
  );
  const maxTemp = parseFloat(
    Math.max(...dailyRecords.map((d) => d.maxTempC)).toFixed(1),
  );
  const meanET0 = parseFloat(
    (totalET0 / (dailyRecords.length || 1)).toFixed(2),
  );
  const meanSM = parseFloat(
    mean(dailyRecords.map((d) => d.soilMoisture0_1cm)).toFixed(4),
  );

  // Moisture Adequacy Index: how much of water demand was met by rain
  const mai = totalET0 > 0 ? totalPrecip / totalET0 : 0;
  const roundedMAI = parseFloat(mai.toFixed(3));

  const snapshot: ClimateSnapshot = {
    fetchedAt: new Date().toISOString(),
    wardCentre: { lat: CLIMATE_LAT, lon: CLIMATE_LON },
    current,
    rolling30Day: {
      totalPrecipMm: parseFloat(totalPrecip.toFixed(1)),
      rainyDays,
      meanTempC: meanTemp,
      maxTempC: isFinite(maxTemp) ? maxTemp : 0,
      meanET0Mm: meanET0,
      totalET0Mm: parseFloat(totalET0.toFixed(1)),
      meanSoilMoisture: meanSM,
      moistureAdequacyIndex: roundedMAI,
      droughtSeverity: classifyDrought(roundedMAI),
      daily: dailyRecords,
    },
  };

  logger.info(
    {
      days: dailyRecords.length,
      totalPrecipMm: snapshot.rolling30Day.totalPrecipMm,
      rainyDays,
      meanTempC: meanTemp,
      mai: roundedMAI,
      droughtSeverity: snapshot.rolling30Day.droughtSeverity,
      meanSoilMoisture: meanSM,
    },
    "[Climate] 30-day snapshot ready",
  );

  return snapshot;
}

// ── Human-readable severity strings ─────────────────────────────────────────

export function droughtLabel(severity: DroughtSeverity): string {
  return {
    none: "adequate water",
    mild: "mild moisture deficit",
    moderate: "moderate drought stress",
    severe: "severe drought",
    extreme: "extreme drought",
  }[severity];
}

export function maiLabel(mai: number): string {
  if (mai >= 0.8)
    return `${Math.round(mai * 100)}% of water demand was met by rain`;
  return `rainfall covered only ${Math.round(mai * 100)}% of crop/pasture water demand`;
}
