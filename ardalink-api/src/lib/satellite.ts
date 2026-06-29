// @ts-ignore — @google/earthengine ships CJS without full typings
import EE from "@google/earthengine";
import { ardalinkDb } from "./cosmos.js";
import { logger } from "./logger.js";

// ── Ward grid — exactly mirrors the Cosmos DB pixel_grids dimensions ──────────
// The Cosmos DB data was exported at this grid resolution and origin.
// All pixel-level ops use this definition so live ↔ historical pixels align.
const WARD_BBOX = [37.51149, 0.28284, 37.65473, 0.42715] as const;
const GRID_COLS = 499;
const GRID_ROWS = 503;
const PIX_LON = (WARD_BBOX[2] - WARD_BBOX[0]) / GRID_COLS; // ~0.000287° per pixel (W→E)
const PIX_LAT = (WARD_BBOX[3] - WARD_BBOX[1]) / GRID_ROWS; // ~0.000287° per pixel (S→N)
const CENTER_COL = Math.floor(GRID_COLS / 2); // col index of ward centre
const CENTER_ROW = Math.floor(GRID_ROWS / 2); // row index of ward centre

const VEG_THRESHOLD = 0.08; // historical NDVI < 0.08 → bare soil / water, skip
const COSMOS_NODATA = -9999; // sentinel used in Cosmos DB pixel_grids
const LIVE_NODATA = -1; // masked EE pixels are unmasked to -1 (floor of normalizedDifference)
const LIVE_NODATA_THRESH = -0.9; // live values ≤ this are treated as no-data
const STRESS_THRESHOLD = -15; // anomaly % below which a pixel is "stressed"

// ── Public types ─────────────────────────────────────────────────────────────

export interface AnomalyStats {
  meanPct: number;
  p5: number;
  p25: number;
  p50: number;
  p75: number;
}

export interface VegetationAnomaly {
  NDVI: AnomalyStats;
  RED_EDGE: AnomalyStats;
  NDRE: AnomalyStats;
  wardStressedPixelPct: number;
  wardVegetatedPixels: number;
  wardStressedPixels: number;
  worstQuadrant: "NW" | "NE" | "SW" | "SE" | "uniform";
  quadrantMeanAnomalyPct: Record<string, number>;
  /** Cosmos DB pixel_grids were used as the historical baseline */
  baselineSource: "cosmos_pixel_grids";
  historicalYearRange: string;
  localZone?: LocalZoneAnomaly;
}

export interface LocalZoneAnomaly {
  centerLat: number;
  centerLon: number;
  radiusKm: number;
  NDVI: AnomalyStats;
  stressedPixelPct: number;
  note: string;
}

export interface LiveVegetation {
  NDVI: number;
  NDRE: number;
  RED_EDGE: number;
  dateRange: { start: string; end: string };
  imageCount: number;
  imageDates: string[];
  vegetatedPixelCount: number;
  anomaly: VegetationAnomaly;
}

// ── EE initialisation ────────────────────────────────────────────────────────

let eeReady: Promise<void> | null = null;

// Exported so sibling modules (waterBodies.ts, etc.) can reuse the same
// auth/initialisation singleton — initialising Earth Engine twice in one
// process is wasteful and can race.
export { initEE, evaluate };
// Exposed for sibling modules that need the same ward geometry as the
// NDVI pipeline (currently only waterBodies.ts).
export const WARD_BBOX_EXPORT = WARD_BBOX;

function initEE(): Promise<void> {
  if (!eeReady) {
    eeReady = new Promise<void>((resolve, reject) => {
      const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON!);
      (EE as any).data.authenticateViaPrivateKey(
        creds,
        () => (EE as any).initialize(null, null, resolve, reject),
        reject,
      );
    });
  }
  return eeReady;
}

function evaluate<T>(eeObj: any): Promise<T> {
  return new Promise<T>((resolve, reject) =>
    eeObj.evaluate((r: any, e: any) =>
      e ? reject(new Error(String(e))) : resolve(r),
    ),
  );
}

