/**
 * Ward/cell-granularity overlays: peer signal (what other herders in
 * the ward reported this week) and per-cell stress (ward aggregate +
 * nearest-cell, falling back to the ward centroid until Jisajili/voice
 * capture real herder GPS).
 */

import {
  peerSignalForWard,
  nearestCellForCoordinates,
  latestCellSnapshot,
  wardCellStressSummary,
} from "../../supabase/index.js";
import { centroidForTenant } from "../../wpdx.js";
import { tenantForWardId } from "../../wardMapping.js";
import type { HerderContext } from "../types.js";

/**
 * Overlay: peer signal for the caller's ward — what other herders
 * have reported this week. Fires silently when the ward has no
 * activity (fresh pilot, no signal yet).
 */
export async function overlayPeerSignal(ctx: HerderContext): Promise<HerderContext> {
  if (!ctx.wardId) return ctx;
  const signal = await peerSignalForWard(ctx.wardId, 7);
  if (!signal || signal.callerCount === 0) return ctx;
  return {
    ...ctx,
    peerCallerCount: signal.callerCount,
    peerThinAnimalsCount: signal.thinAnimalsCount,
    peerBrokenWaterCount: signal.brokenWaterCount,
    peerWindowDays: signal.windowDays,
  };
}

/**
 * Overlay: per-cell stress signal for the caller's ward.
 *   - Ward aggregate: how many of the ward's cells are stressed today,
 *     and the median NDVI across all cells. Populated whenever the
 *     ward has cells in Supabase.
 *   - Nearest-cell: the cell closest to the herder's coordinates.
 *     Until we capture herder GPS in Jisajili/voice, we fall back to
 *     the ward centroid — which resolves to the geographic centre of
 *     the ward, not the herder's actual location. Better than nothing
 *     while GPS capture is on the roadmap.
 */
export async function overlayCellStress(ctx: HerderContext): Promise<HerderContext> {
  if (!ctx.wardId) return ctx;
  const summary = await wardCellStressSummary(ctx.wardId);
  const origin =
    centroidForTenant(tenantForWardId(ctx.wardId)) ??
    centroidForTenant("bula-pesa");
  let cell = null as null | Awaited<ReturnType<typeof nearestCellForCoordinates>>;
  let snapshot = null as null | Awaited<ReturnType<typeof latestCellSnapshot>>;
  if (origin) {
    cell = await nearestCellForCoordinates(origin.lat, origin.lon, ctx.wardId);
    if (cell) {
      snapshot = await latestCellSnapshot(cell.ward_cell_id);
    }
  }
  return {
    ...ctx,
    wardCellCount: summary?.cellCount ?? null,
    wardStressedCellCount: summary?.stressedCellCount ?? null,
    wardCellNdviMedian: summary?.ndviMedian ?? null,
    nearestCellId: cell?.ward_cell_id ?? null,
    nearestCellNdvi: snapshot?.ndvi_mean ?? null,
    nearestCellAnomaly: snapshot?.ndvi_anomaly ?? null,
  };
}
