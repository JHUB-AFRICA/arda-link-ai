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

import { recentWaterPointGroundTruth } from "../../supabase/index.js";
import { centroidForTenant, nearestWorkingKnownPoints } from "../../wpdx.js";
import { tenantForWardId } from "../../wardMapping.js";
import type { HerderContext } from "../types.js";

export async function overlayNearestWaterPoint(
  ctx: HerderContext,
): Promise<HerderContext> {
  const origin =
    centroidForTenant(tenantForWardId(ctx.wardId)) ??
    centroidForTenant("bula-pesa");
  if (!origin) return ctx;
  const overrides = (await recentWaterPointGroundTruth(90)) ?? [];
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