// ── Step A: Cosmos DB — load pre-computed historical pixel grid ───────────────
// Each chunk covers 100 rows × 499 cols. We reassemble in chunk order.

async function loadCosmosGrid(
  month: number,
  band: string,
): Promise<number[][]> {
  const { resources: chunks } = await ardalinkDb
    .container("pixel_grids")
    .items.query({
      query:
        "SELECT c.chunk, c.row_start, c.data FROM c " +
        "WHERE c.month = @m AND c.band = @b ORDER BY c.chunk ASC",
      parameters: [
        { name: "@m", value: month },
        { name: "@b", value: band },
      ],
    })
    .fetchAll();

  if (!chunks.length)
    throw new Error(`pixel_grids missing for month=${month} band=${band}`);

  const sorted = [...chunks].sort((a: any, b: any) => a.chunk - b.chunk);
  return sorted.flatMap((c: any) => c.data as number[][]);
}

// ── Step B: Earth Engine — fetch live composite, extract as pixel array ───────
// Uses sampleRectangle with the exact same CRS transform as the Cosmos DB grid,
// so pixels are guaranteed to align between EE output and Cosmos DB baseline.

async function buildCurrentComposite(
  ee: any,
  ward: any,
  windowDays = 30,
): Promise<{ composite: any; imageCount: number; imageDates: string[] }> {
  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - windowDays);
  const startStr = start.toISOString().split("T")[0]!;
  const endStr = end.toISOString().split("T")[0]!;

  let col = ee
    .ImageCollection("COPERNICUS/S2_SR_HARMONIZED")
    .filterBounds(ward)
    .filterDate(startStr, endStr)
    .filter(ee.Filter.lt("CLOUDY_PIXEL_PERCENTAGE", 20))
    .select(["B4", "B5", "B7", "B8", "B8A"]);

  let count: number = await evaluate(col.size());

  if (count < 3) {
    logger.warn(
      { count },
      "[Satellite] Few images — extending window to 60 days",
    );
    const start60 = new Date(end);
    start60.setDate(start60.getDate() - 60);
    col = ee
      .ImageCollection("COPERNICUS/S2_SR_HARMONIZED")
      .filterBounds(ward)
      .filterDate(start60.toISOString().split("T")[0]!, endStr)
      .filter(ee.Filter.lt("CLOUDY_PIXEL_PERCENTAGE", 20))
      .select(["B4", "B5", "B7", "B8", "B8A"]);
    count = await evaluate(col.size());
  }

  let imageDates: string[] = [];
  try {
    const ms: number[] = await evaluate(
      col
        .sort("system:time_start", false)
        .limit(10)
        .aggregate_array("system:time_start"),
    );
    imageDates = ms
      .map((t) => new Date(t).toISOString().split("T")[0]!)
      .filter(Boolean);
  } catch {
    /* non-critical */
  }

  // Per-image band indices + timestamp for most-recent-pixel mosaic
  const withBands = col.map((img: any) => {
    const ndvi = img.normalizedDifference(["B8", "B4"]).rename("NDVI");
    const ndre = img.normalizedDifference(["B8A", "B5"]).rename("NDRE");
    const re = img.normalizedDifference(["B7", "B5"]).rename("RED_EDGE");
    const ts = img.metadata("system:time_start").toFloat().rename("ts");
    return ndvi.addBands(ndre).addBands(re).addBands(ts);
  });

  // Most-recent-pixel mosaic, then drop timestamp band
  const composite = withBands
    .qualityMosaic("ts")
    .select(["NDVI", "NDRE", "RED_EDGE"]);

  return { composite, imageCount: count, imageDates };
}

