// Satellite-detected water bodies — Sentinel-2 NDWI over Bula Pesa Ward.
//
// Sentinel-2 NDWI = (B3 − B8) / (B3 + B8). Values > 0 are open water; we
// median the last 30 days of <30% cloud images so a single bright cloud
// doesn't masquerade as a pan. The wet mask is sampled onto a coarse
// ~100 m grid, then flood-filled into connected components. Components
// smaller than a single hectare are dropped (sensor speckle, mixed pixels).
//
// Each surviving cluster is reported with its centroid, area in hectares,
// quadrant, and nearest named landmark. The list is cached in-memory for
// 24 h — Earth Engine takes ~6 s and Sentinel-2 only revisits every ~5
// days, so re-fetching per call would waste time and budget for no gain.
//
// The first call on a cold process kicks off a background fetch and
// returns an empty list immediately so call setup never stalls. The
// scheduler warms the cache on boot.

// @ts-ignore — @google/earthengine ships CJS without full typings
import EE from "@google/earthengine";
import { initEE, evaluate, WARD_BBOX_EXPORT } from "./satellite.js";
import {
  BULA_PESA_LANDMARKS,
  type Landmark,
} from "./data/bulaPesaLandmarks.js";
import { logger } from "./logger.js";

const [minLon, minLat, maxLon, maxLat] = WARD_BBOX_EXPORT;

// 100 m cells. 1° latitude ≈ 111 139 m at the equator, so 100 m ≈ 0.0009°.
const PIX_DEG = 0.0009;

// Drop clusters smaller than this many cells (each ≈ 1 hectare). Below
// this, a "wet" patch is almost certainly Sentinel-2 noise, not a pan.
const MIN_CLUSTER_CELLS = 1;

// NDWI threshold for "open water". 0.0 is the textbook cut; we keep it
// conservative so we don't mis-flag wet vegetation as a water body.
const NDWI_WATER_THRESHOLD = 0.0;

// Top N clusters by area to surface in the prompt (avoid token bloat).
const MAX_REPORTED = 6;

// Cache TTL — Sentinel-2 doesn't update faster than ~once every 5 days.
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export interface SatelliteWaterBody {
  centroidLat: number;
  centroidLon: number;
  areaHectares: number;
  quadrant: "NW" | "NE" | "SW" | "SE";
  nearestLandmark: { name: string; distanceKm: number } | null;
  windowStart: string;
  windowEnd: string;
  imageCount: number;
}

interface CacheEntry {
  at: number;
  bodies: SatelliteWaterBody[];
  windowStart: string;
  windowEnd: string;
  imageCount: number;
}

let cache: CacheEntry | null = null;
let inFlight: Promise<CacheEntry> | null = null;

const ANCHOR_CATEGORIES = new Set<Landmark["category"]>([
  "settlement",
  "school",
  "worship",
  "health",
  "market",
  "civic",
  "fuel",
]);
const ANCHOR_LANDMARKS = BULA_PESA_LANDMARKS.filter((l) =>
  ANCHOR_CATEGORIES.has(l.category),
);

function quadrantFor(lat: number, lon: number): "NW" | "NE" | "SW" | "SE" {
  const midLat = (minLat + maxLat) / 2;
  const midLon = (minLon + maxLon) / 2;
  const north = lat >= midLat;
  const east = lon >= midLon;
  return north ? (east ? "NE" : "NW") : east ? "SE" : "SW";
}

function haversineKm(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

function nearestLandmark(
  lat: number,
  lon: number,
): { name: string; distanceKm: number } | null {
  let best: { name: string; distanceKm: number } | null = null;
  for (const l of ANCHOR_LANDMARKS) {
    const d = haversineKm({ lat, lon }, l);
    if (!best || d < best.distanceKm) best = { name: l.name, distanceKm: d };
  }
  return best;
}

// 4-neighbour flood fill across the wet matrix.
function findClusters(wet: boolean[][]): Array<Array<[number, number]>> {
  const rows = wet.length;
  const cols = rows > 0 ? wet[0]!.length : 0;
  const seen = Array.from({ length: rows }, () =>
    new Array<boolean>(cols).fill(false),
  );
  const clusters: Array<Array<[number, number]>> = [];

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!wet[r]![c] || seen[r]![c]) continue;
      // Mark-on-push flood fill: each cell is added to the stack at most
      // once, so even a ward fully covered in water stays bounded by
      // rows*cols stack entries (not 4*rows*cols).
      seen[r]![c] = true;
      const stack: Array<[number, number]> = [[r, c]];
      const cells: Array<[number, number]> = [];
      while (stack.length) {
        const popped = stack.pop()!;
        const rr = popped[0];
        const cc = popped[1];
        cells.push([rr, cc]);
        const neighbours: Array<[number, number]> = [
          [rr + 1, cc],
          [rr - 1, cc],
          [rr, cc + 1],
          [rr, cc - 1],
        ];
        for (const [nr, nc] of neighbours) {
          if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
          if (seen[nr]![nc] || !wet[nr]![nc]) continue;
          seen[nr]![nc] = true;
          stack.push([nr, nc]);
        }
      }
      if (cells.length > 0) clusters.push(cells);
    }
  }
  return clusters;
}

