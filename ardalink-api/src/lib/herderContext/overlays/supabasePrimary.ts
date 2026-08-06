/**
 * Merges of Supabase-primary reads onto a base HerderContext:
 * the joined `api_call_context` view, a raw `pastoralists` row, a
 * `pastoralist_leads` identity, and the ward-level satellite/weather
 * fallback overlay when the joined view didn't already populate them.
 */

import {
  isSupabaseConfigured,
  latestSatelliteFor,
  latestWeatherFor,
  pastoralistByPhone,
  leadByPhone,
  type SbCallContext,
  type SbPastoralist,
  type SbPhoneIdentity,
} from "../../supabase/index.js";
import { DEFAULT_WARD_ID } from "../../wardMapping.js";
import type { HerderContext } from "../types.js";

/**
 * Overlay Supabase's `api_call_context` row on a base context. This
 * view already joins pastoralist + ward + latest satellite + latest
 * weather — one round-trip and the ward-level fields are populated
 * from live Supabase data, not an in-process intelligence cycle.
 */
export function mergeSupabaseCallContext(
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

export function mergeSupabasePastoralist(
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

/**
 * Overlay lead identity onto a base ctx when the phone matches a row
 * in pastoralist_leads (via api_phone_identity view). Marks tier='lead'
 * so downstream policy can gate outbound dispatches + analytics writes.
 */
export function mergeLeadIdentity(
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

/**
 * Overlay the herder's own permanently-stored location (migration
 * 0011/0012, 2026-08-06) onto ctx. A direct table read, deliberately NOT
 * via api_call_context or api_phone_identity — both are Supabase-side
 * views that predate the lat/lon columns and may not expose them at all
 * (confirmed elsewhere this session: views/constraints defined before a
 * column existed routinely don't pick it up without being redefined,
 * which nothing in this repo's migration history can do for a
 * Supabase-native view). One extra round-trip, matching every other
 * overlay in this chain.
 */
export async function overlayStoredLocation(
  ctx: HerderContext,
): Promise<HerderContext> {
  if (!isSupabaseConfigured() || !ctx.canonicalPhone) return ctx;
  if (ctx.tier === "verified") {
    const p = await pastoralistByPhone(ctx.canonicalPhone);
    if (p?.lat != null && p?.lon != null) {
      return {
        ...ctx,
        lastKnownLat: p.lat,
        lastKnownLon: p.lon,
        lastKnownLocationSource: p.location_source,
      };
    }
  } else if (ctx.tier === "lead") {
    const lead = await leadByPhone(ctx.canonicalPhone);
    if (lead?.lat != null && lead?.lon != null) {
      return {
        ...ctx,
        lastKnownLat: lead.lat,
        lastKnownLon: lead.lon,
        lastKnownLocationSource: lead.location_source,
      };
    }
  }
  return ctx;
}

export async function overlayWardReference(
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
