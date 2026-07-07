/**
 * Tenant slug ↔ Supabase ward_id mapping.
 *
 * Supabase is the source of truth: it holds the 5 "active" wards of
 * Isiolo Sub-County as text ward_ids (241 Wabera, 242 Bulla Pesa,
 * 245 Ngare Mara, 246 Burat, 247 Oldonyiro). Our tenant model uses
 * lowercase slugs (bula-pesa, garbatulla, merti). Only Bulla Pesa
 * exists in both; garbatulla and merti fall back to Bulla Pesa (242)
 * as the default demo ward until their real coverage is clarified with
 * the Supabase owner.
 *
 * This module is the single place that knows the mapping so
 * herderContext, deterministic pipeline, USSD, SMS and voice all agree.
 */

const TENANT_TO_WARD_ID: Record<string, string> = {
  "bula-pesa": "242",
  "bulla-pesa": "242", // some seed rows use the spelling with double-L
  "garbatulla": "242", // TODO: confirm with Supabase owner
  "merti": "242", // TODO: confirm with Supabase owner
  "wabera": "241",
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
