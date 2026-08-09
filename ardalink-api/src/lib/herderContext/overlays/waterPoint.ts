/**
 * Nearest WPDx water point + status, blended with recent herder
 * ground-truth. If any herder reported "working" for a point within
 * 90 days, we surface THAT point (freshest evidence wins). Falls back
 * to the raw WPDx snapshot when no ground truth exists.
 *
 * WPDx's 2012 Isiolo survey is all Non-Functional, so without the
 * ground-truth overlay every herder opener would say "the nearest
 * borehole was broken", which is stale after 14 years. This overlay
 * IS the mechanism by which herder reports become the new source of
 * truth.
 */

import { recentWaterPointGroundTruth, latestCorrectionFor } from "../../supabase/index.js";
import {
  centroidForTenant,
  nearestWorkingKnownPoints,
  nearestConfirmedWorkingPoints,
  type WpdxStatus,
} from "../../wpdx.js";
import { nearestRealWaterPoints } from "../../waterNodes.js";
import { tenantForWardId } from "../../wardMapping.js";
import type { HerderContext } from "../types.js";

export async function overlayNearestWaterPoint(
  ctx: HerderContext,
): Promise<HerderContext> {
  // Prefer the herder's own permanently-stored location (registration or
  // an explicit relocation — see overlayStoredLocation) over the generic
  // ward centroid: real incident (2026-08-06) — a registered herder
  // mentioned a landmark near them and the bot fell back to a ward-wide
  // estimate ~192km away instead of considering anything specific to
  // that herder, because nothing here ever consulted their own stored
  // coordinates at all.
  const origin =
    ctx.lastKnownLat != null && ctx.lastKnownLon != null
      ? { lat: ctx.lastKnownLat, lon: ctx.lastKnownLon }
      : ((await centroidForTenant(tenantForWardId(ctx.wardId))) ??
        (await centroidForTenant("bula-pesa")));
  if (!origin) return ctx;
  const rawOverrides = (await recentWaterPointGroundTruth(90)) ?? [];
  // Operator-review layer (migration 0009): if an operator has corrected
  // a specific call's water_point_status, prefer that corrected value
  // over the raw herder/LLM-extracted one before it ever reaches
  // nearestWorkingKnownPoints' ranking. Corrections are looked up
  // per-row rather than bulk-fetched since this list is already capped
  // (limit=200) and infrequent (90-day window) — not a hot path.
  const overrides = await Promise.all(
    rawOverrides.map(async (o) => {
      const correction = await latestCorrectionFor(o.call_id, "water_point_status");
      return correction ? { ...o, water_point_status: correction.corrected_value } : o;
    }),
  );
  // REAL water_nodes first (205 rows, the same data the dashboard shows).
  // The static WPDx snapshot below is a 10-row 2012 survey where every
  // row is Non-Functional — only a fallback for when the engine is
  // unreachable, never the primary source (2026-08-09: reading it as
  // primary is what made the bot believe Isiolo had no working water).
  const real = await nearestRealWaterPoints(origin, 500);
  let top: { displayName: string; distanceKm: number; status: WpdxStatus } | null = null;
  let working: { displayName: string; distanceKm: number } | null = null;

  if (real && real.length > 0) {
    const first = real[0]!;
    top = { displayName: first.name, distanceKm: first.distanceKm, status: first.status };
    const w = real.find((r) => r.status === "working");
    working = w ? { displayName: w.name, distanceKm: w.distanceKm } : null;
  } else if (real === null) {
    const fallback = nearestWorkingKnownPoints(origin, 1, overrides)[0];
    if (fallback) {
      top = {
        displayName: fallback.displayName,
        distanceKm: fallback.distanceKm,
        status: fallback.status,
      };
    }
    const fw = nearestConfirmedWorkingPoints(origin, 1, overrides)[0];
    working = fw ? { displayName: fw.displayName, distanceKm: fw.distanceKm } : null;
  }
  if (!top && !working) return ctx;
  return {
    ...ctx,
    nearestWaterPointName: top?.displayName ?? ctx.nearestWaterPointName,
    nearestWaterPointDistanceKm: top
      ? Math.round(top.distanceKm * 10) / 10
      : ctx.nearestWaterPointDistanceKm,
    nearestWaterPointStatus: top?.status ?? ctx.nearestWaterPointStatus,
    nearestWorkingWaterPointName: working?.displayName ?? null,
    nearestWorkingWaterPointDistanceKm: working
      ? Math.round(working.distanceKm * 10) / 10
      : null,
  };
}
