/**
 * pastoralist_location_history — the permanent, append-only record of
 * every location change ever made for a herder (see migration 0011's
 * header for the real incident driving this). Never updated or deleted.
 *
 * This module also owns `setCurrentLocation()`, the single entry point
 * for updating a herder's "current" location pointer (the `lat`/`lon`/
 * `location_source`/`location_updated_at` columns on `pastoralists` or
 * `pastoralist_leads` — see migration 0012's header for why those are
 * plain columns, not the existing-but-unused `location` PostGIS column).
 * Every caller that changes a herder's location should go through this
 * function rather than calling `upsertPastoralist`/`upsertPastoralistLead`
 * directly with location fields, so the history row and the current
 * pointer never drift out of sync.
 */

import { logger } from "../logger.js";
import { mirrorPastoralistLocationHistory } from "../localMirror.js";
import { sbInsert, sbGet, type SupabaseMode } from "./client.js";
import { identityForPhone } from "./pastoralistLeads.js";
import { upsertPastoralistLead } from "./pastoralistLeads.js";
import { upsertPastoralist, pastoralistByPhone } from "./pastoralists.js";

export type LocationSource =
  | "ussd_registration"
  | "whatsapp_registration"
  | "sms_self"
  | "whatsapp_explicit_statement"
  | "ops_verification"
  | "ops_manual_edit";

export interface SbLocationHistoryRow {
  id: number;
  entity_type: "lead" | "pastoralist";
  entity_id: string;
  phone_number: string;
  ward_id: string | null;
  location_text: string | null;
  lat: number | null;
  lon: number | null;
  source: LocationSource;
  confidence: "high" | "medium" | "low" | null;
  previous_ward_id: string | null;
  previous_location_text: string | null;
  previous_lat: number | null;
  previous_lon: number | null;
  raw_message_text: string | null;
  changed_by: string | null;
  recorded_at: string;
}

export interface RecordLocationChangeInput {
  entityType: "lead" | "pastoralist";
  entityId: string;
  phoneNumber: string;
  wardId: string | null;
  locationText: string | null;
  lat: number | null;
  lon: number | null;
  source: LocationSource;
  confidence?: "high" | "medium" | "low";
  rawMessageText?: string | null;
  changedBy?: string | null;
  previous?: {
    wardId: string | null;
    locationText: string | null;
    lat: number | null;
    lon: number | null;
  };
}

/**
 * Append one row to the permanent location-change log. Fire-and-forget
 * from the caller's perspective — never throws, same calling convention
 * as `insertGroundTruthCall`/`logWhatsappMessage` elsewhere in this
 * directory. Dual-writes to the local Postgres mirror too (best-effort),
 * same pattern as every other Supabase-primary append-only table here.
 */
export async function recordLocationChange(
  input: RecordLocationChangeInput,
  mode: SupabaseMode = "batch",
): Promise<void> {
  const payload = {
    entity_type: input.entityType,
    entity_id: input.entityId,
    phone_number: input.phoneNumber,
    ward_id: input.wardId,
    location_text: input.locationText,
    lat: input.lat,
    lon: input.lon,
    source: input.source,
    confidence: input.confidence ?? null,
    previous_ward_id: input.previous?.wardId ?? null,
    previous_location_text: input.previous?.locationText ?? null,
    previous_lat: input.previous?.lat ?? null,
    previous_lon: input.previous?.lon ?? null,
    raw_message_text: input.rawMessageText ?? null,
    changed_by: input.changedBy ?? null,
  };
  await sbInsert<SbLocationHistoryRow>(
    "pastoralist_location_history",
    payload,
    { mode },
  );
  await mirrorPastoralistLocationHistory({
    entityType: input.entityType,
    entityId: input.entityId,
    phoneNumber: input.phoneNumber,
    wardId: input.wardId,
    locationText: input.locationText,
    lat: input.lat,
    lon: input.lon,
    source: input.source,
    confidence: input.confidence ?? null,
    previousWardId: input.previous?.wardId ?? null,
    previousLocationText: input.previous?.locationText ?? null,
    previousLat: input.previous?.lat ?? null,
    previousLon: input.previous?.lon ?? null,
    rawMessageText: input.rawMessageText ?? null,
    changedBy: input.changedBy ?? null,
  });
}

