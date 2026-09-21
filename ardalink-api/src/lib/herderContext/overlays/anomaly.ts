/**
 * Real-anomaly overlays: Supabase's 11-year satellite history turned
 * into an actionable anomaly claim ("driest June since 2017", "VCI
 * 12/100"), and neighbor-ward advice when a nearby ward is doing
 * meaningfully better.
 */

import {
  isSupabaseConfigured,
  bestNeighborForAdvice,
  fetchWardMonthlyBaseline,
  computeVci,
  countWorseThanYears,
} from "../../supabase/index.js";
import type { HerderContext } from "../types.js";

/**
 * We anchor on the calendar month from `wardMonth` (view label like
 * "June 2026") or, when that's absent, today's UTC month. Using the
 * satellite period end would be more accurate but view-side rows use
 * text month names, so we tolerate a small skew.
 */
function currentMonthFor(ctx: HerderContext): number {
  const m = ctx.wardMonth?.trim().toLowerCase();
  if (m) {
    const idx = [
      "january",
      "february",
      "march",
      "april",
      "may",
      "june",
      "july",
      "august",
      "september",
      "october",
      "november",
      "december",
    ].findIndex((n) => m.startsWith(n));
    if (idx >= 0) return idx + 1;
  }
  return new Date().getUTCMonth() + 1;
}

/**
 * Overlay Supabase's 11-year satellite history to turn the current
 * NDVI reading into a real anomaly claim ("driest June since 2017",
 * "VCI 12/100", "worse than 8 of the last 10 Junes").
 *
 * Falls through unchanged when Supabase is unreachable, when there's
 * no current NDVI to compare against, or when history has <3 years.
 * This is deliberately silent-on-failure: the herder's opener still
 * plays, we just skip the anomaly line rather than blocking on it.
 */
export async function overlayHistoricalAnomaly(
  ctx: HerderContext,
): Promise<HerderContext> {
  if (!isSupabaseConfigured()) return ctx;
  if (ctx.wardNdviMean == null) return ctx;
  const month = currentMonthFor(ctx);
  const baseline = await fetchWardMonthlyBaseline(ctx.wardId, month);
  if (!baseline) return ctx;
  const vci = computeVci(ctx.wardNdviMean, baseline);
  const worse = countWorseThanYears(ctx.wardNdviMean, baseline);
  return {
    ...ctx,
    baselineMonth: month,
    baselineYears: baseline.years,
    ndviBaselineP50: baseline.ndvi.p50,
    ndviBaselineP5: baseline.ndvi.p5,
    ndviBaselineP95: baseline.ndvi.p95,
    vciDerived: vci,
    worseThanYears: worse?.worseThan ?? null,
    driestYearOnRecord: baseline.ndvi.minYear,
  };
}

/**
 * Neighbor overlay — cheap when nothing beats the caller's own ward
 * (the common drought case). Only populates fields when a real
 * neighbor is meaningfully better.
 */
export async function overlayNeighborAdvice(
  ctx: HerderContext,
): Promise<HerderContext> {
  if (!isSupabaseConfigured() || ctx.wardNdviMean == null) return ctx;
  const best = await bestNeighborForAdvice(ctx.wardId, ctx.wardNdviMean);
  if (!best) return ctx;
  return {
    ...ctx,
    neighborWardName: best.wardName,
    neighborNdviMean: best.ndviMean,
    neighborNdviDelta: best.ndviDelta,
  };
}
