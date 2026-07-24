/**
 * Satellite refresh job — scheduled GEE VCI data fetch.
 *
 * Calls the new `/api/satellite/trigger` endpoint to refresh VCI data
 * for all demo wards. Runs on a seasonal schedule:
 *
 * - Dry season (Jun-Sep, Jan-Mar): Weekly (Sunday 6AM)
 * - Wet season (Oct-Dec, Apr-May): Monthly (1st 6AM)
 */

import { randomUUID } from "node:crypto";
import { triggerSatelliteRefresh, type SatelliteTriggerResponse } from "../lib/engine.js";
import { logger } from "../lib/logger.js";
import {
  persistSatelliteVciSnapshot,
  isSupabaseConfigured,
} from "../lib/supabase.js";
import { knownWardIds, tenantForWardId, wardIdForTenant } from "../lib/wardMapping.js";

// Mirrors the engine's DEMO_WARDS in ardalink_engine/src/api/satellite.py.
// Used for logging only — the engine decides which wards its /trigger route
// iterates. Sourced from wardMapping so it can't drift from the canonical
// Isiolo Sub-County set (241 Wabera, 242 Bulla Pesa, 245 Ngare Mara,
// 246 Burat, 247 Oldonyiro).
const DEMO_WARDS = knownWardIds().map(tenantForWardId);

/**
 * Determine if we're currently in dry season or wet season.
 *
 * Dry season: Jun-Sep (months 6-9) and Jan-Mar (months 1-3)
 * Wet season: Oct-Dec (months 10-12) and Apr-May (months 4-5)
 */
function isDrySeason(): boolean {
  const month = new Date().getMonth() + 1; // 1-12
  // Dry: Jun(6)-Sep(9) or Jan(1)-Mar(3)
  return month >= 6 && month <= 9;
}

/**
 * Get the interval for the next run based on current season.
 *
 * Dry season: weekly (every 7 days)
 * Wet season: monthly (every 30 days)
 */
function getSeasonalInterval(): number {
  return isDrySeason()
    ? 7 * 24 * 60 * 60 * 1000 // 7 days in dry season
    : 30 * 24 * 60 * 60 * 1000; // 30 days in wet season
}

/**
 * Get a human-readable description of the current schedule.
 */
export function getScheduleDescription(): string {
  const season = isDrySeason() ? "dry" : "wet";
  const interval = isDrySeason() ? "weekly" : "monthly";
  const seasonMonths = isDrySeason()
    ? "Jun-Sep, Jan-Mar"
    : "Oct-Dec, Apr-May";
  return `${season} season (${seasonMonths}), ${interval} refresh`;
}

let satelliteTimer: NodeJS.Timeout | null = null;
let enabled = process.env.SATELLITE_JOB_ENABLED !== "false";

/**
 * Write VCI snapshots returned by the trigger to satellite_indices.
 * Each ward write is independent — a failure on one ward doesn't stop others.
 */
async function persistVciSnapshots(
  results: NonNullable<SatelliteTriggerResponse["results"]>,
): Promise<void> {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const periodStart = `${y}-${m}-01`;
  const periodEnd = now.toISOString().split("T")[0]!;
  const calendarMonth = now.getUTCMonth() + 1;
  const calendarYear = now.getUTCFullYear();
  const runId = randomUUID();

  await Promise.all(
    Object.entries(results).map(async ([wardSlug, snapshot]) => {
      if (!snapshot || snapshot.vci == null) return;
      const wardId = wardIdForTenant(wardSlug);
      const wrote = await persistSatelliteVciSnapshot(wardId, {
        periodStart,
        periodEnd,
        calendarMonth,
        calendarYear,
        ndviMean: snapshot.ndvi_now,
        ndviMin: snapshot.ndvi_min,
        ndviMax: snapshot.ndvi_max,
        vciValue: snapshot.vci,
        prosopisCorrected: true,
        runId,
      });
      if (wrote) {
        logger.info(
          { wardId, wardSlug, vci: snapshot.vci },
          "[SatelliteJob] VCI snapshot persisted",
        );
      }
    }),
  );
}

/**
 * Run the satellite refresh job.
 *
 * Calls the engine's `/api/v1/satellite/trigger` endpoint and logs results.
 * Handles GEE errors gracefully without throwing.
 */
export async function runSatelliteJob(): Promise<void> {
  if (!enabled) {
    logger.info("[SatelliteJob] Job disabled via SATELLITE_JOB_ENABLED=false");
    return;
  }

  const startTime = Date.now();
  logger.info(
    { wards: DEMO_WARDS, schedule: getScheduleDescription() },
    "[SatelliteJob] Starting satellite refresh",
  );

  try {
    const result = await triggerSatelliteRefresh(false);

    if (!result) {
      logger.warn(
        "[SatelliteJob] Engine unreachable — satellite refresh failed",
      );
      return;
    }

    const duration = Date.now() - startTime;

    if (result.status === "success") {
      logger.info(
        {
          status: result.status,
          wards: result.wards,
          duration,
          results: result.results
            ? Object.fromEntries(
                Object.entries(result.results).map(([k, v]) => [
                  k,
                  { vci: v?.vci ?? null },
                ]),
              )
            : null,
        },
        "[SatelliteJob] Refresh completed successfully",
      );

      // Persist VCI snapshots to satellite_indices so vci_value is set
      // at write time. The hourly backfill job will find nothing to patch
      // for rows we write here. Runs only when Supabase is configured.
      if (isSupabaseConfigured() && result.results) {
        await persistVciSnapshots(result.results);
      }
    } else {
      logger.warn(
        { status: result.status, error: result.error, duration },
        "[SatelliteJob] Refresh completed with errors",
      );
    }
  } catch (err) {
    logger.error({ err }, "[SatelliteJob] Refresh failed with exception");
    // Don't throw — we want the scheduler to continue running
  }
}

/**
 * Start the satellite refresh job on a seasonal schedule.
 *
 * The first run happens immediately, then subsequent runs follow the
 * seasonal interval (weekly in dry season, monthly in wet season).
 */
export function startSatelliteJob(): void {
  if (satelliteTimer) {
    logger.warn("[SatelliteJob] Job already running — stopping previous timer");
    stopSatelliteJob();
  }

  enabled = process.env.SATELLITE_JOB_ENABLED !== "false";

  if (!enabled) {
    logger.info("[SatelliteJob] Job disabled — will not start");
    return;
  }

  const interval = getSeasonalInterval();

  // Run immediately on startup
  void runSatelliteJob().then(() => {
    // Schedule subsequent runs
    satelliteTimer = setInterval(() => {
      void runSatelliteJob();
    }, interval);

    logger.info(
      { interval, schedule: getScheduleDescription() },
      "[SatelliteJob] Scheduled next run",
    );
  });
}

/**
 * Stop the satellite refresh job.
 *
 * Clears the interval timer. Use this for tests or when shutting down.
 */
export function stopSatelliteJob(): void {
  if (satelliteTimer) {
    clearInterval(satelliteTimer);
    satelliteTimer = null;
    logger.info("[SatelliteJob] Job stopped");
  }
}

/**
 * Check if the satellite job is currently enabled.
 */
export function isSatelliteJobEnabled(): boolean {
  return enabled;
}
