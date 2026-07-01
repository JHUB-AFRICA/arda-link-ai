/**
 * Thin HTTP client for the ArdaLink engine's `/api/v1/baseline/*` endpoints.
 *
 * Replaces the legacy Azure Cosmos DB client (`@azure/cosmos`) as the source
 * of truth for the historical NDVI / NDRE / Red-edge baseline. The engine owns
 * `gis_engine.baseline_aggregate` and `gis_engine.baseline_pixel` (Postgres),
 * populated by `ardalink-engine/scripts/populate_baseline.py`.
 *
 * No SDK dependency: a few `fetch` calls. Fails soft — when the engine is
 * unreachable or returns `available: false`, callers get `null` rather than
 * a thrown error. Callers decide how to render "no baseline yet" (the
 * dashboard already knows how to label wards with insufficient data).
 */

const DEFAULT_TIMEOUT_MS = 5_000;

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

async function engineFetch<T>(path: string, init?: RequestInit): Promise<T | null> {
  const url = `${engineBase()}${path}`;
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
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
  tenantId: string = "isiolo",
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
  tenantId: string = "isiolo",
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
  // Hit the engine's health endpoint as a reachability probe.
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
 */
export async function fetchSatelliteVCI(wardId: string): Promise<VCISnapshot | null> {
  const res = await engineFetch<VCISnapshot>(`/api/v1/satellite/vci?ward_id=${encodeURIComponent(wardId)}`);
  return res;
}

/**
 * Trigger VCI fetch for all demo wards. Used by the satellite scheduler.
 * Returns `null` when the engine is unreachable.
 */
export async function triggerSatelliteRefresh(dryRun = false): Promise<SatelliteTriggerResponse | null> {
  const res = await engineFetch<SatelliteTriggerResponse>(
    `/api/v1/satellite/trigger?dry_run=${dryRun}`,
    { method: "POST" },
  );
  return res;
}