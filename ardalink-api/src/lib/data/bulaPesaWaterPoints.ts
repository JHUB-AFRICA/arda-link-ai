import { BULA_PESA_LANDMARKS } from "./bulaPesaLandmarks.js";

// AUTO-GENERATED from OpenStreetMap (Overpass API) on 2026-05-20.
// Ground-truth water points inside the Bula Pesa Ward bounding box
// (BBOX: 0.28284..0.42715°N, 37.51149..37.65473°E). Re-pull with
// scripts/pullWaterPoints.ts when refreshing for production.
//
// Source: OSM contributors, ODbL. Attributes preserved where present:
//   operator, funder, project_status, quality.
// Anything not in this file is UNKNOWN — the AI must not invent specs.

export type WaterPointType =
  | "borehole"
  | "well"
  | "water_tower"
  | "drinking_water_point"
  | "livestock_watering_point"
  | "spring"
  | "water_point";

export interface WaterPoint {
  id: number;
  name: string;
  type: WaterPointType;
  lat: number;
  lon: number;
  quadrant: "NW" | "NE" | "SW" | "SE";
  area: string;
  village: string | null;
  operator: string | null;
  funder: string | null;
  status: string | null;
  quality: string | null;
}

/**
 * Returns true when OSM carries any operator/funder/status/quality field
 * for this point. This is a metadata-richness proxy, NOT proof that the
 * OSM name matches what locals call the site — but in practice the two
 * correlate well: when a real organisation (NGO, government, water
 * utility) has been recorded against a point, the name was almost
 * always sourced from them rather than from a passing OSM volunteer.
 * Use it as "name confidence", and keep the unconfirmed caveat for the
 * rest.
 */
export function hasMetadataBackedName(p: WaterPoint): boolean {
  return Boolean(p.operator || p.funder || p.status || p.quality);
}

