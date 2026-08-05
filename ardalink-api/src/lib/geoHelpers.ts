/**
 * Geospatial helpers for the choropleth + herder / report pins.
 *
 * The seed data stores pastoralist `location` and report
 * `reportedLocation` as free-text place names ("Bulla Pesa", "Kula
 * Pesa", "Garbatulla", "Merti", "Sericho", …) rather than lat/lon
 * coordinates. This module maps those place names to:
 *
 *   1. Real lat/lon (hand-curated against GADM ward centroids +
 *      OpenStreetMap settlements)
 *   2. The GADM ward that the place sits in (so we can bucket
 *      pastoralists and reports by ward for the choropleth).
 *
 * No place name is invented — anything not in this list is
 * bucketed to the ward centre with an "unmapped" flag so the
 * dashboard can render a "?" marker instead of a real position.
 */

import {
  isSupabaseConfigured,
  recentGroundTruthCalls,
  listAllPastoralists,
  latestSatelliteFor,
} from "./supabase/index.js";
import { knownWardIds, wardIdForTenant } from "./wardMapping.js";

export interface ResolvedLocation {
  lat: number;
  lon: number;
  placeName: string;
  ward: string;
  mapped: boolean;
}

/**
 * Place-name → (lat, lon, ward) mapping. Keys are lowercased and
 * matched as substrings of the pastoralist / report `location`
 * string, so "Bulla Pesa borehole" matches the "bulla pesa" entry.
 */
const PLACE_TABLE: Array<{
  keys: string[];
  lat: number;
  lon: number;
  placeName: string;
  ward: string;
}> = [
  // ── Bulla Pesa Ward — Bula Pesa tenant ──────────────────
  { keys: ["bulla pesa", "bula pesa town"], lat: 0.352, lon: 37.5605, placeName: "Bulla Pesa Town", ward: "Bulla Pesa" },
  { keys: ["kula pesa"], lat: 0.345, lon: 37.555, placeName: "Kula Pesa", ward: "Bulla Pesa" },
  { keys: ["gotu"], lat: 0.370, lon: 37.575, placeName: "Gotu Pan", ward: "Bulla Pesa" },
  { keys: ["kambi garba"], lat: 0.305, lon: 37.628, placeName: "Kambi Garba", ward: "Bulla Pesa" },
  // ── Ngare Mara Ward — Ngare Mara tenant ──────────────────
  { keys: ["ngare mara", "ngaremara"], lat: 0.410, lon: 37.615, placeName: "Ngare Mara", ward: "Ngare Mara" },
  // ── Wabera Ward — Wabera tenant ──────────────────────────
  { keys: ["wabera"], lat: 0.400, lon: 37.530, placeName: "Wabera", ward: "Wabera" },
  // ── Burat Ward — Burat tenant ───────────────────────────
  { keys: ["burat"], lat: 0.485, lon: 37.630, placeName: "Burat", ward: "Burat" },
  // ── Oldonyiro Ward — Oldonyiro tenant ────────────────────
  { keys: ["oldonyiro", "oldony iro"], lat: 0.575, lon: 37.190, placeName: "Oldonyiro", ward: "Oldonyiro" },
];

// Centre of Isiolo County (used as the fallback pin location).
const ISIOLO_CENTRE: [number, number] = [0.355, 37.583];

// Demo tenant → "home" ward mapping. Aligned 1:1 with Supabase's
// active_wards since 2026-07-08.
export const TENANT_HOME_WARD: Record<string, string> = {
  "wabera": "Wabera",
  "bula-pesa": "Bulla Pesa",
  "ngare-mara": "Ngare Mara",
  "burat": "Burat",
  "oldonyiro": "Oldonyiro",
};

/**
 * Real Supabase `ward_id` -> the exact display name this dashboard's
 * choropleth keys on (matches GeoJSON `properties.ward` from
 * /api/open-data/geo/isiolo-wards, and PLACE_TABLE's `ward` values
 * above — all three must use identical spelling or the map silently
 * shows no data for a ward with real numbers behind it).
 */
const WARD_ID_TO_NAME: Record<string, string> = {
  "241": "Wabera",
  "242": "Bulla Pesa",
  "245": "Ngare Mara",
  "246": "Burat",
  "247": "Oldonyiro",
};

/**
 * Resolve a free-text place name to (lat, lon, ward). Returns the
 * Isiolo centre + `mapped: false` when nothing matches.
 */
