/**
 * Pastoralist leads (self-enrolled via USSD/SMS/inbound-call) — a
 * distinct table from `pastoralists.ts`'s verified profiles. Leads
 * never enter analytics or drill batches until ops promotes them via
 * the leads panel. See feedback memory "Pastoralist two-tier writes".
 */

import { logger } from "../logger.js";
import { mirrorPastoralistLead } from "../localMirror.js";
import { sbFetch, sbGet, type SupabaseMode } from "./client.js";

/**
 * A self-subscribed pastoralist. Distinct from `pastoralists` — leads
 * live in a separate table and never enter analytics or drill batches
 * until ops promotes them via the leads panel. See feedback memory
 * "Pastoralist two-tier writes" for the policy.
 */
export interface SbPastoralistLead {
  lead_id: string;
  phone_number: string;
  full_name: string | null;
  preferred_language: "sw" | "en" | null;
  ward_id: string | null;
  location_text: string | null;
  herd_size: number | null;
  enrollment_source:
    | "ussd_self"
    | "sms_self"
    | "inbound_call"
    | "field_agent";
  status:
    | "lead"
    | "contacted"
    | "verified"
    | "declined"
    | "opted_out";
  alerts_enabled: boolean;
  first_contact_at: string;
  last_contact_at: string;
  verified_at: string | null;
  verified_by: string | null;
  promoted_pastoralist_id: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * A row from the `api_phone_identity` view — a union of verified
 * pastoralists + non-declined leads, tagged with a `tier` column so
 * downstream callers can gate behaviour. Never returns a phone that
 * appears in both tables (the view suppresses the lead row when a
 * verified pastoralist exists for the same phone).
 */
export interface SbPhoneIdentity {
  tier: "verified" | "lead";
  phone_number: string;
  identity_id: string;
  full_name: string | null;
  preferred_language: string | null;
  ward_id: string | null;
  location_text: string | null;
}

/**
 * Lookup any phone in the identity view. Interactive mode (2.5 s
 * timeout) so USSD/voice paths stay inside the AT budget. Returns
 * null for an unknown phone.
 */
export const identityForPhone = async (
  phone: string,
  mode: SupabaseMode = "interactive",
): Promise<SbPhoneIdentity | null> => {
  const rows = await sbGet<SbPhoneIdentity>(
    `api_phone_identity?phone_number=eq.${encodeURIComponent(phone)}&limit=1`,
    { mode },
  );
  return rows?.[0] ?? null;
};

/**
 * Insert or update a lead. Uses PostgREST's on-conflict merge on
 * `phone_number` so the second USSD subscribe from the same number
 * updates last_contact_at + any fields the caller supplied, rather
 * than 409-ing. Never writes to `pastoralists` — that's ops-only.
 *
 * Returns the resulting row (freshly inserted OR updated) so the
 * caller can pipe it back into HerderContext for the closing SMS.
 */
export const upsertPastoralistLead = async (
  row: Partial<SbPastoralistLead> & { phone_number: string },
  mode: SupabaseMode = "batch",
): Promise<SbPastoralistLead | null> => {
  const payload: Record<string, unknown> = {
    phone_number: row.phone_number,
    last_contact_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  // Only include fields the caller supplied — undefined would otherwise
  // wipe existing values on the merge.
  if (row.full_name != null) payload.full_name = row.full_name;
  if (row.preferred_language != null)
    payload.preferred_language = row.preferred_language;
  if (row.ward_id != null) payload.ward_id = row.ward_id;
  if (row.location_text != null) payload.location_text = row.location_text;
  if (row.herd_size != null) payload.herd_size = row.herd_size;
  if (row.enrollment_source != null)
    payload.enrollment_source = row.enrollment_source;
  if (row.status != null) payload.status = row.status;
  if (row.alerts_enabled != null) payload.alerts_enabled = row.alerts_enabled;
  if (row.notes != null) payload.notes = row.notes;

  try {
    const res = await sbFetch(
      "pastoralist_leads?on_conflict=phone_number",
      {
        method: "POST",
        body: JSON.stringify(payload),
        headers: {
          Prefer: "return=representation,resolution=merge-duplicates",
        },
        sbMode: mode,
      },
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logger.warn(
        { status: res.status, body: body.slice(0, 300) },
        "[Supabase] pastoralist_leads upsert non-2xx",
      );
      return null;
    }
    const rows = (await res.json()) as SbPastoralistLead[];
    const primary = rows[0] ?? null;
    // Local mirror. Best-effort; runs even if the Supabase branch
    // above returned null so a Supabase outage doesn't drop the lead.
    await mirrorPastoralistLead({
      phoneNumber: row.phone_number,
      fullName: row.full_name ?? undefined,
      preferredLanguage: row.preferred_language ?? undefined,
      wardId: row.ward_id ?? undefined,
      herdSize: row.herd_size ?? undefined,
      enrollmentSource: row.enrollment_source ?? undefined,
      status: row.status ?? undefined,
      alertsEnabled: row.alerts_enabled ?? undefined,
      notes: row.notes ?? undefined,
    });
    return primary;
  } catch (err) {
    logger.warn({ err }, "[Supabase] pastoralist_leads upsert crashed");
    // Still attempt the local mirror on Supabase-side crash.
    await mirrorPastoralistLead({
      phoneNumber: row.phone_number,
      fullName: row.full_name ?? undefined,
      preferredLanguage: row.preferred_language ?? undefined,
      wardId: row.ward_id ?? undefined,
      herdSize: row.herd_size ?? undefined,
      enrollmentSource: row.enrollment_source ?? undefined,
      status: row.status ?? undefined,
      alertsEnabled: row.alerts_enabled ?? undefined,
      notes: row.notes ?? undefined,
    });
    return null;
  }
};

/**
 * Set a lead's status (declined / opted_out / contacted). Called from
 * ops actions and from the SMS STOP handler.
 */
export const setLeadStatus = async (
  phone: string,
  status: SbPastoralistLead["status"],
  mode: SupabaseMode = "batch",
): Promise<boolean> => {
  try {
    const res = await sbFetch(
      `pastoralist_leads?phone_number=eq.${encodeURIComponent(phone)}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          status,
          updated_at: new Date().toISOString(),
        }),
        headers: { Prefer: "return=minimal" },
        sbMode: mode,
      },
    );
    return res.ok;
  } catch (err) {
    logger.warn({ err, phone, status }, "[Supabase] setLeadStatus crashed");
    return false;
  }
};

/**
 * Recent leads for the ops panel. Sorted by newest last-contact so
 * fresh subscribers surface at the top. Filters out declined /
 * opted_out by default; callers can pass `includeInactive=true`
 * for a full audit view.
 */
export const recentLeads = (
  limit = 50,
  opts: { includeInactive?: boolean; mode?: SupabaseMode } = {},
) => {
  const safeLimit = Math.min(Math.max(limit, 1), 200);
  const statusFilter = opts.includeInactive
    ? ""
    : "&status=in.(lead,contacted,verified)";
  return sbGet<SbPastoralistLead>(
    `pastoralist_leads?select=*${statusFilter}&order=last_contact_at.desc&limit=${safeLimit}`,
    { mode: opts.mode ?? "batch" },
  );
};
