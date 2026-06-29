import { ardalinkDb } from "./cosmos.js";
import { logger } from "./logger.js";
import type { LiveVegetation } from "./satellite.js";

export interface MonthlyBaseline {
  id: string;
  month: number;
  month_name: string;
  bands: Record<
    string,
    { spatial_mean: number; spatial_min: number; spatial_max: number }
  >;
}

export interface VegetationDelta {
  /** Ward-mean comparison vs Cosmos DB 11-year baseline (legacy, secondary signal) */
  NDVI: { live: number; baseline: number; delta_pct: number };
  NDRE: { live: number; baseline: number; delta_pct: number };
  RED_EDGE: { live: number; baseline: number; delta_pct: number };
  /**
   * Pixel-level trigger (primary): fired when >25% of vegetated pixels are
   * more than 15% below their own per-pixel 10-year history.
   */
  pixelTrigger: boolean;
  pixelTriggerReason: string;
  /** Legacy ward-mean trigger (secondary) */
  wardMeanTrigger: boolean;
  wardMeanTriggerReason: string;
  /** Combined: true if either pixel OR ward-mean signal fires */
  triggered: boolean;
  trigger_reason: string;
}

const MONTH_PAD = (n: number) => String(n).padStart(2, "0");
const MONTH_NAMES = [
  "JAN",
  "FEB",
  "MAR",
  "APR",
  "MAY",
  "JUN",
  "JUL",
  "AUG",
  "SEP",
  "OCT",
  "NOV",
  "DEC",
];

// Primary: >25% of vegetated pixels are >15% below their own 10-year history
const PIXEL_STRESS_PCT_THRESHOLD = 25;
// Primary: median pixel anomaly is below -12% (more sensitive than ward mean)
const PIXEL_MEDIAN_THRESHOLD = -12;
// Secondary (legacy): ward-mean NDVI 15% below Cosmos DB baseline
const WARD_MEAN_THRESHOLD = -15;

export async function getMonthlyBaseline(
  month: number,
): Promise<MonthlyBaseline> {
  const name = MONTH_NAMES[month - 1];
  const id = `baseline_${MONTH_PAD(month)}_${name}`;
  const { resource } = await ardalinkDb
    .container("monthly_baselines")
    .item(id, month)
    .read<MonthlyBaseline>();

  if (!resource) throw new Error(`No baseline for month ${month} (${name})`);

  logger.info(
    { month, name },
    "[Baseline Match] Historical baseline retrieved",
  );
  return resource;
}

export function calculateDelta(
  live: LiveVegetation,
  baseline: MonthlyBaseline,
): VegetationDelta {
  const pct = (liveVal: number, band: string) => {
    const base = baseline.bands[band]?.spatial_mean ?? 0;
    return base !== 0 ? ((liveVal - base) / Math.abs(base)) * 100 : 0;
  };

  const NDVI = {
    live: live.NDVI,
    baseline: baseline.bands["NDVI_mean"]?.spatial_mean ?? 0,
    delta_pct: parseFloat(pct(live.NDVI, "NDVI_mean").toFixed(2)),
  };
  const NDRE = {
    live: live.NDRE,
    baseline: baseline.bands["NDRE_mean"]?.spatial_mean ?? 0,
    delta_pct: parseFloat(pct(live.NDRE, "NDRE_mean").toFixed(2)),
  };
  const RED_EDGE = {
    live: live.RED_EDGE,
    baseline: baseline.bands["RED_EDGE_mean"]?.spatial_mean ?? 0,
    delta_pct: parseFloat(pct(live.RED_EDGE, "RED_EDGE_mean").toFixed(2)),
  };

  // ── Pixel-level trigger (primary) ─────────────────────────────────────────
  const { anomaly } = live;
  const pixelReasons: string[] = [];

  if (anomaly.wardStressedPixelPct >= PIXEL_STRESS_PCT_THRESHOLD) {
    pixelReasons.push(
      `${anomaly.wardStressedPixelPct.toFixed(1)}% of vegetated pixels are >15% below their 10-year norm`,
    );
  }
  if (anomaly.NDVI.p50 < PIXEL_MEDIAN_THRESHOLD) {
    pixelReasons.push(
      `median pixel NDVI anomaly is ${anomaly.NDVI.p50.toFixed(1)}% (half the ward is dry)`,
    );
  }
  if (anomaly.NDVI.p5 < -30) {
    pixelReasons.push(
      `worst 5% of pixels are ${Math.abs(anomaly.NDVI.p5).toFixed(0)}% below norm (severe pockets)`,
    );
  }

  const pixelTrigger = pixelReasons.length > 0;
  const pixelTriggerReason =
    pixelReasons.join("; ") || "Pixel-level vegetation within normal range";

  // ── Ward-mean trigger (secondary / legacy) ────────────────────────────────
  const wardReasons: string[] = [];
  if (NDVI.delta_pct < WARD_MEAN_THRESHOLD)
    wardReasons.push(
      `ward-mean NDVI ${NDVI.delta_pct.toFixed(1)}% below 11-year baseline`,
    );
  if (RED_EDGE.delta_pct < WARD_MEAN_THRESHOLD)
    wardReasons.push(
      `ward-mean RED_EDGE ${RED_EDGE.delta_pct.toFixed(1)}% below 11-year baseline`,
    );

  const wardMeanTrigger = wardReasons.length > 0;
  const wardMeanTriggerReason =
    wardReasons.join("; ") || "Ward-mean vegetation within normal range";

  // ── Combined ──────────────────────────────────────────────────────────────
  const triggered = pixelTrigger || wardMeanTrigger;
  const allReasons = [...pixelReasons, ...wardReasons];

  logger.info(
    {
      pixelTrigger,
      wardMeanTrigger,
      stressedPixelPct: anomaly.wardStressedPixelPct,
      medianAnomalyPct: anomaly.NDVI.p50,
      NDVI_delta: NDVI.delta_pct,
    },
    "[Detection Trigger] Dual-signal evaluation complete",
  );

  return {
    NDVI,
    NDRE,
    RED_EDGE,
    pixelTrigger,
    pixelTriggerReason,
    wardMeanTrigger,
    wardMeanTriggerReason,
    triggered,
    trigger_reason:
      allReasons.join("; ") || "Vegetation within normal range — no alert",
  };
}
