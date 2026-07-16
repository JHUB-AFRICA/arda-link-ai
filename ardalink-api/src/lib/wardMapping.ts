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
 * **Ward 244 Cherab is intentionally excluded.** Supabase's
 * `dormant_wards` view lists 244 Cherab as a real Isiolo ward with
 * populated geometry + satellite_cell_indices, but the pilot cohort
 * is scoped to the 5 wards above (confirmed by the product owner,
 * 2026-07-15). If Cherab is later brought into the pilot, add it
 * both here AND to Supabase's `active_wards` view definition — the
 * two must stay in sync or the dashboard map + herder briefs will
 * drift.
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

/**
 * Free-text location → ward_id.
 *
 * Herders name places in USSD ("uko wapi?" — "Kambi Garba" / "Ngare Mara" /
 * "burat...") that don't cleanly match a ward_id. This alias table maps
 * every place name we've seen in seeded pastoralists + the deterministic
 * pipeline's transcripts back to the parent ward, so we can attach a
 * ward_id even when the phone isn't in `pastoralists` yet.
 *
 * Modelled on the fork's `liveWardContext.ts::LOCATION_TO_WARD`.
 * Returns `null` when nothing matches, so callers can decide whether to
 * fall back to a tenant-derived default or ask a clarifying question.
 */
const LOCATION_ALIASES: Array<{ aliases: string[]; wardId: string }> = [
  {
    aliases: ["wabera"],
    wardId: "241",
  },
  {
    aliases: [
      "bula pesa",
      "bulla pesa",
      "bula-pesa",
      "bulla-pesa",
      "kula pesa",
      "gotu",
    ],
    wardId: "242",
  },
  {
    aliases: [
      "ngare mara",
      "ngaremara",
      "ngare-mara",
      "kambi garba",
      "kambi-garba",
    ],
    wardId: "245",
  },
  {
    aliases: ["burat"],
    wardId: "246",
  },
  {
    aliases: ["oldonyiro", "oldony iro", "oldonyro"],
    wardId: "247",
  },
];

export function wardIdFromLocationText(
  raw: string | null | undefined,
): string | null {
  if (!raw) return null;
  const needle = raw.toLowerCase();
  for (const entry of LOCATION_ALIASES) {
    if (entry.aliases.some((alias) => needle.includes(alias))) {
      return entry.wardId;
    }
  }
  return null;
}
