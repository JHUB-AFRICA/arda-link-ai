/**
 * Herder identification + localization — Supabase-primary, local-mirror
 * fallback.
 *
 * Since 2026-07-07 Supabase is the source of truth for herder identity
 * and ward reference data. `resolveHerderContext`:
 *
 *   1. Tries Supabase first — `pastoralists.phone_number` lookup + the
 *      `api_call_context` view which joins pastoralist + ward + latest
 *      satellite + latest weather in one row.
 *   2. Falls back to our local Postgres mirror if Supabase is
 *      unreachable, misconfigured, or the phone isn't there yet.
 *   3. Enriches with fields only the local mirror has (species
 *      breakdown cattle/goats/camels, water_source, extraction detail
 *      from ground_truth_reports for last_bcs / last_action_tag).
 *   4. Returns a merged HerderContext used by USSD, SMS, voice sims and
 *      the deterministic pipeline to compose personalized replies.
 */

import {
  isSupabaseConfigured,
  callContextByPhone,
  pastoralistByPhone,
  identityForPhone,
} from "../supabase/index.js";
import { wardIdForTenant, tenantForWardId } from "../wardMapping.js";
import { DEFAULT_TENANT_ID, baseContext } from "./base.js";
import {
  mergeSupabaseCallContext,
  mergeSupabasePastoralist,
  mergeLeadIdentity,
  overlayWardReference,
} from "./overlays/supabasePrimary.js";
import {
  overlayHistoricalAnomaly,
  overlayNeighborAdvice,
} from "./overlays/anomaly.js";
import { overlayPeerSignal, overlayCellStress } from "./overlays/peerAndCell.js";
import { overlayNearestWaterPoint } from "./overlays/waterPoint.js";
import { enrichFromLocalMirror, resolveFromLocalOnly } from "./localMirror.js";
import type { HerderContext } from "./types.js";

export async function resolveHerderContext(
  rawPhone: string,
  tenantId: string = DEFAULT_TENANT_ID,
): Promise<HerderContext> {
  let ctx = baseContext(rawPhone, tenantId);
  if (!ctx.canonicalPhone) return ctx;

  // ─── 1. Supabase primary ─────────────────────────────────────────────
  if (isSupabaseConfigured()) {
    // Try the joined view first — one round-trip for pastoralist + ward +
    // satellite + weather. Falls back to per-table lookups if the view
    // returns nothing (schema for the row exists but view might have
    // gaps in RLS).
    const view = await callContextByPhone(ctx.canonicalPhone);
    if (view) {
      ctx = mergeSupabaseCallContext(ctx, view);
    } else {
      const p = await pastoralistByPhone(ctx.canonicalPhone);
      if (p) {
        ctx = mergeSupabasePastoralist(ctx, p);
      } else {
        // No verified pastoralist. Check the leads table via the
        // identity view — a self-subscribed lead still deserves a
        // personalised opener and language routing, just gated
        // differently downstream.
        const identity = await identityForPhone(ctx.canonicalPhone);
        if (identity && identity.tier === "lead") {
          ctx = mergeLeadIdentity(ctx, identity);
        }
      }
    }

    // If Supabase resolved the herder, backfill the local-only detail
    // (species breakdown, last extraction, water_source).
    if (ctx.source === "supabase") {
      ctx = await enrichFromLocalMirror(ctx, tenantId);
      ctx = await overlayWardReference(ctx);
      ctx = await overlayHistoricalAnomaly(ctx);
      ctx = await overlayNeighborAdvice(ctx);
      ctx = await overlayNearestWaterPoint(ctx);
      ctx = await overlayPeerSignal(ctx);
      ctx = await overlayCellStress(ctx);
      // Backfill tenant/ward correlation when Supabase gave us a ward_id.
      if (ctx.wardId && !tenantForWardId(ctx.wardId)) {
        ctx.wardId = wardIdForTenant(tenantId);
      }
      return ctx;
    }
  }

  // ─── 2. Local mirror fallback ────────────────────────────────────────
  ctx = await resolveFromLocalOnly(ctx, tenantId);
  ctx = await overlayWardReference(ctx);
  ctx = await overlayHistoricalAnomaly(ctx);
  ctx = await overlayNeighborAdvice(ctx);
  ctx = await overlayNearestWaterPoint(ctx);
  ctx = await overlayPeerSignal(ctx);
  ctx = await overlayCellStress(ctx);
  return ctx;
}
