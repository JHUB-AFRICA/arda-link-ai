/**
 * Herder-facing water-point lookups over the REAL `water_nodes` table
 * (engine-owned, 205 rows: 183 OSM + 10 WPDx + 12 legacy seed), which is
 * the same data the operator dashboard's Water Sources tab shows.
 *
 * **Why this exists (2026-08-09).** Every herder-facing water lookup used
 * to read `data/wpdxIsiolo.ts` — a hardcoded 10-row snapshot of the 2012
 * WPDx survey in which every single row is `Non-Functional`. So the bot
 * could only ever name broken boreholes, and concluded there was no
 * working water anywhere in Isiolo, while 205 real points (193 verified)
 * sat in the database being rendered on the dashboard at the same time.
 * That wasn't a prompt problem — it was reading the wrong source.
 *
 * Status handling follows the real intent of the pipeline: OSM points
 * come in as `unknown` (real infrastructure, condition not yet
 * surveyed), and herder ground-truth reports are what *refine* a point's
 * status over time. `unknown` therefore means "real, worth checking" —
 * NOT "broken". Only `non-functional`/`dry` are known-bad, and those are
 * ranked last and never presented as somewhere to head for.
 *
 * Cached in-process: `water_nodes` changes at operator/import pace, not
 * per-request, and these functions sit on herder-facing paths with tight
 * latency budgets (USSD/WhatsApp).
 */

import { fetchAdminWaterNodes, type AdminWaterNode } from "./engine.js";
import { logger } from "./logger.js";

/** Normalized tri-state, same vocabulary the rest of the codebase and
 * the prompt layer already speak (see wpdx.ts's WpdxStatus). */
export type WaterStatus = "working" | "broken" | "unknown";

export interface RealWaterPoint {
  name: string;
  lat: number;
  lon: number;
  distanceKm: number;
  status: WaterStatus;
  sourceType: string;
}

export function normalizeFunctionalStatus(raw: string | null | undefined): WaterStatus {
  const s = (raw ?? "").toLowerCase().trim();
  if (s === "functional" || s === "working") return "working";
  // `dry` and `non-functional` are both known-bad: no water to be had.
  if (s === "non-functional" || s === "non functional" || s === "dry" || s === "broken") {
    return "broken";
  }
  // OSM's default — a real point whose condition simply hasn't been
  // surveyed yet. Deliberately NOT treated as broken.
  return "unknown";
}

const EARTH_RADIUS_KM = 6371;
function haversineKm(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

const CACHE_TTL_MS = 10 * 60 * 1000;
let cache: { nodes: AdminWaterNode[]; expiresAt: number } | null = null;

/**
 * All usable water nodes: verified and not soft-deleted — the same
 * eligibility filter the engine's own grazing advisory applies
 * (`WHERE verified = true AND deleted_at IS NULL`), so a fabricated or
 * operator-rejected point can never reach a herder. Returns null when
 * the engine is unreachable, so callers can tell "no data" apart from
 * "genuinely no points near you".
 */
export async function loadUsableWaterNodes(
  tenantId?: string,
): Promise<AdminWaterNode[] | null> {
  if (cache && cache.expiresAt > Date.now()) return cache.nodes;
  const all = await fetchAdminWaterNodes(tenantId);
  if (all === null) {
    logger.warn("[WaterNodes] engine unreachable — no water-point data this turn");
    return cache?.nodes ?? null; // serve stale over nothing
  }
  const usable = all.filter((n) => n.verified && !n.deletedAt);
  cache = { nodes: usable, expiresAt: Date.now() + CACHE_TTL_MS };
  return usable;
}

/** Test/ops hook — drop the cache so the next call re-reads the engine. */
export function clearWaterNodeCache(): void {
  cache = null;
}

/**
 * Nearest real water points to an origin, ranked so a herder is always
 * offered the most useful first: confirmed working, then unknown
 * (real but unsurveyed — worth checking), then known-bad last. Within
 * each band, nearest first.
 */
export async function nearestRealWaterPoints(
  origin: { lat: number; lon: number },
  n: number,
  tenantId?: string,
): Promise<RealWaterPoint[] | null> {
  const nodes = await loadUsableWaterNodes(tenantId);
  if (nodes === null) return null;
  const rows: RealWaterPoint[] = nodes.map((node) => ({
    name: node.name,
    lat: node.latitude,
    lon: node.longitude,
    distanceKm: haversineKm(origin, { lat: node.latitude, lon: node.longitude }),
    status: normalizeFunctionalStatus(node.functionalStatus),
    sourceType: node.waterSourceType,
  }));
  const rank = (s: WaterStatus) => (s === "working" ? 0 : s === "unknown" ? 1 : 2);
  rows.sort((a, b) => rank(a.status) - rank(b.status) || a.distanceKm - b.distanceKm);
  return rows.slice(0, Math.max(0, n));
}

/**
 * Compact, USSD/SMS-safe lines for the nearest real water points —
 * the real-data replacement for wpdx.ts's `formatUssdLines`, which reads
 * the static 10-row snapshot AND ranks known-broken points above
 * unsurveyed ones (backwards: an unsurveyed point is worth checking, a
 * known-dry one is not). Returns null when the engine is unreachable so
 * callers can fall back rather than print an empty list.
 */
export async function formatRealWaterLines(
  origin: { lat: number; lon: number },
  n = 5,
  tenantId?: string,
): Promise<string[] | null> {
  const rows = await nearestRealWaterPoints(origin, n, tenantId);
  if (rows === null) return null;
  return rows.map((r) => {
    const km = r.distanceKm >= 10 ? r.distanceKm.toFixed(0) : r.distanceKm.toFixed(1);
    const badge = r.status === "working" ? "OK" : r.status === "broken" ? "BAD" : "?";
    return `${r.name} (${badge}, ${km}km)`.slice(0, 45);
  });
}

/** The nearest point actually confirmed working, or null if none is. */
export async function nearestWorkingRealWaterPoint(
  origin: { lat: number; lon: number },
  tenantId?: string,
): Promise<RealWaterPoint | null> {
  const rows = await nearestRealWaterPoints(origin, 500, tenantId);
  return rows?.find((r) => r.status === "working") ?? null;
}
