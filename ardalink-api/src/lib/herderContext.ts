/**
 * Herder identification + localization — Supabase-primary, local-mirror
 * fallback.
 *
 * Since 2026-07-07 Supabase is the source of truth for herder identity
 * and ward reference data. This module:
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

import { and, desc, eq } from "drizzle-orm";
import {
  pastoralistsTable,
  groundTruthReportsTable,
} from "@workspace/db";
import { withTenantContext } from "./tenancy-context.js";
import { getLastResult } from "./intelligence.js";
import { logger } from "./logger.js";
import {
  isSupabaseConfigured,
  callContextByPhone,
  latestSatelliteFor,
  latestWeatherFor,
  pastoralistByPhone,
  bestNeighborForAdvice,
  fetchWardMonthlyBaseline,
  computeVci,
  countWorseThanYears,
  identityForPhone,
  type SbCallContext,
  type SbPastoralist,
  type SbPhoneIdentity,
  type WardMonthlyBaseline,
} from "./supabase.js";
import { wardIdForTenant, tenantForWardId, DEFAULT_WARD_ID } from "./wardMapping.js";
import {
  centroidForTenant,
  nearestPoints,
  nearestWorkingKnownPoints,
  type WpdxStatus,
} from "./wpdx.js";
import {
  recentWaterPointGroundTruth,
  peerSignalForWard,
  type SbPeerSignal,
} from "./supabase.js";

const DEFAULT_TENANT_ID =
  process.env.DETERMINISTIC_TENANT_ID ?? "bula-pesa";

export interface HerderContext {
  /** True if we matched a pastoralist row on either Supabase or local. */
  known: boolean;
  /**
   * Data tier — critical for downstream policy:
   *   verified — real pastoralists row. Full analytics, drill batches,
   *              ground_truth_reports inserts, threshold alerts.
   *   lead     — self-subscribed via USSD/SMS/inbound-call. Welcome
   *              cadence only; NEVER included in the daily drill or
   *              analytics until ops promotes them.
   *   unknown  — phone matched nothing; skip every outbound dispatch.
   */
  tier: "verified" | "lead" | "unknown";
  /** Which source resolved the herder (helpful for debugging). */
  source: "supabase" | "local" | "none";
  phone: string;
  /** Canonicalized `+254…` phone or original input if it didn't normalize. */
  canonicalPhone: string;

  // Herder profile
  pastoralistId: string | null; // Supabase uuid, when available
  name: string | null;
  location: string | null;
  preferredLanguage: string | null;
  herdSize: number | null; // Supabase single-integer view
  cattle: number | null; // local breakdown, may be null when only Supabase knows the herder
  goats: number | null;
  camels: number | null;
  waterSource: string | null;
  lastContactAt: Date | null;

  // Last ground-truth report (from local — Supabase's ground_truth_calls is empty)
  lastBcsScore: number | null;
  lastBcsSpecies: string | null;
  lastActionTag: string | null;
  lastReportedLocation: string | null;
  lastReportedQuadrant: string | null;
  lastReportAt: Date | null;

  // Fresh ward-level intelligence — Supabase-primary, in-process cycle as fallback
  wardId: string;
  wardName: string | null;
  wardMonth: string | null;
  wardStressedPct: number | null;
  wardNdviPct: number | null;
  wardNdviMean: number | null;
  wardVci: number | null;
  wardRainfall30dMm: number | null;
  wardTemperatureC: number | null;
  wardHumidityPct: number | null;
  wardEt0Mm: number | null;
  wardDroughtSeverity: string | null;
  wardRiskLevel: string | null;
  wardRecommendation: string | null;

  // Neighbor-ward advice — populated when a neighboring ward has
  // meaningfully higher NDVI so the deterministic opener can suggest
  // moving. Null when no neighbor is better (the common case in a
  // drought where everyone is suffering).
  neighborWardName: string | null;
  neighborNdviMean: number | null;
  neighborNdviDelta: number | null;

  // Nearest WPDx water point — pulled from a static snapshot so the
  // opener can say "your nearest water point is X, N km away". Falls
  // back to null when the WPDx dataset has no rows for the ward.
  nearestWaterPointName: string | null;
  nearestWaterPointDistanceKm: number | null;
  nearestWaterPointStatus: WpdxStatus | null;

  // Peer signal — what other herders in this ward have reported in
  // the last 7 days. Populated by overlayPeerSignal below when the
  // ward has any activity. Powers the "N wachungaji karibu nawe
  // wameripoti hali kama hii wiki hii" opener line.
  peerCallerCount: number | null;
  peerThinAnimalsCount: number | null;
  peerBrokenWaterCount: number | null;
  peerWindowDays: number | null;

  // Real-anomaly signals derived from Supabase's 11-year
  // satellite_indices history for this ward + calendar month. These
  // replace the fixed-threshold "97 % stressed" line with sentences
  // the caller can act on ("driest June since 2017").
  //   baselineMonth   — the calendar month we're comparing against
  //   baselineYears   — how many historical years the envelope covers
  //   ndviBaselineP50 — median NDVI for this month across history
  //   ndviBaselineP5  — 5th-percentile NDVI (drought threshold)
  //   ndviBaselineP95 — 95th-percentile (green-flush threshold)
  //   vciDerived      — 0..100, worst-ever = 0, best-ever = 100
  //   worseThanYears  — of the last N years, how many had a better NDVI
  //                     for this month than we're seeing now
  //   driestYearOnRecord — the historical year with the lowest NDVI
  //                     for this month (for "since YYYY" phrasing)
  baselineMonth: number | null;
  baselineYears: number | null;
  ndviBaselineP50: number | null;
  ndviBaselineP5: number | null;
  ndviBaselineP95: number | null;
  vciDerived: number | null;
  worseThanYears: number | null;
  driestYearOnRecord: number | null;
}