async function sampleCurrentGrid(
  ee: any,
  ward: any,
): Promise<{
  NDVI: number[][];
  NDRE: number[][];
  RED_EDGE: number[][];
  imageCount: number;
  imageDates: string[];
}> {
  const { composite, imageCount, imageDates } = await buildCurrentComposite(
    ee,
    ward,
    30,
  );

  // Reproject into the exact same grid as the Cosmos DB pixel_grids.
  // crsTransform = [scaleX, shearX, originX, shearY, scaleY, originY]
  // (top-left corner of top-left pixel)
  const aligned = composite
    // Fill masked pixels with -1 (floor of normalizedDifference) before sampling.
    // sampleRectangle rejects out-of-range defaultValue for normalized bands.
    .unmask(LIVE_NODATA)
    .reproject({
      crs: "EPSG:4326",
      crsTransform: [PIX_LON, 0, WARD_BBOX[0], 0, -PIX_LAT, WARD_BBOX[3]],
    });

  // sampleRectangle returns a GeoJSON Feature where each band is a 2D list
  const sample = await evaluate<{ properties: Record<string, number[][]> }>(
    aligned.sampleRectangle({ region: ward }),
  );

  const p = sample.properties;
  return {
    NDVI: p["NDVI"] ?? [],
    NDRE: p["NDRE"] ?? [],
    RED_EDGE: p["RED_EDGE"] ?? [],
    imageCount,
    imageDates,
  };
}

// ── Step C: In-server anomaly computation ────────────────────────────────────
// All maths happens in Node.js — no further EE calls needed.

interface AnomalyPoint {
  r: number;
  c: number;
  pct: number;
}

function computeAnomalyPoints(
  current: number[][],
  historical: number[][],
): AnomalyPoint[] {
  const rows = Math.min(current.length, historical.length, GRID_ROWS);
  const cols = Math.min(
    current[0]?.length ?? 0,
    historical[0]?.length ?? 0,
    GRID_COLS,
  );
  const points: AnomalyPoint[] = [];

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cur = current[r]![c]!;
      const base = historical[r]![c]!;
      if (
        cur <= LIVE_NODATA_THRESH ||
        base === COSMOS_NODATA ||
        base < VEG_THRESHOLD
      )
        continue;
      const pct = ((cur - base) / Math.abs(base)) * 100;
      points.push({ r, c, pct });
    }
  }
  return points;
}