/** Full location history for a phone, newest first. `phone_number` is
 * the stable join key across a lead's promotion to verified pastoralist
 * (their entity_id/UUID changes at that point; phone doesn't). */
export async function listLocationHistory(
  phoneNumber: string,
  opts: { limit?: number; mode?: SupabaseMode } = {},
): Promise<SbLocationHistoryRow[] | null> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  return sbGet<SbLocationHistoryRow>(
    `pastoralist_location_history?phone_number=eq.${encodeURIComponent(phoneNumber)}` +
      `&order=recorded_at.desc&limit=${limit}`,
    { mode: opts.mode ?? "batch" },
  );
}

export interface SetCurrentLocationInput {
  phoneNumber: string;
  wardId: string;
  locationText: string;
  lat?: number | null;
  lon?: number | null;
  source: LocationSource;
  confidence?: "high" | "medium" | "low";
  rawMessageText?: string | null;
  changedBy?: string | null;
}

/**
 * The single entry point for changing a herder's current location.
 * Resolves whether the phone is a lead or a verified pastoralist,
 * captures the previous values for the history row, writes the new
 * "current" pointer via the existing upsert functions, then appends to
 * pastoralist_location_history. Best-effort throughout — never throws,
 * never blocks a herder-facing reply.
 */
export async function setCurrentLocation(
  input: SetCurrentLocationInput,
): Promise<void> {
  try {
    const identity = await identityForPhone(input.phoneNumber);
    const nowIso = new Date().toISOString();

    if (identity?.tier === "verified") {
      const before = await pastoralistByPhone(input.phoneNumber);
      await upsertPastoralist({
        phone_number: input.phoneNumber,
        ward_id: input.wardId,
        location_text: input.locationText,
        lat: input.lat ?? null,
        lon: input.lon ?? null,
        location_source: input.source,
        location_updated_at: nowIso,
      });
      await recordLocationChange({
        entityType: "pastoralist",
        entityId: identity.identity_id,
        phoneNumber: input.phoneNumber,
        wardId: input.wardId,
        locationText: input.locationText,
        lat: input.lat ?? null,
        lon: input.lon ?? null,
        source: input.source,
        confidence: input.confidence,
        rawMessageText: input.rawMessageText,
        changedBy: input.changedBy,
        previous: before
          ? {
              wardId: before.ward_id,
              locationText: before.location_text,
              lat: before.lat,
              lon: before.lon,
            }
          : undefined,
      });
      return;
    }

    // Default to lead — either an existing lead row, or a brand-new
    // one (upsertPastoralistLead creates it if it doesn't exist yet).
    const before =
      identity?.tier === "lead"
        ? await pastoralistLeadByIdentity(input.phoneNumber)
        : null;
    const after = await upsertPastoralistLead({
      phone_number: input.phoneNumber,
      ward_id: input.wardId,
      location_text: input.locationText,
      lat: input.lat ?? null,
      lon: input.lon ?? null,
      location_source: input.source,
      location_updated_at: nowIso,
    });
    if (!after) return;
    await recordLocationChange({
      entityType: "lead",
      entityId: after.lead_id,
      phoneNumber: input.phoneNumber,
      wardId: input.wardId,
      locationText: input.locationText,
      lat: input.lat ?? null,
      lon: input.lon ?? null,
      source: input.source,
      confidence: input.confidence,
      rawMessageText: input.rawMessageText,
      changedBy: input.changedBy,
      previous: before
        ? {
            wardId: before.ward_id,
            locationText: before.location_text,
            lat: before.lat,
            lon: before.lon,
          }
        : undefined,
    });
  } catch (err) {
    logger.warn(
      { err: String(err), phone: input.phoneNumber },
      "[LocationHistory] setCurrentLocation failed",
    );
  }
}

/** Small helper: fetch the current lead row by phone, for capturing
 * `previous*` values before an update. Not exported — internal to
 * setCurrentLocation's before/after diffing. */
async function pastoralistLeadByIdentity(phoneNumber: string) {
  const rows = await sbGet<{
    ward_id: string | null;
    location_text: string | null;
    lat: number | null;
    lon: number | null;
  }>(
    `pastoralist_leads?phone_number=eq.${encodeURIComponent(phoneNumber)}&select=ward_id,location_text,lat,lon&limit=1`,
    { mode: "batch" },
  );
  return rows?.[0] ?? null;
}
