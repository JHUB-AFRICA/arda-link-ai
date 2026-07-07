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
  type SbCallContext,
  type SbPastoralist,
} from "./supabase.js";
import { wardIdForTenant, tenantForWardId, DEFAULT_WARD_ID } from "./wardMapping.js";

const DEFAULT_TENANT_ID =
  process.env.DETERMINISTIC_TENANT_ID ?? "bula-pesa";

export interface HerderContext {
  /** True if we matched a pastoralist row on either Supabase or local. */
  known: boolean;
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
      if (p) ctx = mergeSupabasePastoralist(ctx, p);
    }

    // If Supabase resolved the herder, backfill the local-only detail
    // (species breakdown, last extraction, water_source).
    if (ctx.source === "supabase") {
      ctx = await enrichFromLocalMirror(ctx, tenantId);
      ctx = await overlayWardReference(ctx);
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
  return ctx;
}

/**
 * Build a short bilingual (Swahili/English) herder-specific brief string,
 * suitable for TTS or SMS. If the herder is known we use their name and
 * location; otherwise we fall back to ward-level info. Bounded to ~300
 * characters so it fits in a USSD screen or single-segment SMS budget.
 */
export function buildLocalizedBrief(ctx: HerderContext, lang: "sw" | "en"): string {
  const namePart = ctx.name ? `${ctx.name}, ` : "";
  const locPart = ctx.location
    ? ` (${ctx.location})`
    : ctx.wardName
      ? ` (${ctx.wardName})`
      : "";
  const stressed = ctx.wardStressedPct != null
    ? `${ctx.wardStressedPct.toFixed(0)}%`
    : null;
  const ndviBit = ctx.wardNdviMean != null
    ? `NDVI ${ctx.wardNdviMean.toFixed(2)}`
    : null;
  const rainBit = ctx.wardRainfall30dMm != null
    ? `${ctx.wardRainfall30dMm.toFixed(0)}mm mvua`
    : null;
  const risk = ctx.wardRiskLevel ?? null;
  const rec = ctx.wardRecommendation ?? null;
  const lastBcs = ctx.lastBcsScore != null
    ? `BCS ${ctx.lastBcsScore.toFixed(1)}`
    : null;

  if (lang === "sw") {
    const parts: string[] = [];
    parts.push(`Habari ${namePart}kutoka ArdaLink${locPart}.`);
    if (ndviBit) parts.push(`${ndviBit} kwenye ward yako.`);
    else if (stressed) parts.push(`Malisho ya ward: ${stressed} yameathirika.`);
    if (rainBit) parts.push(`Mvua ya siku 30: ${rainBit}.`);
    if (risk) parts.push(`Hatari ya ukame: ${risk}.`);
    if (lastBcs) parts.push(`Ripoti yako ya mwisho: ${lastBcs}.`);
    if (rec) parts.push(`Ushauri: ${rec}`);
    return parts.join(" ").slice(0, 300);
  }

  const parts: string[] = [];
  parts.push(`Hello ${namePart}from ArdaLink${locPart}.`);
  if (ndviBit) parts.push(`${ndviBit} across your ward.`);
  else if (stressed) parts.push(`Ward pasture: ${stressed} is stressed.`);
  if (rainBit) parts.push(`30-day rain: ${rainBit}.`);
  if (risk) parts.push(`Drought risk: ${risk}.`);
  if (lastBcs) parts.push(`Your last report: ${lastBcs}.`);
  if (rec) parts.push(`Advice: ${rec}`);
  return parts.join(" ").slice(0, 300);
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
  const stressedBit = ctx.wardStressedPct != null
    ? `About ${ctx.wardStressedPct.toFixed(0)} percent of grazing land is stressed`
    : ctx.wardNdviMean != null
      ? `Your ward NDVI is ${ctx.wardNdviMean.toFixed(2)}`
      : "We have your ward's latest satellite reading";
  const riskBit = ctx.wardRiskLevel ? `, drought risk ${ctx.wardRiskLevel}` : "";
  const memoryBit = ctx.lastBcsScore != null
    ? ` We saw your last report of body condition ${ctx.lastBcsScore.toFixed(1)}.`
    : "";
  return (
    `Habari${nameBit}. This is ArdaLink${locBit}. ${stressedBit}${riskBit}.${memoryBit} ` +
    `We would like your report today.`
  );
}
