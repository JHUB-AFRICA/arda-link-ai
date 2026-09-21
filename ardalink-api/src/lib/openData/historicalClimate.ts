/**
 * Open-Meteo Archive (ERA5-based; goes back to 1940) — historical
 * climate windows + year-over-year comparison against the live
 * rolling-30-day snapshot.
 */

import { CLIMATE_LAT_DEFAULT, CLIMATE_LON_DEFAULT } from "../climate.js";

export interface HistoricalClimateWindow {
  startDate: string; // YYYY-MM-DD
  endDate: string;
  days: number;
  totalPrecipMm: number;
  totalET0Mm: number;
  rainyDays: number;
  meanTempC: number;
  meanMaxTempC: number;
  moistureAdequacyIndex: number; // totalPrecip / totalET0
  droughtSeverity:
    | "none"
    | "mild"
    | "moderate"
    | "severe"
    | "extreme";
  source: "open-meteo-archive";
  license: "CC-BY 4.0 (Open-Meteo / ERA5 / CHIRPS blend)";
}

function classifyDrought(mai: number): HistoricalClimateWindow["droughtSeverity"] {
  if (mai >= 0.8) return "none";
  if (mai >= 0.5) return "mild";
  if (mai >= 0.3) return "moderate";
  if (mai >= 0.1) return "severe";
  return "extreme";
}

/**
 * Fetch a climate window from Open-Meteo's historical archive.
 * Same shape as the rolling-30-day block we compute for the live climate
 * snapshot, so callers can compare "now" vs "this window last year".
 */
export async function fetchHistoricalClimateWindow(
  lat: number,
  lon: number,
  startDate: string,
  endDate: string,
): Promise<HistoricalClimateWindow> {
  const url = new URL("https://archive-api.open-meteo.com/v1/archive");
  url.searchParams.set("latitude", String(lat));
  url.searchParams.set("longitude", String(lon));
  url.searchParams.set("start_date", startDate);
  url.searchParams.set("end_date", endDate);
  url.searchParams.set("timezone", "Africa/Nairobi");
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

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 20_000);
  let res: Response;
  try {
    res = await fetch(url, { signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(
      `Open-Meteo Archive ${res.status}: ${text.slice(0, 200)}`,
    );
  }
  const data = (await res.json()) as {
    daily: {
      time: string[];
      precipitation_sum: (number | null)[];
      temperature_2m_max: (number | null)[];
      temperature_2m_min: (number | null)[];
      temperature_2m_mean: (number | null)[];
      et0_fao_evapotranspiration: (number | null)[];
    };
  };

  const numOrZero = (v: number | null | undefined) =>
    typeof v === "number" && Number.isFinite(v) ? v : 0;
  const sum = (arr: (number | null | undefined)[]) =>
    arr.reduce<number>((acc, v) => acc + numOrZero(v), 0);
  const mean = (arr: (number | null | undefined)[]) => {
    const valid = arr.filter(
      (v): v is number => typeof v === "number" && Number.isFinite(v),
    );
    return valid.length ? sum(valid) / valid.length : 0;
  };

  const totalPrecip = sum(data.daily.precipitation_sum);
  const totalET0 = sum(data.daily.et0_fao_evapotranspiration);
  const rainyDays = data.daily.precipitation_sum.filter(
    (v) => numOrZero(v) > 0.5,
  ).length;
  const mai = totalET0 > 0 ? totalPrecip / totalET0 : 0;

  return {
    startDate,
    endDate,
    days: data.daily.time.length,
    totalPrecipMm: parseFloat(totalPrecip.toFixed(2)),
    totalET0Mm: parseFloat(totalET0.toFixed(2)),
    rainyDays,
    meanTempC: parseFloat(mean(data.daily.temperature_2m_mean).toFixed(2)),
    meanMaxTempC: parseFloat(mean(data.daily.temperature_2m_max).toFixed(2)),
    moistureAdequacyIndex: parseFloat(mai.toFixed(3)),
    droughtSeverity: classifyDrought(mai),
    source: "open-meteo-archive",
    license: "CC-BY 4.0 (Open-Meteo / ERA5 / CHIRPS blend)",
  };
}

/**
 * Compute the same calendar window one year earlier (used as a "last
 * year" baseline) for comparison with the live rolling 30-day snapshot.
 */
export async function fetchYearOverYearClimate(
  lat = CLIMATE_LAT_DEFAULT,
  lon = CLIMATE_LON_DEFAULT,
  windowDays = 30,
): Promise<{
  current: HistoricalClimateWindow;
  lastYear: HistoricalClimateWindow;
  comparison: {
    precipDeltaMm: number;
    precipDeltaPct: number;
    tempDeltaC: number;
    severityShift: string;
    interpretation: string;
  };
}> {
  const today = new Date();
  const currentEnd = new Date(today);
  const currentStart = new Date(today);
  currentStart.setDate(currentStart.getDate() - windowDays);
  const lastYearEnd = new Date(currentEnd);
  lastYearEnd.setFullYear(lastYearEnd.getFullYear() - 1);
  const lastYearStart = new Date(currentStart);
  lastYearStart.setFullYear(lastYearStart.getFullYear() - 1);

  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  // Sequential rather than parallel — Open-Meteo Archive occasionally
  // throws ETIMEDOUT when two requests share the same TLS connection.
  const current = await fetchHistoricalClimateWindow(
    lat,
    lon,
    fmt(currentStart),
    fmt(currentEnd),
  );
  const lastYear = await fetchHistoricalClimateWindow(
    lat,
    lon,
    fmt(lastYearStart),
    fmt(lastYearEnd),
  );

  const precipDeltaMm = current.totalPrecipMm - lastYear.totalPrecipMm;
  const precipDeltaPct =
    lastYear.totalPrecipMm > 0
      ? parseFloat(((precipDeltaMm / lastYear.totalPrecipMm) * 100).toFixed(1))
      : 0;
  const tempDeltaC = parseFloat(
    (current.meanTempC - lastYear.meanTempC).toFixed(2),
  );
  const severityShift =
    current.droughtSeverity === lastYear.droughtSeverity
      ? "no change"
      : `${lastYear.droughtSeverity} → ${current.droughtSeverity}`;

  let interpretation: string;
  if (precipDeltaMm < -10) {
    interpretation = `Significantly drier than the same window last year (−${Math.abs(precipDeltaMm).toFixed(1)} mm). Pasture stress likely elevated.`;
  } else if (precipDeltaMm < -2) {
    interpretation = `Drier than last year (−${Math.abs(precipDeltaMm).toFixed(1)} mm). Monitor grazing pressure.`;
  } else if (precipDeltaMm > 10) {
    interpretation = `Wetter than last year (+${precipDeltaMm.toFixed(1)} mm). Conditions have improved.`;
  } else {
    interpretation = `Within ±2 mm of last year — no major climatic shift.`;
  }

  return {
    current,
    lastYear,
    comparison: {
      precipDeltaMm: parseFloat(precipDeltaMm.toFixed(2)),
      precipDeltaPct,
      tempDeltaC,
      severityShift,
      interpretation,
    },
  };
}
