/**
 * Thin HTTP client for the ArdaLink engine's `/api/v1/baseline/*` endpoints.
 *
 * Replaces the legacy Azure Cosmos DB client (`@azure/cosmos`) as the source
 * of truth for the historical NDVI / NDRE / Red-edge baseline. The engine owns
 * `gis_engine.baseline_aggregate` and `gis_engine.baseline_pixel` (Postgres),
 * populated by `ardalink-engine/scripts/populate_baseline.py`.
 *
 * Tenancy: every call attaches `X-Tenant-ID` + `X-Tenant-Sig` (HMAC-SHA256
 * of the tenant id under `TENANT_ATTESTATION_SECRET`). The engine's
 * TenantAttestationMiddleware verifies the signature and binds RLS via
 * `SET LOCAL app.current_tenant_id`. When the secret is unset (dev), the
 * signature is empty and the engine treats the request as pass-through.
 *
 * No SDK dependency: a few `fetch` calls. Fails soft — when the engine is
 * unreachable or returns `available: false`, callers get `null` rather than
 * a thrown error. Callers decide how to render "no baseline yet" (the
 * dashboard already knows how to label wards with insufficient data).
 */

import { tenantForwardHeaders } from "./tenancy.js";

// Baseline lookups return in ~50–200 ms so the default is tight, but a
// live GEE composite fetch for a single ward takes 15–30 s and the
// 5-ward /trigger endpoint compounds that. Callers pass an explicit
// override for slow paths via `engineFetch(..., { timeoutMs: 90_000 })`.
const DEFAULT_TIMEOUT_MS = 5_000;
const LIVE_GEE_TIMEOUT_MS = 90_000;

function engineBase(): string {
  // ARDALINK_ENGINE_BASE is the canonical hook. The Node side already
  // exposes ARDALINK_HOST/PORT for the legacy HMAC flow; if those are set,
  // derive the engine URL from them.
  const explicit = process.env["ARDALINK_ENGINE_BASE"];
  if (explicit) return explicit.replace(/\/+$/, "");

  const host = process.env["ARDALINK_HOST"] ?? "127.0.0.1";
  const port = process.env["ARDALINK_PORT"] ?? "5001";
  return `http://${host}:${port}`;
}