function computeStats(values: number[]): AnomalyStats {
  if (!values.length) return { meanPct: 0, p5: 0, p25: 0, p50: 0, p75: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const at = (q: number) => sorted[Math.min(Math.round(q * (n - 1)), n - 1)]!;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  return {
    meanPct: parseFloat(mean.toFixed(2)),
    p5: parseFloat(at(0.05).toFixed(2)),
    p25: parseFloat(at(0.25).toFixed(2)),
    p50: parseFloat(at(0.5).toFixed(2)),
    p75: parseFloat(at(0.75).toFixed(2)),
  };
}

function computeQuadrantStats(points: AnomalyPoint[]): {
  worstQuadrant: "NW" | "NE" | "SW" | "SE" | "uniform";
  quadrantMeanAnomalyPct: Record<string, number>;
} {
  const buckets: Record<string, number[]> = { NW: [], NE: [], SW: [], SE: [] };

  for (const { r, c, pct } of points) {
    const ns = r < CENTER_ROW ? "N" : "S";
    const ew = c < CENTER_COL ? "W" : "E";
    buckets[`${ns}${ew}`]!.push(pct);
  }

  const means: Record<string, number> = {};
  for (const [q, vals] of Object.entries(buckets)) {
    means[q] = vals.length
      ? parseFloat((vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(2))
      : 0;
  }

  const sorted = Object.entries(means).sort((a, b) => a[1] - b[1]);
  const [worstKey, worstMean] = sorted[0]!;
  const [, bestMean] = sorted[sorted.length - 1]!;
  const spread = bestMean - worstMean;

  const worstQuadrant: "NW" | "NE" | "SW" | "SE" | "uniform" =
    spread < 5 ? "uniform" : (worstKey as "NW" | "NE" | "SW" | "SE");

  return { worstQuadrant, quadrantMeanAnomalyPct: means };
}

function computeStressMetrics(points: AnomalyPoint[]): {
  wardStressedPixelPct: number;
  wardVegetatedPixels: number;
  wardStressedPixels: number;
} {
  const stressed = points.filter((p) => p.pct < STRESS_THRESHOLD).length;
  const total = points.length;
  return {
    wardStressedPixelPct:
      total > 0 ? parseFloat(((stressed / total) * 100).toFixed(2)) : 0,
    wardVegetatedPixels: total,
    wardStressedPixels: stressed,
  };
}

// ── Local zone: extracted from already-loaded ward grids (zero extra I/O) ────

function computeLocalZone(
  currentNDVI: number[][],
  historicalNDVI: number[][],
): LocalZoneAnomaly | undefined {
  const lat = parseFloat(process.env.LOCAL_ZONE_LAT ?? "");
  const lon = parseFloat(process.env.LOCAL_ZONE_LON ?? "");
  const radiusKm = parseFloat(process.env.LOCAL_ZONE_RADIUS_KM ?? "5");

  if (isNaN(lat) || isNaN(lon)) return undefined;

  // Convert GPS → grid indices
  const centerCol = Math.round((lon - WARD_BBOX[0]) / PIX_LON);
  const centerRow = Math.round((WARD_BBOX[3] - lat) / PIX_LAT);
  const radiusCols = Math.ceil((radiusKm * 1000) / (PIX_LON * 111320));

  // Bounds check
  if (
    centerCol < 0 ||
    centerCol >= GRID_COLS ||
    centerRow < 0 ||
    centerRow >= GRID_ROWS
  ) {
    logger.warn(
      { lat, lon, centerRow, centerCol },
      "[Satellite] Local zone centre is outside the ward grid",
    );
    return undefined;
  }

  const localPoints: number[] = [];
  let stressed = 0;

  const rows = Math.min(currentNDVI.length, historicalNDVI.length, GRID_ROWS);
  const cols = Math.min(
    currentNDVI[0]?.length ?? 0,
    historicalNDVI[0]?.length ?? 0,
    GRID_COLS,
  );

  for (
    let r = Math.max(0, centerRow - radiusCols);
    r < Math.min(rows, centerRow + radiusCols);
    r++
  ) {
    for (
      let c = Math.max(0, centerCol - radiusCols);
      c < Math.min(cols, centerCol + radiusCols);
      c++
    ) {
      // Circle check using approximate metres
      const dLon = (c - centerCol) * PIX_LON * 111320;
      const dLat = (r - centerRow) * PIX_LAT * 110570;
      if (Math.sqrt(dLon * dLon + dLat * dLat) > radiusKm * 1000) continue;

      const cur = currentNDVI[r]![c]!;
      const base = historicalNDVI[r]![c]!;
      if (
        cur <= LIVE_NODATA_THRESH ||
        base === COSMOS_NODATA ||
        base < VEG_THRESHOLD
      )
        continue;

      const pct = ((cur - base) / Math.abs(base)) * 100;
      localPoints.push(pct);
      if (pct < STRESS_THRESHOLD) stressed++;
    }
  }

  const stats = computeStats(localPoints);
  const stressedPixelPct =
    localPoints.length > 0
      ? parseFloat(((stressed / localPoints.length) * 100).toFixed(2))
      : 0;

  logger.info(
    {
      lat,
      lon,
      radiusKm,
      pixelCount: localPoints.length,
      stressedPixelPct,
      meanAnomalyPct: stats.meanPct,
    },
    "[Satellite] Local zone anomaly computed",
  );

  return {
    centerLat: lat,
    centerLon: lon,
    radiusKm,
    NDVI: stats,
    stressedPixelPct,
    note: `${localPoints.length} vegetated pixels within ${radiusKm}km — ${stressedPixelPct.toFixed(1)}% stressed vs own 11-year history`,
  };
}

// ── Main export ──────────────────────────────────────────────────────────────

export async function fetchLiveVegetation(): Promise<LiveVegetation> {
  await initEE();
  const ee = EE as any;
  const ward = ee.Geometry.Rectangle([...WARD_BBOX]);
  const month = new Date().getMonth() + 1;

  logger.info(
    { month },
    "[Satellite] Starting live fetch + Cosmos DB pixel comparison",
  );

  // ── A: Load Cosmos DB historical baselines (3 bands, all in parallel) ──────
  logger.info("[Satellite] Loading Cosmos DB pixel_grids historical baselines");
  const [histNDVI, histNDRE, histRE] = await Promise.all([
    loadCosmosGrid(month, "NDVI_mean"),
    loadCosmosGrid(month, "NDRE_mean"),
    loadCosmosGrid(month, "RED_EDGE_mean"),
  ]);

  // ── B: EE live composite → pixel array (sampleRectangle) ─────────────────
  logger.info(
    "[Satellite] Fetching live EE composite and extracting pixel array",
  );
  const {
    NDVI: liveNDVI,
    NDRE: liveNDRE,
    RED_EDGE: liveRE,
    imageCount,
    imageDates,
  } = await sampleCurrentGrid(ee, ward);

  const liveRows = liveNDVI.length;
  const liveCols = liveNDVI[0]?.length ?? 0;
  logger.info(
    { liveRows, liveCols, imageCount, imageDates },
    "[Satellite] Live pixel array received",
  );

  // ── C: Per-pixel anomaly computation (pure Node.js) ──────────────────────
  logger.info("[Satellite] Computing per-pixel anomalies in-server");

  const ndviPoints = computeAnomalyPoints(liveNDVI, histNDVI);
  const ndrePoints = computeAnomalyPoints(liveNDRE, histNDRE);
  const rePoints = computeAnomalyPoints(liveRE, histRE);

  const ndviStats = computeStats(ndviPoints.map((p) => p.pct));
  const ndreStats = computeStats(ndrePoints.map((p) => p.pct));
  const reStats = computeStats(rePoints.map((p) => p.pct));

  const { wardStressedPixelPct, wardVegetatedPixels, wardStressedPixels } =
    computeStressMetrics(ndviPoints);

  const { worstQuadrant, quadrantMeanAnomalyPct } =
    computeQuadrantStats(ndviPoints);

  // ── D: Local zone (extracted from already-loaded grids — zero extra I/O) ──
  const localZone = computeLocalZone(liveNDVI, histNDVI);

  // ── E: Ward-level mean values (for legacy delta comparison) ───────────────
  const validNDVI = ndviPoints
    .map((p) => {
      const r = p.r;
      const c = p.c;
      return liveNDVI[r]?.[c] ?? LIVE_NODATA;
    })
    .filter((v) => v > LIVE_NODATA_THRESH);
  const validNDRE = ndrePoints
    .map((p) => liveNDRE[p.r]?.[p.c] ?? LIVE_NODATA)
    .filter((v) => v > LIVE_NODATA_THRESH);
  const validRE = rePoints
    .map((p) => liveRE[p.r]?.[p.c] ?? LIVE_NODATA)
    .filter((v) => v > LIVE_NODATA_THRESH);

  const mean = (arr: number[]) =>
    arr.length
      ? parseFloat((arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(6))
      : 0;

  const now = new Date();
  const endStr = now.toISOString().split("T")[0]!;
  const startDate = new Date(now);
  startDate.setDate(startDate.getDate() - 30);
  const startStr = startDate.toISOString().split("T")[0]!;

  const anomaly: VegetationAnomaly = {
    NDVI: ndviStats,
    RED_EDGE: reStats,
    NDRE: ndreStats,
    wardStressedPixelPct,
    wardVegetatedPixels,
    wardStressedPixels,
    worstQuadrant,
    quadrantMeanAnomalyPct,
    baselineSource: "cosmos_pixel_grids",
    historicalYearRange: "2014–2025",
    ...(localZone ? { localZone } : {}),
  };

  logger.info(
    {
      imageCount,
      imageDates,
      wardVegetatedPixels,
      wardStressedPixelPct,
      ndviMeanAnomalyPct: ndviStats.meanPct,
      ndviP50: ndviStats.p50,
      ndviP5: ndviStats.p5,
      worstQuadrant,
    },
    "[Satellite Check] Pixel-level analysis complete",
  );

  return {
    NDVI: mean(validNDVI),
    NDRE: mean(validNDRE),
    RED_EDGE: mean(validRE),
    dateRange: { start: startStr, end: endStr },
    imageCount,
    imageDates,
    vegetatedPixelCount: wardVegetatedPixels,
    anomaly,
  };
}
