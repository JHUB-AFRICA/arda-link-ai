/**
 * Baseline loading and vegetation-delta computation.
 *
 * Replaces the legacy Azure Cosmos DB-backed implementation. Source of
 * truth is the engine's `gis_engine.baseline_aggregate` (and optionally
 * `gis_engine.baseline_pixel`), populated by
 * `ardalink-engine/scripts/populate_baseline.py`.
 *
 * Two trigger signals are evaluated:
 *
 *   1. **Pixel-level** (primary): the live EE composite is compared
 *      against the ward's own per-pixel history. Fires when >=25% of
 *      vegetated pixels are >15% below their own 10-year norm, OR when
 *      the median pixel anomaly is below -12%.
 *
 *   2. **Ward-mean** (secondary / legacy framing): the live ward-mean
 *      NDVI / NDRE / Red-edge is compared against the per-ward, per-month
 *      p50 from the aggregate baseline. Fires when ward-mean NDVI is
 *      >=15% below baseline.
 *
 * The pixel-level signal requires the per-pixel grid to be populated
 * (large — typically from a multi-year GEE historical pipeline). When
 * the per-pixel grid is missing, only the ward-mean signal is evaluated
 * and `pixelTrigger` is reported as `false` with an explicit reason.
 */

import { logger } from "./logger.js";
import type { LiveVegetation } from "./satellite.js";
import {
  fetchBaselineAggregate,
  fetchBaselinePixel,
  type BaselineAggregateRow,
} from "./engine.js";

export interface MonthlyBaseline {
  /** Source-of-truth aggregate (may be null if engine has no data for this month). */
  aggregate: BaselineAggregateRow | null;
  /** Source-of-truth per-pixel grid (may be null/empty for wards without pixel baseline). */
  pixelCells: Awaited<ReturnType<typeof fetchBaselinePixel>>;
  /** Month (1..12). */
  month: number;
  /** Friendly month name. */
  month_name: string;
  /** Convenience shape: ward-mean NDVI/NDRE/Red-edge from the aggregate (for legacy code). */
  bands: Record<
    string,
    { spatial_mean: number; spatial_min: number; spatial_max: number }
  >;
}

export interface VegetationDelta {
  /** Ward-mean comparison vs the engine's aggregate baseline (secondary signal). */
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
  /** Where the baseline came from: "aggregate", "pixel+aggregate", or "none". */
  baselineSource: "aggregate" | "pixel+aggregate" | "none";
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

// Primary thresholds (unchanged from the Cosmos-era contract).
const PIXEL_STRESS_PCT_THRESHOLD = 25;
const PIXEL_MEDIAN_THRESHOLD = -12;
// Secondary (legacy) ward-mean threshold.
const WARD_MEAN_THRESHOLD = -15;

/**
 * Look up the historical baseline for one (tenant, ward, month).
 *
 * Returns an empty/incomplete `MonthlyBaseline` when the engine has no
 * data for the requested month. The caller can render that as "no
 * baseline yet" rather than failing the entire intelligence cycle.
 */
export async function getMonthlyBaseline(
  month: number,
  wardId: string,
  tenantId: string = "isiolo",
): Promise<MonthlyBaseline> {
  const name = MONTH_NAMES[month - 1];

  const [aggregate, pixelCells] = await Promise.all([
    fetchBaselineAggregate(wardId, month, tenantId),
    fetchBaselinePixel(wardId, month, "ndvi", tenantId),
  ]);

  // Convenience legacy shape: derive spatial_mean / min / max from the
  // aggregate percentile envelope (p5 = "min", p50 = "mean", and we
  // approximate max as p50 + (p50 - p5) when only p50 is present).
  const bands: MonthlyBaseline["bands"] = aggregate
    ? {
        NDVI_mean: bandFromAggregate(aggregate.ndvi_p50, aggregate.ndvi_p5),
        NDRE_mean: bandFromAggregate(aggregate.ndre_p50, aggregate.ndre_p5),
        RED_EDGE_mean: bandFromAggregate(
          aggregate.red_edge_p50,
          aggregate.red_edge_p5,
        ),
      }
    : {};

  logger.info(
    {
      month,
      name,
      ward_id: wardId,
      has_aggregate: !!aggregate,
      pixel_cell_count: pixelCells?.length ?? 0,
      source: aggregate?.source ?? null,
    },
    "[Baseline Match] Historical baseline retrieved",
  );

  return {
    aggregate,
    pixelCells,
    month,
    month_name: name,
    bands,
  };
}

function bandFromAggregate(
  p50: number | null,
  p5: number | null,
): { spatial_mean: number; spatial_min: number; spatial_max: number } {
  if (p50 == null && p5 == null) {
    return { spatial_mean: 0, spatial_min: 0, spatial_max: 0 };
  }
  const mean = p50 ?? p5 ?? 0;
  const min = p5 ?? p50 ?? 0;
  // We don't store p95 — best-effort max = p50 + (p50 - p5) when p5 is
  // available, else p50 itself. Caller can still render the trigger logic.
  const max = p50 != null && p5 != null ? p50 + (p50 - p5) : p50 ?? p5 ?? 0;
  return { spatial_mean: mean, spatial_min: min, spatial_max: max };
}

/**
 * Compute the dual-signal trigger.
 *
 * `live` carries the just-fetched EE composite (median p50, p5 across the
 * ward). `baseline` carries the historical aggregate (and optionally the
 * per-pixel grid, used for the more sensitive pixel-level signal).
 */
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
  const hasPixelBaseline = (baseline.pixelCells?.length ?? 0) > 0;

