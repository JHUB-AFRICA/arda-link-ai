/**
 * Verified `pastoralists` reads/writes. Distinct from
 * `pastoralistLeads.ts` — leads self-enroll and live in a separate
 * table; pastoralists are ops-added only. See feedback memory
 * "Pastoralist two-tier writes" for the policy.
 */

import { logger } from "../logger.js";
import { isSupabaseConfigured, sbFetch, sbGet, type SupabaseMode } from "./client.js";

export interface SbPastoralist {
  pastoralist_id: string;
  full_name: string | null;
  phone_number: string | null;
  preferred_language: string | null;
  cbo_referral: string | null;
  herd_size: number | null;
  ward_id: string | null;
  location_text: string | null;
  created_at: string;
  updated_at: string;
}

export interface SbCallContext {
  pastoralist_id: string;
  full_name: string | null;
  phone_number: string | null;
  preferred_language: string | null;
  ward_id: string | null;
  ward_name: string | null;
  ndvi_mean: number | null;
  ndre_mean: number | null;
  vci_value: number | null;
  prosopis_share: number | null;
  rainfall_mm_30d: number | null;
  humidity_pct: number | null;
  temperature_c: number | null;
  evapotranspiration_mm: number | null;
  weather_observed_date: string | null;
  satellite_period_end: string | null;
}

/**
 * Pastoralist lookup by canonical phone. NOT cached — profile edits
 * should be visible instantly, and the volume is small.
 */
export const pastoralistByPhone = async (
  phone: string,
  mode: SupabaseMode = "interactive",
): Promise<SbPastoralist | null> => {
  const rows = await sbGet<SbPastoralist>(
    `pastoralists?phone_number=eq.${encodeURIComponent(phone)}&select=*&limit=1`,
    { mode },
  );
  return rows?.[0] ?? null;
};

/**
 * Every verified pastoralist, ward_id + herd_size only — for ward-level
 * aggregation (the dashboard choropleth's "herd" metric). Real registered
 * herders only; self-enrolled leads live in a separate table
 * (pastoralistLeads.ts) and aren't counted here. Batch mode — this feeds
 * a dashboard aggregate, not a herder-facing reply.
 */
export const listAllPastoralists = async (
  mode: SupabaseMode = "batch",
): Promise<Array<{ ward_id: string | null; herd_size: number | null }> | null> => {
  return sbGet<{ ward_id: string | null; herd_size: number | null }>(
    `pastoralists?select=ward_id,herd_size`,
    { mode },
  );
};

/**
 * The full call-context view — Supabase joins pastoralist + ward +
 * latest satellite + latest weather in a single row for us. Returns
 * `null` if no pastoralist matches the phone.
 */
export const callContextByPhone = async (
  phone: string,
  mode: SupabaseMode = "interactive",
): Promise<SbCallContext | null> => {
  const rows = await sbGet<SbCallContext>(
    `api_call_context?phone_number=eq.${encodeURIComponent(phone)}&select=*&limit=1`,
    { mode },
  );
  return rows?.[0] ?? null;
};

/** Insert or upsert a pastoralist. Used when a call comes in from an
 * unknown phone — we create the profile in Supabase so future calls
 * have the context. Uses `Prefer: resolution=merge-duplicates` so a
 * repeat call harmlessly no-ops. */
export const upsertPastoralist = async (
  row: Partial<SbPastoralist> & { phone_number: string },
  mode: SupabaseMode = "batch",
): Promise<SbPastoralist | null> => {
  try {
    const res = await sbFetch("pastoralists", {
      method: "POST",
      body: JSON.stringify(row),
      headers: {
        Prefer: "return=representation,resolution=merge-duplicates",
      },
      sbMode: mode,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logger.warn(
        { status: res.status, body: body.slice(0, 300) },
        "[Supabase] pastoralist upsert non-2xx",
      );
      return null;
    }
    const rows = (await res.json()) as SbPastoralist[];
    return rows[0] ?? null;
  } catch (err) {
    logger.warn({ err }, "[Supabase] pastoralist upsert crashed");
    return null;
  }
};

/**
 * Flip `alerts_enabled=false` on a pastoralist's row. Relocated here
 * from routes/smsOptOut.ts (where it originated) so both the SMS
 * opt-out callback and the WhatsApp STOP/SITAKI keyword branch share
 * one implementation instead of duplicating the PATCH. No SMS-specific
 * logic — a direct write to `pastoralists`, same shape as
 * `upsertPastoralist` above.
 */
export const markPastoralistOptedOut = async (phone: string): Promise<boolean> => {
  if (!isSupabaseConfigured()) return false;
  const url = `${(process.env.SUPABASE_URL ?? "").replace(/\/$/, "")}/rest/v1/pastoralists?phone_number=eq.${encodeURIComponent(phone)}`;
  const key = (process.env.SUPABASE_SECRET_KEY ?? "").trim();
  try {
    const res = await fetch(url, {
      method: "PATCH",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({ alerts_enabled: false }),
      signal: AbortSignal.timeout(5_000),
    });
    return res.ok;
  } catch (err) {
    logger.warn({ err: String(err), phone }, "[Supabase] pastoralists opt-out PATCH failed");
    return false;
  }
};
