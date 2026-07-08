/**
 * Tenant slug ↔ Supabase ward_id mapping.
 *
 * Since 2026-07-08 every tenant slug maps 1:1 to a real ward_id in
 * Supabase's `active_wards`. Isiolo Sub-County has 5 finished wards
 * (241 Wabera, 242 Bulla Pesa, 245 Ngare Mara, 246 Burat, 247
 * Oldonyiro) — each is a valid tenant slug in `docs/local-dev/seed-data`.
 * The retired demo tenants `garbatulla` and `merti` were dropped
 * because they don't correspond to Supabase wards; use `ngare-mara`
 * and `burat` instead.
 *
 * This module is the single place that knows the mapping so
 * herderContext, deterministic pipeline, USSD, SMS and voice all agree.
 */

const TENANT_TO_WARD_ID: Record<string, string> = {
  "wabera": "241",
  "bula-pesa": "242",
  "bulla-pesa": "242", // legacy alias with double-L
  "ngare-mara": "245",
  "burat": "246",
  "oldonyiro": "247",
};

const WARD_ID_TO_TENANT: Record<string, string> = {
  "241": "wabera",
  "242": "bula-pesa",
  "245": "ngare-mara",
  "246": "burat",
  "247": "oldonyiro",
};

export const DEFAULT_WARD_ID = "242";

export function wardIdForTenant(tenantSlug: string): string {
  const slug = tenantSlug.toLowerCase().trim();
  return TENANT_TO_WARD_ID[slug] ?? DEFAULT_WARD_ID;
}

export function tenantForWardId(wardId: string): string {
  return WARD_ID_TO_TENANT[wardId] ?? "bula-pesa";
}

/**
 * List all known ward IDs on the Supabase side. Handy for enumerating
 * possible tenants without doing a live Supabase call.
 */
export function knownWardIds(): string[] {
  return Object.keys(WARD_ID_TO_TENANT);
}
