/**
 * WPDx (Water Point Data Exchange) accessor.
 *
 * Backed by a static snapshot in `data/wpdxIsiolo.ts` — refresh with
 * `node ardalink-api/scripts/pull-wpdx.mjs`. We deliberately do NOT
 * hit the WPDx SODA API at runtime: (a) it's occasionally slow,
 * (b) WPDx changes at survey pace (~annual), and (c) the helpers below
 * are called from herder-facing paths (USSD, voice opener) where an
 * external round-trip would blow the AT ~10 s budget.
 *
 * `statusClean` is the useful truthiness field. `status_id` on WPDx is
 * "has data" not "working" — don't use it directly.
 *
 * Isiolo reality (as of the 2026-07-08 snapshot): 10 rows, all Non-
 * Functional per 2012 surveys, no coverage in Bulla Pesa or Wabera.
 * This is the gap ArdaLink is filling — herder ground_truth_reports
 * carry fresher status than WPDx does.
 */

import { WPDX_ISIOLO, type WpdxPoint } from "./data/wpdxIsiolo.js";
import { wardIdForTenant } from "./wardMapping.js";
import { centroidForWardId } from "./supabase/index.js";

const FUNCTIONAL_LABELS = new Set([
  "Functional",
  "Functional but needs repair",
  "Functional but not in use",
]);

const NON_FUNCTIONAL_LABELS = new Set([
  "Non-Functional",
  "Non functional due to dry season",
  "Non-Functional due to dry season",
]);

/**
 * Interpret WPDx's `statusClean` string as a tri-state.
 * `null` when the snapshot has no signal for the row.
 */
export type WpdxStatus = "working" | "broken" | "unknown";
export function statusFor(p: WpdxPoint): WpdxStatus {
  if (!p.statusClean) return "unknown";
  if (FUNCTIONAL_LABELS.has(p.statusClean)) return "working";
  if (NON_FUNCTIONAL_LABELS.has(p.statusClean)) return "broken";
  return "unknown";
}

/**
 * Best-effort human name for a point. WPDx doesn't ship a name column,
 * so we synthesise one from ward + water source + a short WPDx id
 * suffix. Callers can override once we have a local naming table.
 */
export function displayName(p: WpdxPoint): string {
  const ward = p.ward ?? "Isiolo";
  const src = p.waterSource ?? "water point";
  const suffix = p.wpdxId.split("+").pop()?.slice(0, 4) ?? "";
  return `${ward} ${src.toLowerCase()} ${suffix}`.trim();
}