async function fetchOnce(): Promise<CacheEntry> {
  await initEE();
  const ee = EE as any;
  const ward = ee.Geometry.Rectangle([minLon, minLat, maxLon, maxLat]);

  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - 30);
  const startStr = start.toISOString().slice(0, 10);
  const endStr = end.toISOString().slice(0, 10);

  let col = ee
    .ImageCollection("COPERNICUS/S2_SR_HARMONIZED")
    .filterBounds(ward)
    .filterDate(startStr, endStr)
    .filter(ee.Filter.lt("CLOUDY_PIXEL_PERCENTAGE", 30))
    .select(["B3", "B8"]);

  let imageCount: number = await evaluate(col.size());
  if (imageCount < 2) {
    const start60 = new Date(end);
    start60.setDate(start60.getDate() - 60);
    col = ee
      .ImageCollection("COPERNICUS/S2_SR_HARMONIZED")
      .filterBounds(ward)
      .filterDate(start60.toISOString().slice(0, 10), endStr)
      .filter(ee.Filter.lt("CLOUDY_PIXEL_PERCENTAGE", 30))
      .select(["B3", "B8"]);
    imageCount = await evaluate(col.size());
  }

  const ndwiCol = col.map((img: any) =>
    img.normalizedDifference(["B3", "B8"]).rename("NDWI"),
  );
  // Median across the window — single cloud or sun-glint frame doesn't drive a false positive.
  const ndwiMedian = ndwiCol.median().rename("NDWI");

  // Align to the same coarse 100 m grid we use for clustering.
  const aligned = ndwiMedian.unmask(-1).reproject({
    crs: "EPSG:4326",
    crsTransform: [PIX_DEG, 0, minLon, 0, -PIX_DEG, maxLat],
  });

  const sample = await evaluate<{ properties: Record<string, number[][]> }>(
    aligned.sampleRectangle({ region: ward }),
  );
  const grid = sample.properties["NDWI"] ?? [];
  const rows = grid.length;
  const cols = rows > 0 ? grid[0]!.length : 0;

  const wet: boolean[][] = grid.map((row) =>
    row.map((v) => v != null && v > NDWI_WATER_THRESHOLD),
  );

  const clusters = findClusters(wet);

  // Convert each cluster to a real water body. crsTransform origin is the
  // top-left corner of the bbox (maxLat, minLon); row 0 is the northernmost
  // pixel, col 0 is the westernmost.
  const bodies: SatelliteWaterBody[] = clusters
    .filter((c) => c.length >= MIN_CLUSTER_CELLS)
    .map((cells) => {
      let sumLat = 0;
      let sumLon = 0;
      for (const [r, c] of cells) {
        const lat = maxLat - (r + 0.5) * PIX_DEG;
        const lon = minLon + (c + 0.5) * PIX_DEG;
        sumLat += lat;
        sumLon += lon;
      }
      const centroidLat = sumLat / cells.length;
      const centroidLon = sumLon / cells.length;
      // 100 m × 100 m = 1 hectare per cell (near-equator approximation).
      const areaHectares = cells.length;
      return {
        centroidLat,
        centroidLon,
        areaHectares,
        quadrant: quadrantFor(centroidLat, centroidLon),
        nearestLandmark: nearestLandmark(centroidLat, centroidLon),
        windowStart: startStr,
        windowEnd: endStr,
        imageCount,
      };
    })
    .sort((a, b) => b.areaHectares - a.areaHectares)
    .slice(0, MAX_REPORTED);

  logger.info(
    {
      imageCount,
      gridRows: rows,
      gridCols: cols,
      clustersFound: clusters.length,
      clustersReported: bodies.length,
      windowStart: startStr,
      windowEnd: endStr,
    },
    "[WaterBodies] Sentinel-2 NDWI scan complete",
  );

  return {
    at: Date.now(),
    bodies,
    windowStart: startStr,
    windowEnd: endStr,
    imageCount,
  };
}