async function engineFetch<T>(
  path: string,
  opts: {
    tenantId?: string;
    init?: RequestInit;
    timeoutMs?: number;
  } = {},
): Promise<T | null> {
  const url = `${engineBase()}${path}`;
  const ctrl = new AbortController();
  const timeout = setTimeout(
    () => ctrl.abort(),
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  try {
    const tenantHeaders = opts.tenantId ? tenantForwardHeaders(opts.tenantId) : {};
    const mergedHeaders = { ...tenantHeaders, ...(opts.init?.headers ?? {}) };
    const res = await fetch(url, {
      ...opts.init,
      headers: mergedHeaders,
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// ── Wire types (mirror the engine's pydantic models in ardalink_engine/src/api/baseline.py) ──

export interface BaselineAggregateRow {
  tenant_id: string;
  ward_id: string;
  ward_name: string;
  month: number;
  ndvi_p50: number | null;
  ndvi_p5: number | null;
  ndre_p50: number | null;
  ndre_p5: number | null;
  red_edge_p50: number | null;
  red_edge_p5: number | null;
  source: string;
  window_label: string | null;
  pixel_count: number | null;
  computed_at: string;
}

export interface BaselineAggregateResponse {
  available: boolean;
  tenant_id: string;
  ward_id: string;
  month: number;
  row: BaselineAggregateRow | null;
}

export interface BaselinePixelCell {
  row_idx: number;
  col_idx: number;
  value: number;
}

export interface BaselinePixelResponse {
  available: boolean;
  tenant_id: string;
  ward_id: string;
  month: number;
  band: string;
  pixel_count: number;
  cells: BaselinePixelCell[];
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Per-ward, per-month aggregate baseline (NDVI / NDRE / Red-edge p50 + p5).
 * Returns `null` when the row is missing OR the engine is unreachable.
 * Callers should treat `null` as "no baseline available" — not an error.
 *
 * Accepts EITHER the IEBC wardcode (e.g. "242") OR the ward display name
 * (e.g. "Bulla Pesa"). The engine resolves name → code when needed.
 */
export async function fetchBaselineAggregate(
  wardIdOrName: string,
  month: number,
  tenantId: string = "bula-pesa",
): Promise<BaselineAggregateRow | null> {
  // The engine accepts both ward_id (code) and ward_name (display). Default
  // to ward_id for backward compat; if the value doesn't look like a digit
  // string, pass it as ward_name instead.
  const qs = new URLSearchParams({
    tenant_id: tenantId,
    month: String(month),
  });
  if (/^\d+$/.test(wardIdOrName)) {
    qs.set("ward_id", wardIdOrName);
  } else {
    qs.set("ward_name", wardIdOrName);
  }
  const res = await engineFetch<BaselineAggregateResponse>(
    `/api/v1/baseline/aggregate?${qs.toString()}`,
    { tenantId },
  );
  return res?.available ? res.row : null;
}

/**
 * Per-pixel, per-band baseline grid. Sparse — only cells with stored values
 * are returned. Returns `null` when empty OR the engine is unreachable.
 */
export async function fetchBaselinePixel(
  wardIdOrName: string,
  month: number,
  band: "ndvi" | "ndre" | "red_edge" = "ndvi",
  tenantId: string = "bula-pesa",
): Promise<BaselinePixelCell[] | null> {
  const qs = new URLSearchParams({
    tenant_id: tenantId,
    month: String(month),
    band,
  });
  if (/^\d+$/.test(wardIdOrName)) {
    qs.set("ward_id", wardIdOrName);
  } else {
    qs.set("ward_name", wardIdOrName);
  }
  const res = await engineFetch<BaselinePixelResponse>(
    `/api/v1/baseline/pixel?${qs.toString()}`,
    { tenantId },
  );
  return res?.available ? res.cells : null;
}

/**
 * Convenience: probe the engine's baseline tables and return a readiness
 * summary. Used by `/api/healthz` so operators see whether baseline data
 * has been populated.
 */
export async function probeBaselineReadiness(): Promise<{
  reachable: boolean;
  baseUrl: string;
}> {
  const baseUrl = engineBase();
  // Hit the engine's health endpoint as a reachability probe. No tenant
  // needed — /health is public.
  const res = await engineFetch<{ status?: string }>(`/health`);
  return { reachable: res !== null, baseUrl };
}

// ── Satellite GEE client ────────────────────────────────────────────────────────

export interface VCISnapshot {
  ward_id: string;
  ward_name: string;
  vci: number;
  ndvi_now: number | null;
  ndvi_min: number | null;
  ndvi_max: number | null;
  urban_masked: boolean;
  prosopis_factor: number;
  image_dates: string[] | null;
  captured_at: string;
}

export interface SatelliteTriggerResponse {
  status: string;
  wards: string[];
  started_at: string;
  results: Record<string, VCISnapshot | null> | null;
  error: string | null;
}

/**
 * Fetch live Vegetation Condition Index for a single ward from the engine.
 * Returns `null` when the engine is unreachable or GEE is not configured.
 *
 * The `tenantId` is used to sign the attestation header for the engine's
 * middleware. Satellite routes don't touch the DB, but the header still
 * proves this call came from a trusted upstream.
 */
export async function fetchSatelliteVCI(
  wardId: string,
  tenantId: string = "bula-pesa",
): Promise<VCISnapshot | null> {
  // Live GEE composite fetch — takes 15–30 s. Use the long timeout so
  // the api doesn't cut off before the engine responds.
  const res = await engineFetch<VCISnapshot>(
    `/api/v1/satellite/vci?ward_id=${encodeURIComponent(wardId)}`,
    { tenantId, timeoutMs: LIVE_GEE_TIMEOUT_MS },
  );
  return res;
}

// Species-aware grazing advisory (piosphere zones). Mirrors
// ardalink_engine/src/api/grazing.py's GrazingAdvisory pydantic model.
export interface GrazingNearestWaterNode {
  name: string;
  distanceKm: number;
  direction: string;
  functionalStatus: string;
}

export interface GrazingAdvisory {
  nearestWaterNode: GrazingNearestWaterNode | null;
  speciesGroup: "cattle" | "shoat" | "camel";
  radiusKm: number;
  inRing: boolean;
  vci: number | null;
  ndviNow: number | null;
  dataSources: { water: string; vegetation: string };
}

/**
 * Fetch a species-aware grazing advisory for a herder's current location
 * from the engine's `/api/v1/grazing/advisory` endpoint. Returns `null`
 * when the engine is unreachable or GEE is not configured.
 *
 * Chains into the same live-GEE path as `fetchSatelliteVCI` (first touch
 * per water point takes 15-30s; the engine caches by water-point+species,
 * so repeat callers near the same point are fast) — same long timeout.
 */
export async function fetchGrazingAdvisory(
  lat: number,
  lon: number,
  speciesGroup: "cattle" | "shoat" | "camel",
  tenantId: string = "bula-pesa",
): Promise<GrazingAdvisory | null> {
  const qs = new URLSearchParams({
    lat: String(lat),
    lon: String(lon),
    species_group: speciesGroup,
  });
  const res = await engineFetch<{
    nearest_water_node: {
      name: string;
      distance_km: number;
      direction: string;
      functional_status: string;
    } | null;
    species_group: "cattle" | "shoat" | "camel";
    radius_km: number;
    in_ring: boolean;
    vci: number | null;
    ndvi_now: number | null;
    data_sources: { water: string; vegetation: string };
  }>(`/api/v1/grazing/advisory?${qs.toString()}`, {
    tenantId,
    timeoutMs: LIVE_GEE_TIMEOUT_MS,
  });
  if (!res) return null;
  return {
    nearestWaterNode: res.nearest_water_node
      ? {
          name: res.nearest_water_node.name,
          distanceKm: res.nearest_water_node.distance_km,
          direction: res.nearest_water_node.direction,
          functionalStatus: res.nearest_water_node.functional_status,
        }
      : null,
    speciesGroup: res.species_group,
    radiusKm: res.radius_km,
    inRing: res.in_ring,
    vci: res.vci,
    ndviNow: res.ndvi_now,
    dataSources: res.data_sources,
  };
}

/**
 * Trigger VCI fetch for all demo wards. Used by the satellite scheduler.
 * Returns `null` when the engine is unreachable.
 */
export async function triggerSatelliteRefresh(
  dryRun = false,
  tenantId: string = "bula-pesa",
): Promise<SatelliteTriggerResponse | null> {
  // Non-dry-run iterates all 5 active wards and pays the GEE cost for
  // each; ~90 s ceiling is a soft budget that still catches genuine
  // hangs. Dry-runs are near-instant so the tight default is fine.
  const res = await engineFetch<SatelliteTriggerResponse>(
    `/api/v1/satellite/trigger?dry_run=${dryRun}`,
    {
      tenantId,
      init: { method: "POST" },
      timeoutMs: dryRun ? DEFAULT_TIMEOUT_MS : LIVE_GEE_TIMEOUT_MS,
    },
  );
  return res;
}

// ── Operator data-management console: engine-owned tables ──────────────
// Mirrors ardalink_engine/src/api/admin_water.py's pydantic models.
// These are engine-internal calls proxied from src/routes/ops/admin.ts —
// the dashboard never talks to the engine directly. Callers there are
// responsible for calling recordAudit() around each of these; this file
// only performs the actual mutation.

export interface AdminWaterNode {
  wpdxId: string;
  name: string;
  latitude: number;
  longitude: number;
  waterSourceType: string;
  functionalStatus: string;
  source: string | null;
  verified: boolean;
  deletedAt: string | null;
}

function mapAdminWaterNode(row: {
  wpdx_id: string;
  name: string;
  latitude: number;
  longitude: number;
  water_source_type: string;
  functional_status: string;
  source: string | null;
  verified: boolean;
  deleted_at: string | null;
}): AdminWaterNode {
  return {
    wpdxId: row.wpdx_id,
    name: row.name,
    latitude: row.latitude,
    longitude: row.longitude,
    waterSourceType: row.water_source_type,
    functionalStatus: row.functional_status,
    source: row.source,
    verified: row.verified,
    deletedAt: row.deleted_at,
  };
}

export async function fetchAdminWaterNodes(
  tenantId: string = "bula-pesa",
): Promise<AdminWaterNode[] | null> {
  const res = await engineFetch<Array<Parameters<typeof mapAdminWaterNode>[0]>>(
    "/api/v1/admin/water-nodes",
    { tenantId },
  );
  return res ? res.map(mapAdminWaterNode) : null;
}

export async function updateAdminWaterNode(
  wpdxId: string,
  updates: Partial<{
    name: string;
    waterSourceType: string;
    functionalStatus: string;
    latitude: number;
    longitude: number;
  }>,
  tenantId: string = "bula-pesa",
): Promise<AdminWaterNode | null> {
  const body: Record<string, unknown> = {};
  if (updates.name !== undefined) body["name"] = updates.name;
  if (updates.waterSourceType !== undefined) body["water_source_type"] = updates.waterSourceType;
  if (updates.functionalStatus !== undefined) body["functional_status"] = updates.functionalStatus;
  if (updates.latitude !== undefined) body["latitude"] = updates.latitude;
  if (updates.longitude !== undefined) body["longitude"] = updates.longitude;

  const res = await engineFetch<Parameters<typeof mapAdminWaterNode>[0]>(
    `/api/v1/admin/water-nodes/${encodeURIComponent(wpdxId)}`,
    {
      tenantId,
      init: {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    },
  );
  return res ? mapAdminWaterNode(res) : null;
}

async function setWaterNodeVerification(
  wpdxId: string,
  verified: boolean,
  tenantId: string,
): Promise<AdminWaterNode | null> {
  const action = verified ? "verify" : "unverify";
  const res = await engineFetch<Parameters<typeof mapAdminWaterNode>[0]>(
    `/api/v1/admin/water-nodes/${encodeURIComponent(wpdxId)}/${action}`,
    { tenantId, init: { method: "POST" } },
  );
  return res ? mapAdminWaterNode(res) : null;
}

export const verifyAdminWaterNode = (wpdxId: string, tenantId = "bula-pesa") =>
  setWaterNodeVerification(wpdxId, true, tenantId);

export const unverifyAdminWaterNode = (wpdxId: string, tenantId = "bula-pesa") =>
  setWaterNodeVerification(wpdxId, false, tenantId);

export async function deleteAdminWaterNode(
  wpdxId: string,
  tenantId: string = "bula-pesa",
): Promise<AdminWaterNode | null> {
  const res = await engineFetch<Parameters<typeof mapAdminWaterNode>[0]>(
    `/api/v1/admin/water-nodes/${encodeURIComponent(wpdxId)}`,
    { tenantId, init: { method: "DELETE" } },
  );
  return res ? mapAdminWaterNode(res) : null;
}

export interface AdminSpeciesRingRadius {
  wardId: string;
  speciesGroup: string;
  radiusKm: number;
  source: string;
}

function mapAdminSpeciesRingRadius(row: {
  ward_id: string;
  species_group: string;
  radius_km: number;
  source: string;
}): AdminSpeciesRingRadius {
  return {
    wardId: row.ward_id,
    speciesGroup: row.species_group,
    radiusKm: row.radius_km,
    source: row.source,
  };
}

export async function fetchAdminSpeciesRingRadii(
  tenantId: string = "bula-pesa",
): Promise<AdminSpeciesRingRadius[] | null> {
  const res = await engineFetch<Array<Parameters<typeof mapAdminSpeciesRingRadius>[0]>>(
    "/api/v1/admin/species-ring-radii",
    { tenantId },
  );
  return res ? res.map(mapAdminSpeciesRingRadius) : null;
}

export async function updateAdminSpeciesRingRadius(
  wardId: string,
  speciesGroup: "cattle" | "shoat" | "camel",
  radiusKm: number,
  tenantId: string = "bula-pesa",
): Promise<AdminSpeciesRingRadius | null> {
  const res = await engineFetch<{
    ward_id: string;
    species_group: string;
    radius_km: number;
    source: string;
  }>(
    `/api/v1/admin/species-ring-radii/${encodeURIComponent(wardId)}/${encodeURIComponent(speciesGroup)}`,
    {
      tenantId,
      init: {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ radius_km: radiusKm }),
      },
    },
  );
  return res ? mapAdminSpeciesRingRadius(res) : null;
}

