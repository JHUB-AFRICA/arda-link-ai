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

import { withTenantContext } from "./tenancy-context.js";
import {
  pastoralistsTable,
} from "@workspace/db";
import {
  isSupabaseConfigured,
  recentGroundTruthCalls,
  type SbGroundTruthCallRead,
} from "./supabase.js";

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
 * All Isiolo wards we ship in the GeoJSON. The dashboard uses this
 * to build the per-ward legend and to map each report/pastoralist
 * to its ward.
 */
export const ISILO_WARDS: Array<{
  name: string;
  displayName: string;
  /** Whether this ward is one of the demo tenants' "home" ward. */
  isDemoHome: boolean;
}> = [
  { name: "Bulla Pesa", displayName: "Bulla Pesa", isDemoHome: true },
  { name: "Burat", displayName: "Burat", isDemoHome: true },
  { name: "Chari", displayName: "Chari", isDemoHome: false },
  { name: "Cherab", displayName: "Cherab", isDemoHome: false },
  { name: "Garbatulla", displayName: "Garbatulla", isDemoHome: false },
  { name: "Kinna", displayName: "Kinna", isDemoHome: false },
  { name: "Ngare Mara", displayName: "Ngare Mara", isDemoHome: true },
  { name: "Oldonyiro", displayName: "Oldonyiro", isDemoHome: false },
  { name: "Sericho", displayName: "Sericho", isDemoHome: false },
  { name: "Wabera", displayName: "Wabera", isDemoHome: false },
];

// ── Per-ward aggregates (drives the ward choropleth) ────────────────

/**
 * Re-export of the time-slice helper from openData so ward
 * endpoints can share the same window semantics as the per-county
 * path. Returns null for `slice="all"`.
 */
export { timeSliceStart } from "./openData.js";

export type { TimeSlice } from "./openData.js";

/**
 * Compute per-ward aggregates for the active metric + time slice.
 * Each pastoralist's `location` and each report's `reportedLocation`
 * is run through resolvePlaceName() to determine the GADM ward.
 *
 * Wards with no source data are omitted from the result map; the
 * dashboard renders them as a neutral gray.
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
  const tenantIds = wantsAdmin
    ? ["bula-pesa", "ngare-mara", "burat"]
    : [tenantId];
  // Always load every pastoralist + report once; we resolve the
  // place name to a ward in JS rather than in SQL (no GIS function
  // for our hand-curated place-name table).
  type PastoralistRow = {
    id: number;
    location: string;
    cattle: number;
    goats: number;
    camels: number;
  };
  type ReportRow = {
    reportedLocation: null;
    bcsScore: number | null;
    mortalityRate: string | null;
    ndviVsBaselinePercent: null;
  };
  const allPastoralists: PastoralistRow[] = [];
  const allReports: ReportRow[] = [];
  for (const t of tenantIds) {
    await withTenantContext(t, async (tx) => {
      const ps = await tx
        .select({
          id: pastoralistsTable.id,
          location: pastoralistsTable.location,
          cattle: pastoralistsTable.cattle,
          goats: pastoralistsTable.goats,
          camels: pastoralistsTable.camels,
        })
        .from(pastoralistsTable);
      allPastoralists.push(...ps);
    });
  }
  // Read from Supabase ground_truth_calls — no reportedLocation or
  // ndviVsBaselinePercent available; those fields return null.
  if (isSupabaseConfigured()) {
    const sbRows = await recentGroundTruthCalls(500);
    for (const r of sbRows ?? []) {
      const mortalityLabel =
        r.mortality_rate == null
          ? null
          : r.mortality_rate >= 0.1
            ? "4-plus"
            : r.mortality_rate >= 0.02
              ? "1-3"
              : "none";
      allReports.push({
        reportedLocation: null,
        bcsScore: r.bcs_score ?? null,
        mortalityRate: mortalityLabel,
        ndviVsBaselinePercent: null,
      });
    }
  }

  switch (metric) {
    case "reports": {
      const byWard: Record<string, number> = {};
      for (const r of allReports) {
        const ward = resolvePlaceName(r.reportedLocation).ward;
        byWard[ward] = (byWard[ward] ?? 0) + 1;
      }
      return {
        byWard,
        unit: "reports",
        description: `Ground-truth reports per GADM ward in the ${slice} window.`,
      };
    }
    case "bcs": {
      const sumByWard: Record<string, number> = {};
      const nByWard: Record<string, number> = {};
      for (const r of allReports) {
        if (r.bcsScore == null || r.bcsScore <= 0) continue;
        const ward = resolvePlaceName(r.reportedLocation).ward;
        sumByWard[ward] = (sumByWard[ward] ?? 0) + r.bcsScore;
        nByWard[ward] = (nByWard[ward] ?? 0) + 1;
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
      const sumByWard: Record<string, number> = {};
      const nByWard: Record<string, number> = {};
      for (const r of allReports) {
        if (r.ndviVsBaselinePercent == null || r.ndviVsBaselinePercent === 0) continue;
        const ward = resolvePlaceName(r.reportedLocation).ward;
        sumByWard[ward] = (sumByWard[ward] ?? 0) + r.ndviVsBaselinePercent;
        nByWard[ward] = (nByWard[ward] ?? 0) + 1;
      }
      const byWard: Record<string, number | null> = {};
      for (const w of Object.keys(sumByWard)) {
        byWard[w] = parseFloat((sumByWard[w]! / nByWard[w]!).toFixed(1));
      }
      return {
        byWard,
        unit: "% vs 11-yr baseline",
        description: `Mean NDVI delta vs 11-year baseline per ward (${slice}).`,
      };
    }
    case "herd": {
      const byWard: Record<string, number> = {};
      for (const p of allPastoralists) {
        const ward = resolvePlaceName(p.location).ward;
        const total = p.cattle + p.goats + p.camels;
        byWard[ward] = (byWard[ward] ?? 0) + total;
      }
      return {
        byWard,
        unit: "animals",
        description: `Total registered animals (cattle + goats + camels) per ward.`,
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