/**
 * Return cached water bodies. If the cache is stale or empty, kick off a
 * background refresh and return whatever we have (possibly empty). Never
 * throws — Earth Engine failures degrade silently to an empty list.
 */
export async function getSatelliteWaterBodies(): Promise<SatelliteWaterBody[]> {
  const fresh = cache && Date.now() - cache.at < CACHE_TTL_MS;
  if (fresh) return cache!.bodies;

  // Stale or cold — fire background refresh; await briefly only if we have nothing at all.
  if (!inFlight) {
    inFlight = fetchOnce()
      .then((entry) => {
        cache = entry;
        return entry;
      })
      .catch((err): CacheEntry => {
        // Swallow here so background refreshers (no awaiter) never produce
        // an unhandled rejection. Cold-start callers detect failure via
        // the fact that `cache` is still null after the await.
        logger.error(
          { err },
          "[WaterBodies] fetch failed — keeping previous cache",
        );
        return {
          at: 0,
          bodies: [],
          windowStart: "",
          windowEnd: "",
          imageCount: 0,
        };
      })
      .finally(() => {
        inFlight = null;
      }) as Promise<CacheEntry>;
  }

  if (cache) {
    // We already have something (just stale). Return it instantly and let
    // the background fetch update cache for next time.
    return cache.bodies;
  }

  // Cold start — race the fetch against a hard ceiling so call setup
  // doesn't hang on Earth Engine. `inFlight` never rejects (see .catch
  // above) so no try/catch needed and no unhandled rejection if we time out.
  const entry = await Promise.race<CacheEntry | "timeout">([
    inFlight,
    new Promise<"timeout">((resolve) =>
      setTimeout(() => resolve("timeout"), 2500),
    ),
  ]);
  if (entry === "timeout") return [];
  return entry.bodies;
}

/** Eager warm-up for the scheduler to call on boot. Awaits the full fetch. */
export async function warmSatelliteWaterBodies(): Promise<void> {
  try {
    const entry = await fetchOnce();
    cache = entry;
  } catch (err) {
    logger.error(
      { err },
      "[WaterBodies] warm-up failed — will retry on demand",
    );
  }
}

const QUAD_AREA: Record<"NW" | "NE" | "SW" | "SE", string> = {
  NW: "Wabera area (NW)",
  NE: "Ngare Mara area (NE)",
  SW: "Bulla Pesa town area (SW)",
  SE: "Kambi Garba area (SE)",
};

/**
 * Format water bodies for the Realtime system prompt. Returns "" when no
 * data is available so the prompt builder can omit the block cleanly.
 */
export async function formatSatelliteWaterBodiesBlock(): Promise<string> {
  const bodies = await getSatelliteWaterBodies();
  if (bodies.length === 0) return "";

  const sample = bodies[0]!;
  const lines: string[] = [
    `SATELLITE-DETECTED OPEN WATER (Sentinel-2 NDWI, ${sample.windowStart} → ${sample.windowEnd}, ${sample.imageCount} images):`,
    `These are wet patches the satellite sees on the ground RIGHT NOW — pans, dams, river pools, flooded areas. They are NOT named OSM water points; they are raw spectral detections, so describe by quadrant + nearest landmark, never invent a name.`,
  ];
  for (const b of bodies) {
    const anchor = b.nearestLandmark
      ? `~${b.nearestLandmark.distanceKm.toFixed(1)} km from ${b.nearestLandmark.name}`
      : "no nearby landmark";
    lines.push(
      `  • ${QUAD_AREA[b.quadrant]}: ~${b.areaHectares} hectare${b.areaHectares === 1 ? "" : "s"} of open water, ${anchor} (centroid ${b.centroidLat.toFixed(4)}°N, ${b.centroidLon.toFixed(4)}°E)`,
    );
  }
  lines.push(
    `RULES: If the herder asks "where's the water?" or mentions long trekking, you MAY surface the largest cluster nearest to where they're grazing, described as "the satellite is picking up about X hectares of open water near <landmark>, in the <area>." Say plainly it's a satellite detection that may be ephemeral (rain-filled pan, river pool), not a maintained water point. Never present these as boreholes or named sites.`,
  );
  return lines.join("\n");
}
