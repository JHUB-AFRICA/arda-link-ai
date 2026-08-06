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
import { centroidForTenant, nearestWorkingKnownPoints } from "../../wpdx.js";
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
      : (centroidForTenant(tenantForWardId(ctx.wardId)) ??
        centroidForTenant("bula-pesa"));
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
  const nearest = nearestWorkingKnownPoints(origin, 1, overrides);
  const top = nearest[0];
  if (!top) return ctx;
  return {
    ...ctx,
    nearestWaterPointName: top.displayName,
    nearestWaterPointDistanceKm:
      Math.round(top.distanceKm * 10) / 10,
    nearestWaterPointStatus: top.status,
  };
}