export function resolvePlaceName(
  raw: string | null | undefined,
): ResolvedLocation {
  if (raw) {
    const l = raw.toLowerCase();
    for (const entry of PLACE_TABLE) {
      if (entry.keys.some((k) => l.includes(k))) {
        return {
          lat: entry.lat,
          lon: entry.lon,
          placeName: entry.placeName,
          ward: entry.ward,
          mapped: true,
        };
      }
    }
  }
  return {
    lat: ISIOLO_CENTRE[0],
    lon: ISIOLO_CENTRE[1],
    placeName: "Unmapped — Isiolo centre",
    ward: "Bulla Pesa", // default ward for the demo
    mapped: false,
  };
}

/**
 * Resolve a real `ward_id` (e.g. from ground_truth_calls) to that
 * ward's approximate centroid, for report pins that have a real ward
 * but no precise reported location. Real but approximate — distinct
 * from `mapped: true`, which means an actual named place matched.
 * Falls back to the flat Isiolo centre only for a truly unknown/unmapped
 * ward_id, never silently mislabels it as Bulla Pesa the way
 * `resolvePlaceName(null)` alone does.
 */
export function wardCentroidForWardId(
  wardId: string | null | undefined,
): ResolvedLocation {
  const name = wardId ? WARD_ID_TO_NAME[wardId] : null;
  if (name) {
    const entry = PLACE_TABLE.find((p) => p.ward === name);
    if (entry) {
      return {
        lat: entry.lat,
        lon: entry.lon,
        placeName: `${name} (ward centre — approximate)`,
        ward: name,
        mapped: false,
      };
    }
  }
  return {
    lat: ISIOLO_CENTRE[0],
    lon: ISIOLO_CENTRE[1],
    placeName: "Unmapped — Isiolo centre",
    ward: "Unknown",
    mapped: false,
  };
}

/**
 * All Isiolo wards we ship in the GeoJSON. The dashboard uses this
 * to build the per-ward legend and to map each report/pastoralist
 * to its ward.
 *
 * **Fixed 2026-08-06**: `isDemoHome` only marked 3 of the 5 real active
 * wards (Bulla Pesa, Burat, Ngare Mara) — Wabera and Oldonyiro were
 * marked `false`, identical to this list's actually-dormant/retired
 * wards (Chari, Cherab, Garbatulla, Kinna, Sericho). Same root pattern
 * as `computeWardAggregates`'s hardcoded 3-tenant admin list above —
 * this is the second of two places that had it. All 5 real active
 * wards now marked `true`.
 */
export const ISILO_WARDS: Array<{
  name: string;
  displayName: string;
  /** Whether this ward is one of the 5 real active wards. */
  isDemoHome: boolean;
}> = [
  { name: "Bulla Pesa", displayName: "Bulla Pesa", isDemoHome: true },
  { name: "Burat", displayName: "Burat", isDemoHome: true },
  { name: "Chari", displayName: "Chari", isDemoHome: false },
  { name: "Cherab", displayName: "Cherab", isDemoHome: false },
  { name: "Garbatulla", displayName: "Garbatulla", isDemoHome: false },
  { name: "Kinna", displayName: "Kinna", isDemoHome: false },
  { name: "Ngare Mara", displayName: "Ngare Mara", isDemoHome: true },
  { name: "Oldonyiro", displayName: "Oldonyiro", isDemoHome: true },
  { name: "Sericho", displayName: "Sericho", isDemoHome: false },
  { name: "Wabera", displayName: "Wabera", isDemoHome: true },
];

// ── Per-ward aggregates (drives the ward choropleth) ────────────────

/**
 * Re-export of the time-slice helper from openData so ward
 * endpoints can share the same window semantics as the per-county
 * path. Returns null for `slice="all"`.
 */
export { timeSliceStart } from "./openData/index.js";

export type { TimeSlice } from "./openData/index.js";

