/**
 * Open-Meteo Air Quality (CAMS ensemble) — PM2.5/PM10. Dust-storm
 * context for herder briefings ("the air is bad today, stay close
 * to water").
 */

import { CLIMATE_LAT_DEFAULT, CLIMATE_LON_DEFAULT } from "../climate.js";

export interface AirQualitySnapshot {
  fetchedAt: string;
  wardCentre: { lat: number; lon: number };
  pm2_5UgM3: number;
  pm10UgM3: number;
  source: "open-meteo-air-quality";
  license: "CC-BY 4.0 (Open-Meteo / CAMS ensemble)";
}

export async function fetchAirQualitySnapshot(
  lat = CLIMATE_LAT_DEFAULT,
  lon = CLIMATE_LON_DEFAULT,
): Promise<AirQualitySnapshot> {
  const url = new URL("https://air-quality-api.open-meteo.com/v1/air-quality");
  url.searchParams.set("latitude", String(lat));
  url.searchParams.set("longitude", String(lon));
  url.searchParams.set("current", "pm10,pm2_5");
  url.searchParams.set("timezone", "Africa/Nairobi");

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 15_000);
  let res: Response;
  try {
    res = await fetch(url, { signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(
      `Open-Meteo Air Quality ${res.status}: ${text.slice(0, 200)}`,
    );
  }
  const data = (await res.json()) as {
    current: {
      pm10: number;
      pm2_5: number;
      time: string;
    };
  };
  return {
    fetchedAt: data.current.time ?? new Date().toISOString(),
    wardCentre: { lat, lon },
    pm2_5UgM3: parseFloat(data.current.pm2_5.toFixed(1)),
    pm10UgM3: parseFloat(data.current.pm10.toFixed(1)),
    source: "open-meteo-air-quality",
    license: "CC-BY 4.0 (Open-Meteo / CAMS ensemble)",
  };
}
