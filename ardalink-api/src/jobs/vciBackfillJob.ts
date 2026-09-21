/**
 * VCI backfill job — writes `vci_value` back to `satellite_indices` for
 * rows where it's null.
 *
 * VCI is a derived value (0..100) computed from a ward-month's current
 * NDVI compared to the historical min/max NDVI for that same ward-month
 * across all prior years. The api's herderContext computes it in memory
 * every request (see fetchWardMonthlyBaseline + computeVci). Persisting
 * it back to Supabase means:
 *   - the dashboard's WardMap and TimeSeries panels can render VCI
 *     directly instead of recomputing per row
 *   - downstream analytics (peer signal, trust scoring, notebook ML)
 *     get a consistent VCI without needing to re-derive
 *
 * Runs on demand via POST /api/ops/vci-backfill (see the ops route
 * elsewhere). Idempotent — rows with vci_value already set are skipped.
 * Uses the excludeCurrentYear=true baseline convention so a 2026 row's
 * VCI is computed against 2015-2025 only (no self-reference).
 */

import { logger } from "../lib/logger.js";
import {
  computeVci,
  fetchWardMonthlyBaseline,
  isSupabaseConfigured,
} from "../lib/supabase/index.js";
import { knownWardIds } from "../lib/wardMapping.js";

interface BackfillRow {
  ward_id: string;
  period_start: string;
  period_end: string;
  calendar_year: number;
  calendar_month: number;
  ndvi_mean: number;
}

export interface BackfillResult {
  scanned: number;
  updated: number;
  skippedNoBaseline: number;
  skippedNoNdvi: number;
  errors: number;
}

export interface RunVciBackfillOptions {
  /**
   * Ward IDs to backfill. When omitted, defaults to the 5 canonical
   * Isiolo wards (`knownWardIds()`) so we don't waste compute filling
   * VCI for rows that belong to retired / non-active wards.
   *
   * Pass an empty array to disable the filter (rare — usually a bug).
   */
  wardIds?: readonly string[];
}

function buildWardFilter(wardIds: readonly string[] | undefined): string {
  const ids = wardIds ?? knownWardIds();
  if (ids.length === 0) return "";
  const list = ids.map((w) => encodeURIComponent(w)).join(",");
  return `&ward_id=in.(${list})`;
}