// Rough haversine — good enough for "nearest N" queries where we only
// need relative distances, and adequate for USSD-line trekking-time
// estimates (bounded to within a few percent over 20 km).
const EARTH_KM = 6371.0088;
export function distanceKm(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

export interface NearbyPoint {
  point: WpdxPoint;
  status: WpdxStatus;
  distanceKm: number;
  displayName: string;
}

/**
 * Nearest N WPDx points to a coordinate.
 * `workingOnly=true` filters to `statusFor(p) === 'working'`, which is
 * what USSD's "water points near me" should surface.
 */
export function nearestPoints(
  origin: { lat: number; lon: number },
  n: number,
  opts: { workingOnly?: boolean } = {},
): NearbyPoint[] {
  const rows: NearbyPoint[] = WPDX_ISIOLO.map((p) => ({
    point: p,
    status: statusFor(p),
    distanceKm: distanceKm(origin, p),
    displayName: displayName(p),
  }));
  const filtered = opts.workingOnly
    ? rows.filter((r) => r.status === "working")
    : rows;
  filtered.sort((a, b) => a.distanceKm - b.distanceKm);
  return filtered.slice(0, Math.max(0, n));
}

/**
 * All points for a named ward (case-insensitive). Aliases like
 * "Oldo/Nyiro" vs "Oldonyiro" are normalised so a caller looking up
 * `Oldonyiro` still finds the WPDx-canonical `Oldo/Nyiro`.
 */
const WARD_ALIASES: Record<string, string> = {
  oldonyiro: "oldo/nyiro",
  "oldo nyiro": "oldo/nyiro",
  "ngare-mara": "ngare mara",
  "bula-pesa": "bulla pesa",
  "bula pesa": "bulla pesa",
};
export function pointsForWard(wardName: string): NearbyPoint[] {
  const needle = (WARD_ALIASES[wardName.toLowerCase()] ?? wardName.toLowerCase()).trim();
  return WPDX_ISIOLO.filter(
    (p) => (p.ward ?? "").toLowerCase().trim() === needle,
  ).map((p) => ({
    point: p,
    status: statusFor(p),
    distanceKm: 0,
    displayName: displayName(p),
  }));
}

export function totalCount(): number {
  return WPDX_ISIOLO.length;
}

export function workingCount(): number {
  return WPDX_ISIOLO.filter((p) => statusFor(p) === "working").length;
}

// ── Ground-truth overlay ─────────────────────────────────────────────

/**
 * A herder-reported override for a specific WPDx point. Callers
 * fetch these from Supabase (see recentWaterPointGroundTruth in
 * supabase.ts) and pass them here to build an updated status map.
 */
export interface WaterPointOverride {
  water_point_name: string;
  water_point_status: string;
  call_timestamp: string;
}

/**
 * Build a name → resolved status map from ground-truth overrides.
 * Matching is fuzzy — a herder saying "Burat" or "burat borehole"
 * matches any WPDx point in Burat ward. When multiple herders
 * disagree, the most recent timestamp wins.
 *
 * The output map is keyed by the CANONICAL WPDx displayName so it
 * plugs directly into filter / rank code without name-normalisation
 * duplication.
 */
export function overlayStatusFromGroundTruth(
  overrides: WaterPointOverride[],
): Map<string, WpdxStatus> {
  // Sort newest-first so the reduce picks most-recent as canonical.
  const sorted = [...overrides].sort(
    (a, b) =>
      new Date(b.call_timestamp).getTime() -
      new Date(a.call_timestamp).getTime(),
  );
  const result = new Map<string, WpdxStatus>();
  for (const ov of sorted) {
    const status = interpretHerderStatus(ov.water_point_status);
    if (status === "unknown") continue;
    const needle = ov.water_point_name.toLowerCase().trim();
    for (const p of WPDX_ISIOLO) {
      const dn = displayName(p).toLowerCase();
      const wardOnly = (p.ward ?? "").toLowerCase();
      if (dn.includes(needle) || wardOnly.includes(needle) || needle.includes(wardOnly)) {
        if (!result.has(displayName(p))) {
          result.set(displayName(p), status);
        }
      }
    }
  }
  return result;
}

/**
 * Herders describe water status in whatever language they prefer —
 * "inafanya kazi", "working", "sawa", "broken", "mbovu", "empty",
 * "safi". Map that free-form string to our WpdxStatus tri-state.
 */
function interpretHerderStatus(raw: string): WpdxStatus {
  const s = raw.toLowerCase().trim();
  if (
    s.includes("work") ||
    s.includes("running") ||
    s.includes("sawa") ||
    s.includes("inafanya") ||
    s.includes("kazi") ||
    s.includes("safi") ||
    s === "ok" ||
    s === "yes"
  ) {
    return "working";
  }
  if (
    s.includes("broken") ||
    s.includes("dry") ||
    s.includes("empty") ||
    s.includes("mbovu") ||
    s.includes("kavu") ||
    s.includes("haifany")
  ) {
    return "broken";
  }
  return "unknown";
}

/**
 * Nearest N points to origin under a ground-truth overlay. Points
 * whose overlay status is 'working' are ranked first, then 'unknown',
 * then 'broken' — same behaviour as workingFirst on nearestPoints
 * but the overlay dominates the WPDx snapshot's baseline status.
 */
/**
 * Points whose status is genuinely 'working', nearest first — NOT the
 * "working ranked first but broken ones still included" behaviour of
 * `nearestWorkingKnownPoints` below (whose name is misleading and whose
 * callers have repeatedly treated its top result as somewhere to send a
 * herder).
 *
 * This exists because of a real, live incident (2026-08-09): every one
 * of the 10 rows in the WPDx snapshot is `Non-Functional`, so
 * `nearestWorkingKnownPoints` can only ever return broken points unless
 * a herder ground-truth report has overridden one — and the prompt
 * presented the top row as "nearest water point", which the model
 * turned into a recommendation. A herder who said they had no water was
 * told to head for a borehole ~15.9 km away that the system already
 * knew was broken. Returning an EMPTY array when nothing is confirmed
 * working is the honest answer, and callers must handle it as such
 * rather than falling back to a broken point.
 */
export function nearestConfirmedWorkingPoints(
  origin: { lat: number; lon: number },
  n: number,
  overrides: WaterPointOverride[] = [],
): NearbyPoint[] {
  return nearestWorkingKnownPoints(origin, WPDX_ISIOLO.length, overrides)
    .filter((p) => p.status === "working")
    .slice(0, Math.max(0, n));
}

export function nearestWorkingKnownPoints(
  origin: { lat: number; lon: number },
  n: number,
  overrides: WaterPointOverride[] = [],
): NearbyPoint[] {
  const overlay = overlayStatusFromGroundTruth(overrides);
  const rows: NearbyPoint[] = WPDX_ISIOLO.map((p) => {
    const overlayStatus = overlay.get(displayName(p));
    return {
      point: p,
      status: overlayStatus ?? statusFor(p),
      distanceKm: distanceKm(origin, p),
      displayName: displayName(p),
    };
  });
  rows.sort((a, b) => {
    const rank = (s: WpdxStatus) =>
      s === "working" ? 0 : s === "unknown" ? 1 : 2;
    return rank(a.status) - rank(b.status) || a.distanceKm - b.distanceKm;
  });
  return rows.slice(0, Math.max(0, n));
}

/**
 * Ward centroid for a tenant slug, read straight from Supabase's real
 * `wards.centroid` column (see `centroidForWardId`) — no hardcoded
 * fallback table. Used as the origin coord when a caller only names a
 * ward and doesn't share GPS.
 *
 * **Replaced 2026-08-06** a hardcoded `WARD_CENTROIDS` table that lived
 * here: those values were numerically near-identical to Supabase's real
 * data, meaning they were a stale hand-copied snapshot rather than a
 * live read — exactly the kind of drift risk this repo has already been
 * bitten by more than once this session (WPDx, migration catch-ups).
 * `centroidForWardId` reuses `listWards()`'s 60s cache, so this stays
 * cheap on repeated calls.
 */
export async function centroidForTenant(
  tenantSlug: string,
): Promise<{ lat: number; lon: number } | null> {
  const wardId = wardIdForTenant(tenantSlug);
  return centroidForWardId(wardId);
}

/**
 * Compact, USSD-safe list of the nearest N water points as ready-to-emit
 * text lines. Truncated per line so the whole reply fits into AT's ~160
 * char USSD screen budget. Status is coded as OK/BAD/? (Swahili gloss)
 * so herders can act on the info at a glance.
 */
export function formatUssdLines(
  origin: { lat: number; lon: number },
  n = 5,
  opts: { workingFirst?: boolean } = {},
): string[] {
  const rows = nearestPoints(origin, n * 2); // over-fetch so we can prefer working
  const sorted = opts.workingFirst
    ? [...rows].sort((a, b) => {
        // Working first, then broken, then unknown. Ties break by distance.
        const rank = (s: WpdxStatus) =>
          s === "working" ? 0 : s === "broken" ? 1 : 2;
        return rank(a.status) - rank(b.status) || a.distanceKm - b.distanceKm;
      })
    : rows;
  return sorted.slice(0, n).map((r) => {
    const km = r.distanceKm >= 10 ? r.distanceKm.toFixed(0) : r.distanceKm.toFixed(1);
    const badge =
      r.status === "working" ? "OK" : r.status === "broken" ? "BAD" : "?";
    // Fit ~40 chars per line so 5 lines ≈ 200 chars including numbering.
    // Include the last 3 chars of the WPDx id so two boreholes in the
    // same ward don't render as duplicates on the herder's screen.
    const idTag = r.point.wpdxId.split("+").pop()?.slice(-3) ?? "";
    const label = (r.point.ward ?? "?") + " " +
      (r.point.waterSource?.split("/")[0]?.toLowerCase() ?? "point") +
      (idTag ? " " + idTag : "");
    return `${label} (${badge}, ${km}km)`.slice(0, 45);
  });
}