export const BULA_PESA_WATER_POINTS: readonly WaterPoint[] = Object.freeze([
  {
    id: 3003029859,
    name: "Borehole at Kambi Garba",
    type: "borehole",
    lat: 0.3995,
    lon: 37.59629,
    quadrant: "NE",
    area: "Ngare Mara area (NE)",
    village: "kambi garba",
    operator: "group",
    funder: null,
    status: null,
    quality: null,
  },
  {
    id: 3283811150,
    name: "Borehole at Kambi Garba",
    type: "borehole",
    lat: 0.3986,
    lon: 37.59515,
    quadrant: "NE",
    area: "Ngare Mara area (NE)",
    village: "kambi garba",
    operator: "group",
    funder: null,
    status: null,
    quality: null,
  },
  {
    id: 3283811967,
    name: "Chumvi Borehole",
    type: "borehole",
    lat: 0.41907,
    lon: 37.63999,
    quadrant: "NE",
    area: "Ngare Mara area (NE)",
    village: "chumvi",
    operator: "ngo",
    funder: "red cross",
    status: "complete",
    quality: "very_good",
  },
  {
    id: 3807039108,
    name: "Didmas Ekal",
    type: "well",
    lat: 0.42587,
    lon: 37.59964,
    quadrant: "NE",
    area: "Ngare Mara area (NE)",
    village: null,
    operator: null,
    funder: null,
    status: null,
    quality: null,
  },
  {
    id: 3807039114,
    name: "Epiding",
    type: "well",
    lat: 0.40136,
    lon: 37.58899,
    quadrant: "NE",
    area: "Ngare Mara area (NE)",
    village: null,
    operator: null,
    funder: null,
    status: null,
    quality: null,
  },
  {
    id: 3807039124,
    name: "Game Community Borehole",
    type: "well",
    lat: 0.36778,
    lon: 37.56175,
    quadrant: "NW",
    area: "Wabera area (NW)",
    village: null,
    operator: null,
    funder: null,
    status: null,
    quality: null,
  },
  {
    id: 3807043986,
    name: "Masharkwata Borehole",
    type: "well",
    lat: 0.41592,
    lon: 37.55811,
    quadrant: "NW",
    area: "Wabera area (NW)",
    village: null,
    operator: null,
    funder: null,
    status: null,
    quality: null,
  },
  {
    id: 3807044042,
    name: "Shambani Primary School Borehole",
    type: "well",
    lat: 0.3805,
    lon: 37.57232,
    quadrant: "NW",
    area: "Wabera area (NW)",
    village: null,
    operator: null,
    funder: null,
    status: null,
    quality: null,
  },
  {
    id: 3283811996,
    name: "Kilimani Community Water Project",
    type: "drinking_water_point",
    lat: 0.35744,
    lon: 37.5644,
    quadrant: "NW",
    area: "Wabera area (NW)",
    village: null,
    operator: "group",
    funder: "world vision",
    status: "complete",
    quality: "good",
  },
  {
    id: 3283811998,
    name: "Kiwanjani Borehole",
    type: "borehole",
    lat: 0.34963,
    lon: 37.59553,
    quadrant: "SE",
    area: "Kambi Garba area (SE)",
    village: "kiwanjani",
    operator: "govt",
    funder: null,
    status: "complete",
    quality: "very_good",
  },
  {
    id: 3283811148,
    name: "Borehole at Kakili",
    type: "borehole",
    lat: 0.30572,
    lon: 37.54665,
    quadrant: "SW",
    area: "Bulla Pesa town area (SW)",
    village: "kakili",
    operator: "group",
    funder: "redcross",
    status: "complete",
    quality: "good",
  },
  {
    id: 3283811149,
    name: "Borehole at Kambi Ya Juu",
    type: "borehole",
    lat: 0.32569,
    lon: 37.56523,
    quadrant: "SW",
    area: "Bulla Pesa town area (SW)",
    village: "kambi ya juu",
    operator: "private",
    funder: null,
    status: "complete",
    quality: "good",
  },
  {
    id: 3283811147,
    name: "Borehole Kambi Ya Juu",
    type: "borehole",
    lat: 0.33941,
    lon: 37.55304,
    quadrant: "SW",
    area: "Bulla Pesa town area (SW)",
    village: "kambi sheik",
    operator: "private",
    funder: "world vision",
    status: "complete",
    quality: "good",
  },
  {
    id: 3283811993,
    name: "Kambi Turkana Borehole",
    type: "borehole",
    lat: 0.34563,
    lon: 37.56032,
    quadrant: "SW",
    area: "Bulla Pesa town area (SW)",
    village: "kambi turkana",
    operator: "group",
    funder: "world vision",
    status: "complete",
    quality: "good",
  },
  {
    id: 3807039065,
    name: "Akadeli Borehole",
    type: "well",
    lat: 0.34489,
    lon: 37.54919,
    quadrant: "SW",
    area: "Bulla Pesa town area (SW)",
    village: null,
    operator: null,
    funder: null,
    status: null,
    quality: null,
  },
  {
    id: 3807039092,
    name: "Burat 1A Borehole",
    type: "well",
    lat: 0.3169,
    lon: 37.51984,
    quadrant: "SW",
    area: "Bulla Pesa town area (SW)",
    village: null,
    operator: null,
    funder: null,
    status: null,
    quality: null,
  },
  {
    id: 3807039093,
    name: "Burat 1B Borehole",
    type: "well",
    lat: 0.31691,
    lon: 37.5198,
    quadrant: "SW",
    area: "Bulla Pesa town area (SW)",
    village: null,
    operator: null,
    funder: null,
    status: null,
    quality: null,
  },
  {
    id: 3807044063,
    name: "Kambi Ya Juu Primary School Borehole",
    type: "well",
    lat: 0.33301,
    lon: 37.55289,
    quadrant: "SW",
    area: "Bulla Pesa town area (SW)",
    village: null,
    operator: null,
    funder: null,
    status: null,
    quality: null,
  },
  {
    id: 3807039142,
    name: "Kilimani St. Paul Nursery School Borehole",
    type: "well",
    lat: 0.34609,
    lon: 37.55919,
    quadrant: "SW",
    area: "Bulla Pesa town area (SW)",
    village: null,
    operator: null,
    funder: null,
    status: null,
    quality: null,
  },
  {
    id: 3807043958,
    name: "LMD Staff Camp Kilimani Borehole",
    type: "well",
    lat: 0.34848,
    lon: 37.55573,
    quadrant: "SW",
    area: "Bulla Pesa town area (SW)",
    village: null,
    operator: null,
    funder: null,
    status: null,
    quality: null,
  },
  {
    id: 3003032061,
    name: "Water tower at Kambi Ya Juu",
    type: "water_tower",
    lat: 0.32805,
    lon: 37.56333,
    quadrant: "SW",
    area: "Bulla Pesa town area (SW)",
    village: "kambi ya juu",
    operator: "private",
    funder: "kewasco",
    status: "complete",
    quality: "good",
  },
  {
    id: 3283812052,
    name: "Water tower at Kambi Ya Juu",
    type: "water_tower",
    lat: 0.32534,
    lon: 37.56803,
    quadrant: "SW",
    area: "Bulla Pesa town area (SW)",
    village: "kambi ya juu",
    operator: "private",
    funder: "kewasco",
    status: "complete",
    quality: "good",
  },
  {
    id: 3807044065,
    name: "Tupendane Community Dispensary",
    type: "drinking_water_point",
    lat: 0.35348,
    lon: 37.56044,
    quadrant: "SW",
    area: "Bulla Pesa town area (SW)",
    village: null,
    operator: null,
    funder: null,
    status: null,
    quality: null,
  },
]) as readonly WaterPoint[];