function canonicalize(phone: string): string {
  const trimmed = phone.replace(/\s+/g, "").trim();
  if (!trimmed) return trimmed;
  if (trimmed.startsWith("+")) return trimmed;
  if (trimmed.startsWith("00")) return "+" + trimmed.slice(2);
  if (trimmed.startsWith("0")) return "+254" + trimmed.slice(1);
  if (/^\d+$/.test(trimmed)) return "+" + trimmed;
  return trimmed;
}

function baseContext(rawPhone: string, tenantId: string): HerderContext {
  const canonicalPhone = canonicalize(rawPhone);
  const ward = getLastResult();
  const wardId = wardIdForTenant(tenantId);
  return {
    known: false,
    tier: "unknown",
    source: "none",
    phone: rawPhone,
    canonicalPhone,
    pastoralistId: null,
    name: null,
    location: null,
    preferredLanguage: null,
    herdSize: null,
    cattle: null,
    goats: null,
    camels: null,
    waterSource: null,
    lastContactAt: null,
    lastBcsScore: null,
    lastBcsSpecies: null,
    lastActionTag: null,
    lastReportedLocation: null,
    lastReportedQuadrant: null,
    lastReportAt: null,
    wardId,
    wardName: null,
    wardMonth: ward?.month_name ?? null,
    wardStressedPct: ward?.live?.anomaly?.wardStressedPixelPct ?? null,
    wardNdviPct: ward?.delta?.NDVI?.delta_pct ?? null,
    wardNdviMean: null,
    wardVci: null,
    wardRainfall30dMm: ward?.climate?.rolling30Day?.totalPrecipMm ?? null,
    wardTemperatureC: null,
    wardHumidityPct: null,
    wardEt0Mm: ward?.climate?.rolling30Day?.totalET0Mm ?? null,
    wardDroughtSeverity: ward?.climate?.rolling30Day?.droughtSeverity ?? null,
    wardRiskLevel: ward?.forecast?.outlook.riskLevel ?? null,
    wardRecommendation: ward?.forecast?.outlook.recommendation ?? null,
    neighborWardName: null,
    neighborNdviMean: null,
    neighborNdviDelta: null,
    nearestWaterPointName: null,
    nearestWaterPointDistanceKm: null,
    nearestWaterPointStatus: null,
    peerCallerCount: null,
    peerThinAnimalsCount: null,
    peerBrokenWaterCount: null,
    peerWindowDays: null,
    baselineMonth: null,
    baselineYears: null,
    ndviBaselineP50: null,
    ndviBaselineP5: null,
    ndviBaselineP95: null,
    vciDerived: null,
    worseThanYears: null,
    driestYearOnRecord: null,
  };
}

/**
 * Overlay: peer signal for the caller's ward — what other herders
 * have reported this week. Fires silently when the ward has no
 * activity (fresh pilot, no signal yet).
 */
