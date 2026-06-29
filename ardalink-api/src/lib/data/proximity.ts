// Proximity helpers — precompute nearest water point for every named landmark
// so the AI can answer "how far to water?" *itself* instead of putting that
// burden on the herder. Distances are great-circle (haversine), good enough
// for the few-km scale of Bula Pesa Ward.

import { BULA_PESA_LANDMARKS, type Landmark } from "./bulaPesaLandmarks.js";
import {
  BULA_PESA_WATER_POINTS,
  type WaterPoint,
} from "./bulaPesaWaterPoints.js";

const EARTH_RADIUS_KM = 6371;

export function haversineKm(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

export interface NearestWaterPoint {
  waterPoint: WaterPoint;
  distanceKm: number;
}

/** Top-N nearest water points to a given lat/lon. */
export function nearestWaterPoints(
  origin: { lat: number; lon: number },
  n = 2,
): NearestWaterPoint[] {
  return BULA_PESA_WATER_POINTS.map((wp) => ({
    waterPoint: wp,
    distanceKm: haversineKm(origin, wp),
  }))
    .sort((a, b) => a.distanceKm - b.distanceKm)
    .slice(0, n);
}

/** Single nearest water point to a named landmark, or null if landmark unknown. */
export function nearestWaterPointForLandmark(
  landmarkName: string,
): NearestWaterPoint | null {
  const lm = BULA_PESA_LANDMARKS.find(
    (l) => l.name.toLowerCase() === landmarkName.toLowerCase(),
  );
  if (!lm) return null;
  const [first] = nearestWaterPoints(lm, 1);
  return first ?? null;
}

/**
 * Render a compact "landmark → nearest water point + km" cheat-sheet for the
 * AI to consult during a call. Grouped by quadrant, deduped by water point so
 * the prompt stays short. The model sees this and can quote distances itself.
 */
export function formatProximityBlock(): string {
  const byQuad: Record<
    string,
    Array<{ lm: Landmark; nw: NearestWaterPoint }>
  > = {
    NW: [],
    NE: [],
    SW: [],
    SE: [],
  };
  for (const lm of BULA_PESA_LANDMARKS) {
    const [nw] = nearestWaterPoints(lm, 1);
    if (!nw) continue;
    byQuad[lm.quadrant].push({ lm, nw });
  }

  // Keep the cheat sheet tight — at most 8 landmark→water lines per quadrant,
  // preferring distinct water points so we cover the whole ward.
  const lines: string[] = [
    "PROXIMITY CHEAT-SHEET (landmark → nearest known water point, km):",
    "Use this to ANSWER the distance question yourself. Do NOT ask the herder for kilometres — they don't think in km. Instead, when they name a place, say:",
    '  Swahili: "…basi uko karibu na <water point>, ni karibu km <X> kutoka <landmark>, sivyo?"',
    '  English: "…so you\'re near <water point>, about <X> km from <landmark>, right?"',
    "and let them confirm or correct. Only use entries below — never invent a distance.",
    "NOTE: distances are straight-line (as the crow flies). Real walking routes are longer, so if the herder says it feels further, trust them and classify conservatively near the 5 km / 10 km thresholds.",
    "",
  ];

  for (const q of ["NW", "NE", "SW", "SE"] as const) {
    const entries = byQuad[q];
    if (entries.length === 0) continue;
    const seenWp = new Set<number>();
    const picked: Array<{ lm: Landmark; nw: NearestWaterPoint }> = [];
    for (const e of entries) {
      if (seenWp.has(e.nw.waterPoint.id)) continue;
      seenWp.add(e.nw.waterPoint.id);
      picked.push(e);
      if (picked.length >= 8) break;
    }
    lines.push(`[${q}]`);
    for (const { lm, nw } of picked) {
      lines.push(
        `  ${lm.name} → ${nw.waterPoint.name} (${nw.waterPoint.type}) · ${nw.distanceKm.toFixed(1)} km`,
      );
    }
  }

  return lines.join("\n");
}