/**
 * Render the water-points knowledge base as a system-prompt block.
 * Grouped by quadrant; each line is a single point with all known attributes.
 * Each unverified-name point is suffixed with "(name unconfirmed)" and a
 * landmark anchor so the AI can describe it findable even if the OSM name
 * doesn't match what locals or Google Maps use.
 * Designed to be concatenated into the Realtime instructions string.
 */
export function formatWaterPointsBlock(): string {
  const km = (
    a: { lat: number; lon: number },
    b: { lat: number; lon: number },
  ): number => {
    const toRad = (d: number) => (d * Math.PI) / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLon = toRad(b.lon - a.lon);
    const h =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
    return 2 * 6371 * Math.asin(Math.sqrt(h));
  };

  // Only anchor against "memorable" landmark categories — herders recognise
  // schools, mosques, churches, markets, health centres, fuel stations,
  // and named hamlets far better than abstract terrain or river segments.
  const anchorOk = new Set([
    "settlement",
    "school",
    "worship",
    "health",
    "market",
    "civic",
    "fuel",
  ]);
  const candidates = BULA_PESA_LANDMARKS.filter((l) =>
    anchorOk.has(l.category),
  );

  const nearestLandmark = (p: WaterPoint) => {
    let best: { name: string; d: number } | null = null;
    for (const l of candidates) {
      const d = km(p, l);
      if (!best || d < best.d) best = { name: l.name, d };
    }
    return best;
  };

  const byQuad: Record<string, WaterPoint[]> = {
    NW: [],
    NE: [],
    SW: [],
    SE: [],
  };
  for (const p of BULA_PESA_WATER_POINTS) byQuad[p.quadrant].push(p);

  // Max distance from a water point at which a landmark is still
  // locally salient. Beyond this, the landmark may not help the herder
  // place the site — fall back to area + village.
  const MAX_ANCHOR_KM = 1.5;

  const fmtPoint = (p: WaterPoint): string => {
    const facts: string[] = [`type: ${p.type.replace(/_/g, " ")}`];
    if (p.village) facts.push(`village: ${p.village}`);
    if (p.operator) facts.push(`operator: ${p.operator}`);
    if (p.funder) facts.push(`funder: ${p.funder}`);
    if (p.status) facts.push(`status: ${p.status}`);
    if (p.quality) facts.push(`quality: ${p.quality}`);
    const anchor = nearestLandmark(p);
    if (anchor && anchor.d <= MAX_ANCHOR_KM) {
      facts.push(`near: ${anchor.name} (~${anchor.d.toFixed(1)} km)`);
    } else if (p.village) {
      facts.push(
        `locator: ${p.village} village (no nearby landmark within ${MAX_ANCHOR_KM} km)`,
      );
    } else {
      facts.push(
        `locator: ${p.area} (no nearby landmark within ${MAX_ANCHOR_KM} km, no village tag)`,
      );
    }
    const nameTag = hasMetadataBackedName(p)
      ? p.name
      : `${p.name} (name unconfirmed in OSM)`;
    return `  • ${nameTag} — ${facts.join(", ")}`;
  };

  const sections: string[] = [];
  for (const q of ["NW", "NE", "SW", "SE"] as const) {
    if (byQuad[q].length === 0) continue;
    const areaLabel = byQuad[q][0]!.area;
    sections.push(`${areaLabel}:\n${byQuad[q].map(fmtPoint).join("\n")}`);
  }

  const backedCount = BULA_PESA_WATER_POINTS.filter(
    hasMetadataBackedName,
  ).length;

  return [
    `WATER POINTS — GROUND TRUTH (${BULA_PESA_WATER_POINTS.length} sites from OpenStreetMap, of which ${backedCount} have an operator/funder/status recorded — treat those names with higher confidence; treat the rest as best-effort OSM volunteer labels):`,
    ...sections,
    `RULES for water points:`,
    `- Reference water points ONLY by names in this list. Do NOT invent depth, yield, install year, or any spec not shown above.`,
    `- ALWAYS describe a water point using its quadrant + the "near:" landmark (or "locator:" fallback) + type — not just the name. Names come from OSM volunteers and may not match what locals or Google call the site. Example: instead of "Akadeli Borehole", say "the borehole in Bulla Pesa town (SW), about 0.2 km from Abubakar Mosque". Example Swahili: "kisima kile cha SW, karibu na Msikiti wa Abubakar".`,
    `- When a line uses "locator:" instead of "near:", say "in <area>" / "in <village>" only — do NOT invent a landmark for it.`,
    `- For points tagged "(name unconfirmed in OSM)" — say so plainly: "the OSM map calls it X but locals may know it as something else; it's the borehole near <landmark>". Never present an unconfirmed OSM name as authoritative.`,
    `- If the herder names a water point that isn't listed, say you don't have direct records for that site and offer the nearest one from the list using the landmark or locator.`,
    `- "operator: group" means a community user group; "operator: private" means privately owned; absent fields mean unknown — say "I don't have that detail" rather than guessing.`,
  ].join("\n");
}