async function overlayPeerSignal(ctx: HerderContext): Promise<HerderContext> {
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
 * Overlay: nearest WPDx water point + status, blended with recent
 * herder ground-truth. If any herder reported "working" for a point
 * within 90 days, we surface THAT point (freshest evidence wins).
 * Falls back to the raw WPDx snapshot when no ground truth exists.
 *
 * WPDx's 2012 Isiolo survey is all Non-Functional, so without the
 * ground-truth overlay every herder opener would say "the nearest
 * borehole was broken", which is stale after 14 years. This overlay
 * IS the mechanism by which herder reports become the new source of
 * truth.
 */
async function overlayNearestWaterPoint(
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

/**
 * Overlay Supabase's `api_call_context` row on a base context. This
 * view already joins pastoralist + ward + latest satellite + latest
 * weather — one round-trip and the ward-level fields are populated
 * from live Supabase data, not an in-process intelligence cycle.
 */
function mergeSupabaseCallContext(
  base: HerderContext,
  ctx: SbCallContext,
): HerderContext {
  return {
    ...base,
    known: true,
    // A hit on api_call_context means the phone is in `pastoralists`
    // (the view only reads verified rows). Leads never appear here.
    tier: "verified",
    source: "supabase",
    pastoralistId: ctx.pastoralist_id,
    name: ctx.full_name ?? base.name,
    preferredLanguage: ctx.preferred_language ?? base.preferredLanguage,
    wardId: ctx.ward_id ?? base.wardId,
    wardName: ctx.ward_name,
    wardNdviMean: ctx.ndvi_mean,
    wardVci: ctx.vci_value,
    wardRainfall30dMm: ctx.rainfall_mm_30d ?? base.wardRainfall30dMm,
    wardTemperatureC: ctx.temperature_c,
    wardHumidityPct: ctx.humidity_pct,
    wardEt0Mm: ctx.evapotranspiration_mm ?? base.wardEt0Mm,
  };
}

function mergeSupabasePastoralist(
  base: HerderContext,
  p: SbPastoralist,
): HerderContext {
  return {
    ...base,
    known: true,
    tier: "verified",
    source: "supabase",
    pastoralistId: p.pastoralist_id,
    name: p.full_name ?? base.name,
    location: p.location_text ?? base.location,
    preferredLanguage: p.preferred_language ?? base.preferredLanguage,
    herdSize: p.herd_size ?? base.herdSize,
    wardId: p.ward_id ?? base.wardId,
  };
}

async function overlayWardReference(
  ctx: HerderContext,
): Promise<HerderContext> {
  // If the call-context view already populated the ward fields, don't
  // re-hit Supabase for the same numbers.
  if (ctx.wardNdviMean != null || ctx.wardVci != null) return ctx;
  if (!isSupabaseConfigured()) return ctx;
  const wardId = ctx.wardId || DEFAULT_WARD_ID;
  const [sat, wx] = await Promise.all([
    latestSatelliteFor(wardId),
    latestWeatherFor(wardId),
  ]);
  return {
    ...ctx,
    wardNdviMean: sat?.ndvi_mean ?? ctx.wardNdviMean,
    wardVci: sat?.vci_value ?? ctx.wardVci,
    wardRainfall30dMm: wx?.rainfall_mm_30d ?? ctx.wardRainfall30dMm,
    wardTemperatureC: wx?.temperature_c ?? ctx.wardTemperatureC,
    wardHumidityPct: wx?.humidity_pct ?? ctx.wardHumidityPct,
    wardEt0Mm: wx?.evapotranspiration_mm ?? ctx.wardEt0Mm,
  };
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
 *
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

async function overlayHistoricalAnomaly(
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
async function overlayNeighborAdvice(
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

/**
 * Enrich a Supabase-resolved context with fields only the local mirror
 * knows about (species breakdown, water_source, extraction detail from
 * the last ground_truth_reports row).
 */
async function enrichFromLocalMirror(
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

      const [lastReport] = await tx
        .select()
        .from(groundTruthReportsTable)
        .where(
          and(
            eq(groundTruthReportsTable.phone, ctx.canonicalPhone),
            eq(groundTruthReportsTable.tenantId, tenantId),
          ),
        )
        .orderBy(desc(groundTruthReportsTable.createdAt))
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
        lastBcsScore: lastReport?.bcsScore ?? ctx.lastBcsScore,
        lastBcsSpecies: lastReport?.bcsSpecies ?? ctx.lastBcsSpecies,
        lastActionTag: lastReport?.actionTag ?? ctx.lastActionTag,
        lastReportedLocation:
          lastReport?.reportedLocation ?? ctx.lastReportedLocation,
        lastReportedQuadrant:
          lastReport?.reportedQuadrant ?? ctx.lastReportedQuadrant,
        lastReportAt: lastReport?.createdAt ?? ctx.lastReportAt,
      };
    });
  } catch (err) {
    logger.warn({ err }, "[HerderContext] Local mirror enrichment failed");
    return ctx;
  }
}

/**
 * Local-only fallback used when Supabase is unreachable or the herder
 * isn't in Supabase yet. Same shape/behavior as the pre-Supabase
 * version of this function.
 */
async function resolveFromLocalOnly(
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

      const [lastReport] = await tx
        .select()
        .from(groundTruthReportsTable)
        .where(
          and(
            eq(groundTruthReportsTable.phone, ctx.canonicalPhone),
            eq(groundTruthReportsTable.tenantId, tenantId),
          ),
        )
        .orderBy(desc(groundTruthReportsTable.createdAt))
        .limit(1);

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
        lastBcsScore: lastReport?.bcsScore ?? null,
        lastBcsSpecies: lastReport?.bcsSpecies ?? null,
        lastActionTag: lastReport?.actionTag ?? null,
        lastReportedLocation: lastReport?.reportedLocation ?? null,
        lastReportedQuadrant: lastReport?.reportedQuadrant ?? null,
        lastReportAt: lastReport?.createdAt ?? null,
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

/**
 * Overlay lead identity onto a base ctx when the phone matches a row
 * in pastoralist_leads (via api_phone_identity view). Marks tier='lead'
 * so downstream policy can gate outbound dispatches + analytics writes.
 */
function mergeLeadIdentity(
  base: HerderContext,
  id: SbPhoneIdentity,
): HerderContext {
  const lang =
    id.preferred_language === "en" || id.preferred_language === "sw"
      ? id.preferred_language
      : base.preferredLanguage;
  return {
    ...base,
    known: true,
    tier: "lead",
    source: "supabase",
    pastoralistId: id.identity_id,
    name: id.full_name ?? base.name,
    preferredLanguage: lang,
    wardId: id.ward_id ?? base.wardId,
    // location_text is what the lead typed during Jisajili (a ward
    // name like "Ngare Mara"), so it also serves as the display
    // wardName until we have a dedicated lookup.
    wardName: id.location_text ?? base.wardName,
    location: id.location_text ?? base.location,
  };
}

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
  return ctx;
}

/**
 * Build a short bilingual (Swahili/English) herder-specific brief string,
 * suitable for TTS or SMS. If the herder is known we use their name and
 * location; otherwise we fall back to ward-level info. Bounded to ~300
 * characters so it fits in a USSD screen or single-segment SMS budget.
 */
export function buildLocalizedBrief(ctx: HerderContext, lang: "sw" | "en"): string {
  const firstName = ctx.name ? ctx.name.trim().split(/\s+/)[0] : null;
  const namePart = firstName ? `${firstName}, ` : "";

  // Herders don't say "VCI 81" or "NDVI 0.28" — those are our
  // internal signals. Convert them into a plain word ranking:
  //   severity ∈ 'severe' | 'stressed' | 'moderate' | 'fair'
  // derived from vciDerived when we have a proper baseline, else
  // from wardStressedPct as a fallback.
  const severity = severityFromCtx(ctx);

  // Rainfall — herders think in "no rain lately" not "3mm/30d".
  const rainLine =
    ctx.wardRainfall30dMm != null
      ? ctx.wardRainfall30dMm < 5
        ? { sw: "mvua ni ndogo sana mwezi huu", en: "very little rain this month" }
        : ctx.wardRainfall30dMm < 20
          ? { sw: "mvua bado ni kidogo", en: "rain has been light" }
          : { sw: "mvua imepatikana kidogo", en: "some rain has fallen" }
      : null;

  // Neighbor migration hint. Only surface when the delta is
  // meaningful AND we have a name — no point saying "consider
  // moving somewhere" without pointing.
  const neighborLine =
    ctx.neighborWardName &&
    ctx.neighborNdviDelta != null &&
    ctx.neighborNdviDelta >= 0.05
      ? {
          sw: `${ctx.neighborWardName} jirani ina majani zaidi kidogo — fikiria kuhamia huko`,
          en: `${ctx.neighborWardName} nearby has slightly more pasture — consider moving that way`,
        }
      : null;

  // Water point line — prefer working over broken. When only broken
  // is known within 30km, invite the herder to update us if it's
  // been fixed. When no working point exists at all, say so plainly.
  const waterLine = buildWaterLine(ctx, lang);

  // Peer signal — turn "isolated" into "part of a community".
  // Requires at least 2 other callers in the window to feel real;
  // one lonely report reads like the caller's own echo.
  const peerLine =
    ctx.peerCallerCount != null && ctx.peerCallerCount >= 2
      ? {
          sw: `Wachungaji ${ctx.peerCallerCount} karibu nawe wameripoti wiki hii`,
          en: `${ctx.peerCallerCount} herders near you also reported this week`,
        }
      : null;

  // Personal echo — the herder's own last report, so they know we
  // remember. First name only, natural phrasing.
  const lastBcsLine =
    ctx.lastBcsScore != null
      ? {
          sw: `Ripoti yako ya mwisho: mifugo yako BCS ${ctx.lastBcsScore.toFixed(1)}`,
          en: `Your last report: BCS ${ctx.lastBcsScore.toFixed(1)}`,
        }
      : null;

  if (lang === "sw") {
    const parts: string[] = [];
    parts.push(
      `Habari ${namePart}ArdaLink hapa` +
        (ctx.wardName ? ` (${ctx.wardName})` : "") +
        ".",
    );
    if (severity) parts.push(swSeverityLine(severity, rainLine?.sw ?? null));
    else if (rainLine) parts.push(rainLine.sw + ".");
    if (neighborLine) parts.push(neighborLine.sw + ".");
    if (waterLine) parts.push(waterLine + ".");
    if (peerLine) parts.push(peerLine.sw + ".");
    if (lastBcsLine) parts.push(lastBcsLine.sw + ".");
    return parts.join(" ").slice(0, 300);
  }

  const parts: string[] = [];
  parts.push(
    `Hello ${namePart}ArdaLink here` +
      (ctx.wardName ? ` (${ctx.wardName})` : "") +
      ".",
  );
  if (severity) parts.push(enSeverityLine(severity, rainLine?.en ?? null));
  else if (rainLine) parts.push(rainLine.en + ".");
  if (neighborLine) parts.push(neighborLine.en + ".");
  if (waterLine) parts.push(waterLine + ".");
  if (peerLine) parts.push(peerLine.en + ".");
  if (lastBcsLine) parts.push(lastBcsLine.en + ".");
  return parts.join(" ").slice(0, 300);
}

// ── Brief helpers — herder-natural phrasing, no jargon ────────────────

type Severity = "severe" | "stressed" | "moderate" | "fair";

function severityFromCtx(ctx: HerderContext): Severity | null {
  // Prefer VCI-based severity when we have >=5 years of baseline.
  if (
    ctx.vciDerived != null &&
    ctx.baselineYears != null &&
    ctx.baselineYears >= 5
  ) {
    if (ctx.vciDerived <= 25) return "severe";
    if (ctx.vciDerived <= 50) return "stressed";
    if (ctx.vciDerived <= 75) return "moderate";
    return "fair";
  }
  // Fallback to stressed-pixel-pct when no baseline.
  if (ctx.wardStressedPct != null) {
    if (ctx.wardStressedPct >= 70) return "severe";
    if (ctx.wardStressedPct >= 40) return "stressed";
    if (ctx.wardStressedPct >= 20) return "moderate";
    return "fair";
  }
  return null;
}

function swSeverityLine(severity: Severity, rainTail: string | null): string {
  const rainSuffix = rainTail ? `, ${rainTail}` : "";
  const map: Record<Severity, string> = {
    severe: `Malisho ya ward yako ni mabaya sana mwezi huu${rainSuffix}`,
    stressed: `Malisho ya ward yako ni kidogo chini ya wastani${rainSuffix}`,
    moderate: `Malisho ya ward yako ni ya wastani${rainSuffix}`,
    fair: `Malisho ya ward yako bado ni ya kadri${rainSuffix}`,
  };
  return map[severity] + ".";
}

function enSeverityLine(severity: Severity, rainTail: string | null): string {
  const rainSuffix = rainTail ? `, ${rainTail}` : "";
  const map: Record<Severity, string> = {
    severe: `Pasture is very poor this month${rainSuffix}`,
    stressed: `Pasture is a bit below average${rainSuffix}`,
    moderate: `Pasture is around average${rainSuffix}`,
    fair: `Pasture is holding for now${rainSuffix}`,
  };
  return map[severity] + ".";
}

function buildWaterLine(ctx: HerderContext, lang: "sw" | "en"): string | null {
  if (!ctx.nearestWaterPointName) return null;
  const km = ctx.nearestWaterPointDistanceKm;
  const wardOfPoint = ctx.nearestWaterPointName.split(" ")[0] ?? ctx.nearestWaterPointName;

  if (ctx.nearestWaterPointStatus === "working") {
    if (lang === "sw") {
      return `Bwawa la ${wardOfPoint} lilikuwa likifanya kazi (${km ?? "?"}km)`;
    }
    return `${wardOfPoint} borehole was reported working (${km ?? "?"}km)`;
  }
  if (ctx.nearestWaterPointStatus === "broken") {
    if (lang === "sw") {
      return `Bwawa la karibu (${wardOfPoint}) ilikuwa mbovu — tuambie kama sasa iko sawa`;
    }
    return `The nearest borehole (${wardOfPoint}) was broken — tell us if it works now`;
  }
  return null;
}

/**
 * Very short spoken opener for the deterministic voice pipeline. Kept
 * under ~35 words so the TTS clip is 8–10 seconds and the herder isn't
 * paying for airtime on a monologue.
 */
export function buildLocalizedVoiceOpener(ctx: HerderContext): string {
  const nameBit = ctx.name ? `, ${ctx.name}` : "";
  const locBit = ctx.location
    ? ` in ${ctx.location}`
    : ctx.wardName
      ? ` in ${ctx.wardName}`
      : "";
  // Prefer the real-anomaly line when we have a Supabase baseline —
  // "VCI 12, driest June since 2017" beats "97 percent stressed"
  // because it's grounded in actual history the herder can weigh
  // against their memory of past droughts. Falls back cleanly when
  // there's no baseline yet.
  let stressedBit: string;
  if (ctx.vciDerived != null && ctx.baselineYears != null && ctx.baselineYears >= 5) {
    const vci = Math.round(ctx.vciDerived);
    const monthName = ctx.wardMonth ? ctx.wardMonth.split(" ")[0] : "this month";
    const worseLine =
      ctx.worseThanYears != null && ctx.baselineYears != null
        ? ` — worse than ${ctx.worseThanYears} of the last ${ctx.baselineYears} ${monthName}s`
        : "";
    const sinceLine =
      ctx.driestYearOnRecord != null && ctx.vciDerived <= 20
        ? `, driest since ${ctx.driestYearOnRecord}`
        : "";
    stressedBit = `Vegetation condition is ${vci} out of one hundred${worseLine}${sinceLine}`;
  } else if (ctx.wardStressedPct != null) {
    stressedBit = `About ${ctx.wardStressedPct.toFixed(0)} percent of grazing land is stressed`;
  } else if (ctx.wardNdviMean != null) {
    stressedBit = `Your ward NDVI is ${ctx.wardNdviMean.toFixed(2)}`;
  } else {
    stressedBit = "We have your ward's latest satellite reading";
  }
  const riskBit = ctx.wardRiskLevel ? `, drought risk ${ctx.wardRiskLevel}` : "";
  const memoryBit = ctx.lastBcsScore != null
    ? ` We saw your last report of body condition ${ctx.lastBcsScore.toFixed(1)}.`
    : "";
  const neighborBit =
    ctx.neighborWardName && ctx.neighborNdviMean != null
      ? ` In your neighbor ${ctx.neighborWardName}, pasture is stronger — consider moving that way.`
      : "";
  // Water-point reference is only helpful when we can tell the herder
  // something they can act on: skip when the nearest is >30 km away
  // (probably not the point they use) or when status is unknown.
  const waterBit =
    ctx.nearestWaterPointName &&
    ctx.nearestWaterPointDistanceKm != null &&
    ctx.nearestWaterPointDistanceKm < 30 &&
    ctx.nearestWaterPointStatus !== "unknown"
      ? ctx.nearestWaterPointStatus === "working"
        ? ` Your nearest known water point is ${ctx.nearestWaterPointName}, about ${ctx.nearestWaterPointDistanceKm} km away, last recorded working.`
        : ` The nearest WPDx-recorded water point ${ctx.nearestWaterPointName} was last surveyed broken — please confirm.`
      : "";
  return (
    `Habari${nameBit}. This is ArdaLink${locBit}. ${stressedBit}${riskBit}.${memoryBit}${neighborBit}${waterBit} ` +
    `We would like your report today.`
  );
}
