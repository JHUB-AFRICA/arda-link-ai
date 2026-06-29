import { fetchClimateSnapshot } from "./climate.js";
import { computeForecast } from "./predict.js";
import {
  getLastResult,
  setLastResult,
  applyClimateRefresh,
  runIntelligenceCycle,
} from "./intelligence.js";
import {
  loadLatestSatelliteSnapshot,
  loadLatestClimateSnapshot,
  saveClimateSnapshot,
} from "./snapshotCache.js";
import { warmSatelliteWaterBodies } from "./waterBodies.js";
import { logger } from "./logger.js";

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

let climateTimer: NodeJS.Timeout | null = null;
let satelliteTimer: NodeJS.Timeout | null = null;

/**
 * Refresh just the climate + 14-day vegetation forecast. Cheap (~1s of HTTP).
 * Updates the in-memory IntelligenceResult and persists to climate_snapshots.
 */
async function refreshClimate(): Promise<void> {
  const last = getLastResult();
  if (!last) {
    logger.warn(
      "[Scheduler] Climate refresh skipped — no satellite result loaded yet",
    );
    return;
  }
  try {
    const climate = await fetchClimateSnapshot();
    const forecast = await computeForecast({
      stressedPixelPct: last.live.anomaly.wardStressedPixelPct,
      worstQuadrant: last.live.anomaly.worstQuadrant,
      currentMAI: climate.rolling30Day.moistureAdequacyIndex,
      month: last.month,
    }).catch((err) => {
      logger.warn({ err }, "[Scheduler] Forecast compute failed");
      return undefined;
    });
    applyClimateRefresh(climate, forecast);
    await saveClimateSnapshot(climate, forecast);
    logger.info(
      {
        mai: climate.rolling30Day.moistureAdequacyIndex,
        drought: climate.rolling30Day.droughtSeverity,
        risk: forecast?.outlook.riskLevel,
      },
      "[Scheduler] Climate + forecast refreshed",
    );
  } catch (err) {
    logger.error({ err }, "[Scheduler] Climate refresh failed");
  }
}

/**
 * Refresh the full satellite analysis. Only re-runs when:
 *   - no snapshot exists, OR
 *   - the cached newest image date is older than 7 days (safety ceiling), OR
 *   - the user manually triggered via /api/trigger-check.
 *
 * Earth Engine returns the same image set if no new Sentinel-2 pass has happened,
 * which is why we gate by cached image date rather than wall-clock time.
 */
async function refreshSatelliteIfStale(): Promise<void> {
  const last = getLastResult();
  const newestImageDateStr =
    last?.live?.imageDates?.[last.live.imageDates.length - 1];
  const now = Date.now();
  const imageAgeMs = newestImageDateStr
    ? now - new Date(newestImageDateStr).getTime()
    : Infinity;
  const stale = !last || imageAgeMs > SEVEN_DAYS_MS;
  if (!stale) {
    logger.info(
      { newestImageDate: newestImageDateStr },
      "[Scheduler] Satellite snapshot still fresh — skipping GEE run",
    );
    return;
  }
  logger.info(
    { newestImageDate: newestImageDateStr ?? null, imageAgeMs },
    "[Scheduler] Satellite snapshot stale — running pipeline",
  );
  try {
    await runIntelligenceCycle("", { dryRun: true, forceAlert: false });
  } catch (err) {
    logger.error({ err }, "[Scheduler] Satellite refresh failed");
  }
}

/**
 * Hydrate the in-memory IntelligenceResult from PostgreSQL on boot so the
 * very first incoming call has full satellite + climate context, even if
 * Earth Engine is slow or offline.
 */
export async function hydrateFromCache(): Promise<void> {
  const [sat, clim] = await Promise.all([
    loadLatestSatelliteSnapshot(),
    loadLatestClimateSnapshot(),
  ]);
  if (sat) {
    // Prefer fresher climate/forecast over what was persisted with the
    // satellite snapshot, since climate refreshes 4x more often.
    if (clim) {
      sat.climate = clim.climate;
      sat.forecast = clim.forecast;
    }
    setLastResult(sat);
    logger.info(
      {
        newestImageDate:
          sat.live.imageDates[sat.live.imageDates.length - 1] ?? null,
        climateCapturedAt: clim?.capturedAt ?? null,
      },
      "[Scheduler] Hydrated in-memory state from PostgreSQL cache",
    );
  } else {
    logger.info("[Scheduler] No cached snapshot found — first boot");
  }
}

/**
 * Boot the cache + scheduler:
 *   1. Hydrate from PostgreSQL so getLastResult() returns immediately.
 *   2. Kick off a satellite refresh if cache is empty/stale.
 *   3. Run climate refresh now and every 6h.
 *   4. Re-check satellite freshness every 24h.
 */
export async function startScheduler(): Promise<void> {
  // Hydrate is best-effort. If Postgres is unreachable or the cache is
  // missing (cold start), log and continue — the setInterval timers
  // below MUST always get installed, otherwise Node sees no pending
  // I/O and exits silently.
  try {
    await hydrateFromCache();
  } catch (err) {
    logger.warn(
      { err },
      "[Scheduler] hydrateFromCache failed — continuing without cached state",
    );
  }

  // Fire-and-forget initial refreshes — never block server startup.
  void refreshSatelliteIfStale().then(
    () => {
      // Climate depends on having a satellite snapshot for forecast inputs.
      void refreshClimate().catch((err) =>
        logger.warn(
          { err },
          "[Scheduler] initial refreshClimate failed",
        ),
      );
    },
    (err) =>
      logger.warn(
        { err },
        "[Scheduler] initial refreshSatelliteIfStale failed",
      ),
  );

  // Warm the satellite water-bodies cache in the background so the first
  // incoming call doesn't pay the ~6s Earth Engine cold-start cost.
  void warmSatelliteWaterBodies();

  climateTimer = setInterval(() => {
    void refreshClimate();
  }, SIX_HOURS_MS);

  satelliteTimer = setInterval(() => {
    void refreshSatelliteIfStale();
  }, TWENTY_FOUR_HOURS_MS);

  logger.info(
    {
      climateEveryMs: SIX_HOURS_MS,
      satelliteCheckEveryMs: TWENTY_FOUR_HOURS_MS,
    },
    "[Scheduler] Background refresh loops started",
  );
}

export function stopScheduler(): void {
  if (climateTimer) clearInterval(climateTimer);
  if (satelliteTimer) clearInterval(satelliteTimer);
  climateTimer = null;
  satelliteTimer = null;
}