  if (hasPixelBaseline) {
    if (anomaly.wardStressedPixelPct >= PIXEL_STRESS_PCT_THRESHOLD) {
      pixelReasons.push(
        `${anomaly.wardStressedPixelPct.toFixed(1)}% of vegetated pixels are >15% below their per-pixel baseline`,
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
  } else {
    // No pixel grid → fall back to the live anomaly heuristic. Same
    // thresholds apply — the "median NDVI anomaly" comes from GEE itself
    // regardless of whether we have a per-pixel baseline.
    if (anomaly.wardStressedPixelPct >= PIXEL_STRESS_PCT_THRESHOLD) {
      pixelReasons.push(
        `${anomaly.wardStressedPixelPct.toFixed(1)}% of vegetated pixels are >15% below the ward median (per-pixel baseline not populated)`,
      );
    }
  }

  const pixelTrigger = pixelReasons.length > 0;
  const pixelTriggerReason =
    pixelReasons.join("; ") || "Pixel-level vegetation within normal range";

  // ── Ward-mean trigger (secondary / legacy) ────────────────────────────────
  const wardReasons: string[] = [];
  if (NDVI.delta_pct < WARD_MEAN_THRESHOLD)
    wardReasons.push(
      `ward-mean NDVI ${NDVI.delta_pct.toFixed(1)}% below aggregate baseline`,
    );
  if (RED_EDGE.delta_pct < WARD_MEAN_THRESHOLD)
    wardReasons.push(
      `ward-mean RED_EDGE ${RED_EDGE.delta_pct.toFixed(1)}% below aggregate baseline`,
    );

  const wardMeanTrigger = wardReasons.length > 0;
  const wardMeanTriggerReason =
    wardReasons.join("; ") || "Ward-mean vegetation within normal range";

  // ── Combined ──────────────────────────────────────────────────────────────
  const triggered = pixelTrigger || wardMeanTrigger;
  const allReasons = [...pixelReasons, ...wardReasons];

  const baselineSource: VegetationDelta["baselineSource"] = !baseline.aggregate
    ? "none"
    : hasPixelBaseline
      ? "pixel+aggregate"
      : "aggregate";

  logger.info(
    {
      pixelTrigger,
      wardMeanTrigger,
      stressedPixelPct: anomaly.wardStressedPixelPct,
      medianAnomalyPct: anomaly.NDVI.p50,
      NDVI_delta: NDVI.delta_pct,
      baselineSource,
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
    baselineSource,
  };
}