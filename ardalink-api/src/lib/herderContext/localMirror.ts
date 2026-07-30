/**
 * Local-mirror enrichment/fallback. `enrichFromLocalMirror` backfills
 * fields only the local mirror has (species breakdown, water_source)
 * onto a Supabase-resolved context; `resolveFromLocalOnly` is the full
 * fallback path used when Supabase is unreachable or the herder isn't
 * in Supabase yet.
 */

import { eq } from "drizzle-orm";
import { pastoralistsTable } from "@workspace/db";
import { withTenantContext } from "../tenancy-context.js";
import { logger } from "../logger.js";
import { isSupabaseConfigured, recentGroundTruthCalls } from "../supabase/index.js";
import type { HerderContext } from "./types.js";

/**
 * Enrich a Supabase-resolved context with fields only the local mirror
 * knows about (species breakdown, water_source). Last ground-truth fields
 * (bcsScore, bcsSpecies, actionTag, reportedLocation, reportedQuadrant) are
 * sourced from Supabase ground_truth_calls; fields not present there are null.
 */
export async function enrichFromLocalMirror(
  ctx: HerderContext,
  tenantId: string,
): Promise<HerderContext> {
  if (!ctx.canonicalPhone) return ctx;
  try {
    const enriched = await withTenantContext(tenantId, async (tx) => {
      const [pastoralist] = await tx
        .select()
        .from(pastoralistsTable)
        .where(eq(pastoralistsTable.phone, ctx.canonicalPhone))
        .limit(1);

      return {
        ...ctx,
        name: ctx.name ?? pastoralist?.name ?? null,
        location: ctx.location ?? pastoralist?.location ?? null,
        cattle: pastoralist?.cattle ?? ctx.cattle,
        goats: pastoralist?.goats ?? ctx.goats,
        camels: pastoralist?.camels ?? ctx.camels,
        waterSource: pastoralist?.waterSource ?? ctx.waterSource,
        lastContactAt: pastoralist?.lastContactAt ?? ctx.lastContactAt,
      };
    });

    // Backfill lastBcsScore from Supabase ground_truth_calls if available.
    if (isSupabaseConfigured() && ctx.lastBcsScore == null) {
      try {
        const recent = await recentGroundTruthCalls(1);
        const latest = recent?.[0];
        if (latest) {
          return {
            ...enriched,
            lastBcsScore: latest.bcs_score ?? null,
            lastBcsSpecies: null,
            lastActionTag: null,
            lastReportedLocation: null,
            lastReportedQuadrant: null,
            lastReportAt: latest.created_at ? new Date(latest.created_at) : null,
          };
        }
      } catch {
        // ignore — Supabase unavailable
      }
    }
    return enriched;
  } catch (err) {
    logger.warn({ err }, "[HerderContext] Local mirror enrichment failed");
    return ctx;
  }
}

/**
 * Local-only fallback used when Supabase is unreachable or the herder
 * isn't in Supabase yet. Reads pastoralists table only; last ground-truth
 * fields not available on the local mirror return null.
 */
export async function resolveFromLocalOnly(
  ctx: HerderContext,
  tenantId: string,
): Promise<HerderContext> {
  if (!ctx.canonicalPhone) return ctx;
  try {
    return await withTenantContext(tenantId, async (tx) => {
      const [pastoralist] = await tx
        .select()
        .from(pastoralistsTable)
        .where(eq(pastoralistsTable.phone, ctx.canonicalPhone))
        .limit(1);
      if (!pastoralist) return ctx;

      return {
        ...ctx,
        known: true,
        // Local mirror row → treat as verified. The mirror only ever
        // holds ops-added rows (leads never sync down since S2/S6).
        tier: "verified",
        source: "local",
        name: pastoralist.name,
        location: pastoralist.location || null,
        cattle: pastoralist.cattle,
        goats: pastoralist.goats,
        camels: pastoralist.camels,
        waterSource: pastoralist.waterSource,
        lastContactAt: pastoralist.lastContactAt,
        // ground_truth_reports dropped — these fields return null when only
        // local data is available. Supabase ground_truth_calls is primary.
        lastBcsScore: null,
        lastBcsSpecies: null,
        lastActionTag: null,
        lastReportedLocation: null,
        lastReportedQuadrant: null,
        lastReportAt: null,
      };
    });
  } catch (err) {
    logger.warn(
      { err, phone: ctx.canonicalPhone },
      "[HerderContext] Local lookup failed",
    );
    return ctx;
  }
}