export async function runVciBackfill(
  opts: RunVciBackfillOptions = {},
): Promise<BackfillResult> {
  const result: BackfillResult = {
    scanned: 0,
    updated: 0,
    skippedNoBaseline: 0,
    skippedNoNdvi: 0,
    errors: 0,
  };

  if (!isSupabaseConfigured()) {
    logger.warn("[VciBackfill] Supabase not configured — nothing to do");
    return result;
  }

  const sbBase = (process.env.SUPABASE_URL ?? "").replace(/\/$/, "");
  const sbKey = (process.env.SUPABASE_SECRET_KEY ?? "").trim();
  const headers = {
    apikey: sbKey,
    Authorization: `Bearer ${sbKey}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  const wardFilter = buildWardFilter(opts.wardIds);

  // Fetch every row where vci_value is null AND ndvi_mean is present.
  // Paginate via Range headers so we don't cap at Supabase's default 1000.
  const rows: BackfillRow[] = [];
  const pageSize = 500;
  for (let offset = 0; ; offset += pageSize) {
    const url =
      `${sbBase}/rest/v1/satellite_indices?vci_value=is.null&ndvi_mean=not.is.null` +
      wardFilter +
      `&select=ward_id,period_start,period_end,calendar_year,calendar_month,ndvi_mean` +
      `&order=ward_id.asc,calendar_year.asc,calendar_month.asc`;
    try {
      const res = await fetch(url, {
        headers: {
          ...headers,
          "Range-Unit": "items",
          Range: `${offset}-${offset + pageSize - 1}`,
        },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        logger.warn(
          { status: res.status, offset },
          "[VciBackfill] page fetch non-2xx — stopping",
        );
        break;
      }
      const page = (await res.json()) as BackfillRow[];
      if (!page || page.length === 0) break;
      rows.push(...page);
      if (page.length < pageSize) break;
    } catch (err) {
      logger.warn({ err: String(err), offset }, "[VciBackfill] page crashed");
      result.errors++;
      break;
    }
  }

  logger.info({ count: rows.length }, "[VciBackfill] Rows to process");

  // Cache baselines per (ward, month) — 5 wards × 12 months = 60
  // baseline fetches max, and each is Supabase-cached inside fetchWardMonthlyBaseline.
  const baselineCache = new Map<string, Awaited<ReturnType<typeof fetchWardMonthlyBaseline>>>();

  for (const row of rows) {
    result.scanned++;
    if (row.ndvi_mean == null) {
      result.skippedNoNdvi++;
      continue;
    }
    const key = `${row.ward_id}:${row.calendar_month}`;
    let baseline = baselineCache.get(key);
    if (baseline === undefined) {
      baseline = await fetchWardMonthlyBaseline(
        row.ward_id,
        row.calendar_month,
      );
      baselineCache.set(key, baseline);
    }
    if (!baseline) {
      result.skippedNoBaseline++;
      continue;
    }
    const vci = computeVci(row.ndvi_mean, baseline);
    if (vci == null) {
      result.skippedNoBaseline++;
      continue;
    }

    // PATCH just this row via a composite filter on ward_id +
    // period_start (the primary uniqueness we can express here).
    const patchUrl =
      `${sbBase}/rest/v1/satellite_indices?ward_id=eq.${encodeURIComponent(row.ward_id)}` +
      `&period_start=eq.${encodeURIComponent(row.period_start)}`;
    try {
      const res = await fetch(patchUrl, {
        method: "PATCH",
        headers: {
          ...headers,
          Prefer: "return=minimal",
        },
        body: JSON.stringify({ vci_value: Math.round(vci * 10) / 10 }),
        signal: AbortSignal.timeout(5_000),
      });
      if (res.ok) {
        result.updated++;
      } else {
        const body = await res.text().catch(() => "");
        logger.warn(
          {
            status: res.status,
            body: body.slice(0, 200),
            ward: row.ward_id,
            period: row.period_start,
          },
          "[VciBackfill] PATCH non-2xx",
        );
        result.errors++;
      }
    } catch (err) {
      logger.warn(
        { err: String(err), ward: row.ward_id, period: row.period_start },
        "[VciBackfill] PATCH crashed",
      );
      result.errors++;
    }
  }

  logger.info(result, "[VciBackfill] Complete");
  return result;
}

// ── Scheduler ──────────────────────────────────────────────────────────────
//
// The GEE writer lands new NDVI rows once a day (~03:10 UTC per the
// `sync_YYYYMMDD_*` cadence observed in Supabase). Running the backfill
// on an hourly interval means a fresh row's VCI is filled within an
// hour of landing — cheap because the job is idempotent + paginated
// and skips rows where vci_value is already set.

const HOURLY_MS = 60 * 60 * 1000;

let vciBackfillTimer: NodeJS.Timeout | null = null;
let vciBackfillEnabled =
  process.env.VCI_BACKFILL_JOB_ENABLED !== "false";

export function startVciBackfillJob(): void {
  if (vciBackfillTimer) {
    logger.warn(
      "[VciBackfill] Job already running — stopping previous timer",
    );
    stopVciBackfillJob();
  }
  vciBackfillEnabled = process.env.VCI_BACKFILL_JOB_ENABLED !== "false";
  if (!vciBackfillEnabled) {
    logger.info("[VciBackfill] Job disabled via VCI_BACKFILL_JOB_ENABLED=false");
    return;
  }
  const intervalMs = Number(
    process.env.VCI_BACKFILL_INTERVAL_MS ?? HOURLY_MS,
  );
  // Run once on boot, then on the interval.
  void runVciBackfill().catch((err) =>
    logger.error({ err }, "[VciBackfill] boot run crashed"),
  );
  vciBackfillTimer = setInterval(() => {
    void runVciBackfill().catch((err) =>
      logger.error({ err }, "[VciBackfill] interval run crashed"),
    );
  }, intervalMs);
  logger.info(
    { intervalMs },
    "[VciBackfill] Scheduled — filling null vci_value for canonical wards",
  );
}

export function stopVciBackfillJob(): void {
  if (vciBackfillTimer) {
    clearInterval(vciBackfillTimer);
    vciBackfillTimer = null;
    logger.info("[VciBackfill] Job stopped");
  }
}

export function isVciBackfillJobEnabled(): boolean {
  return vciBackfillEnabled;
}