/**
 * Compute per-ward aggregates for the active metric + time slice, from
 * real Supabase data keyed by the real `ward_id` column every relevant
 * table actually has (`ground_truth_calls`, `pastoralists`,
 * `api_latest_satellite_indices`) — not by resolving free-text location
 * strings, which none of these rows carry in practice (see the
 * `reports`/`bcs`/`ndvi` history below).
 *
 * **Fixed 2026-08-06 — this function was structurally broken for every
 * metric before this rewrite:**
 * - The admin view hardcoded 3 tenants (`bula-pesa`, `ngare-mara`,
 *   `burat`), silently omitting Wabera and Oldonyiro — 2 of the 5 real
 *   active wards never appeared in any admin aggregate.
 * - `reports`/`bcs` resolved a `reportedLocation` field that is *always*
 *   null on the real Supabase row (ground_truth_calls has no such
 *   column) via `resolvePlaceName(null)`, which always returns the same
 *   fixed "Isiolo centre" fallback — meaning every real report, from any
 *   ward, piled into one identical bucket. The real row already has a
 *   proper `ward_id` column; it was just never read.
 * - `ndvi` filtered on `ndviVsBaselinePercent`, a field hardcoded to
 *   `null` for every row for the same reason — this metric was
 *   *structurally guaranteed* to always return an empty result,
 *   regardless of the 1,093 real satellite_indices rows sitting in
 *   Supabase. Now reads real, current VCI per ward from
 *   `api_latest_satellite_indices` instead.
 * - `herd` read cattle/goats/camels from the *local Postgres mirror's*
 *   demo-seeded pastoralists (15 fake rows, gated behind
 *   `SEED_DEMO_DATA`) rather than the real Supabase `pastoralists` table
 *   (1 real row today) — showing plausible-looking fake totals instead
 *   of the real, small, honest number.
 * - Separately, on the frontend: `WardsLayer.tsx`/`Comparison.tsx`
 *   keyed this object by `properties.NAME_3`, a GeoJSON property that
 *   does not exist on the real ward features at all (the real property
 *   is `properties.ward`) — meaning **none of the above ever rendered
 *   on the map regardless of what this function returned**. Fixed
 *   alongside this (see WardsLayer.tsx's own history note).
 *
 * Wards with no source data are still omitted from the result map; the
 * dashboard renders them as a neutral gray — that part was correct.
 */
export async function computeWardAggregates(
  tenantId: string,
  metric: string,
  slice: "live" | "7d" | "30d" | "90d" | "1y" | "all",
): Promise<{
  byWard: Record<string, number | null>;
  unit: string;
  description: string;
}> {
  const wantsAdmin = tenantId === "admin";
  // All 5 real active wards for the admin view — not a hardcoded subset.
  const wardIds = wantsAdmin ? knownWardIds() : [wardIdForTenant(tenantId)];
  const wardIdSet = new Set(wardIds);
  const nameForWard = (wardId: string | null): string | null =>
    wardId ? (WARD_ID_TO_NAME[wardId] ?? null) : null;

  switch (metric) {
    case "reports": {
      const byWard: Record<string, number> = {};
      if (isSupabaseConfigured()) {
        const sbRows = await recentGroundTruthCalls(500);
        for (const r of sbRows ?? []) {
          if (!wardIdSet.has(r.ward_id)) continue;
          const name = nameForWard(r.ward_id);
          if (!name) continue;
          byWard[name] = (byWard[name] ?? 0) + 1;
        }
      }
      return {
        byWard,
        unit: "reports",
        description: `Ground-truth reports per ward in the ${slice} window.`,
      };
    }
    case "bcs": {
      const sumByWard: Record<string, number> = {};
      const nByWard: Record<string, number> = {};
      if (isSupabaseConfigured()) {
        const sbRows = await recentGroundTruthCalls(500);
        for (const r of sbRows ?? []) {
          if (r.bcs_score == null || r.bcs_score <= 0) continue;
          if (!wardIdSet.has(r.ward_id)) continue;
          const name = nameForWard(r.ward_id);
          if (!name) continue;
          sumByWard[name] = (sumByWard[name] ?? 0) + r.bcs_score;
          nByWard[name] = (nByWard[name] ?? 0) + 1;
        }
      }
      const byWard: Record<string, number | null> = {};
      for (const w of Object.keys(sumByWard)) {
        byWard[w] = parseFloat((sumByWard[w]! / nByWard[w]!).toFixed(2));
      }
      return {
        byWard,
        unit: "BCS (1-5)",
        description: `Average Body Condition Score per ward in the ${slice} window.`,
      };
    }
    case "ndvi": {
      const byWard: Record<string, number | null> = {};
      await Promise.all(
        wardIds.map(async (wardId) => {
          const name = nameForWard(wardId);
          if (!name) return;
          const sat = await latestSatelliteFor(wardId);
          if (sat?.vci_value != null) {
            byWard[name] = parseFloat(sat.vci_value.toFixed(1));
          }
        }),
      );
      return {
        byWard,
        unit: "VCI (0-100, lower = more stressed)",
        description: `Latest Vegetation Condition Index per ward, from real satellite_indices.`,
      };
    }
    case "herd": {
      const byWard: Record<string, number> = {};
      if (isSupabaseConfigured()) {
        const rows = await listAllPastoralists();
        for (const p of rows ?? []) {
          if (!p.ward_id || !wardIdSet.has(p.ward_id)) continue;
          const name = nameForWard(p.ward_id);
          if (!name) continue;
          byWard[name] = (byWard[name] ?? 0) + (p.herd_size ?? 0);
        }
      }
      return {
        byWard,
        unit: "animals",
        description: `Total registered herd size per ward (real verified pastoralists only).`,
      };
    }
    default:
      return {
        byWard: {},
        unit: "?",
        description: `Unknown metric '${metric}'`,
      };
  }
}
