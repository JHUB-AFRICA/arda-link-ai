import { fetchLiveVegetation, type LiveVegetation } from "./satellite.js";
import {
  getMonthlyBaseline,
  calculateDelta,
  type VegetationDelta,
} from "./baseline.js";
import {
  generateScript,
  type GeneratedScript,
  type PixelContext,
} from "./openai/index.js";
import { initiateCall, storeCallSession } from "./voice.js";
import { fetchClimateSnapshot, type ClimateSnapshot } from "./climate.js";
import { computeForecast, type VegetationForecast } from "./predict.js";
import { saveSatelliteSnapshot } from "./snapshotCache.js";
import { fetchSatelliteVCI, type VCISnapshot } from "./engine.js";
import { logger } from "./logger.js";

export interface IntelligenceResult {
  timestamp: string;
  month: number;
  month_name: string;
  live: LiveVegetation;
  delta: VegetationDelta;
  triggered: boolean;
  climate?: ClimateSnapshot;
  forecast?: VegetationForecast;
  script?: GeneratedScript;
  call_initiated?: boolean;
  dry_run?: boolean;
  skip_reason?: string;
  /** VCI data from GEE engine — optional, degrades gracefully */
  vci?: VCISnapshot;
}

// Re-export VCISnapshot from engine for public API consumers
export type { VCISnapshot } from "./engine.js";

export interface CycleOptions {
  /** Skip making the actual phone call — run everything else and return results. */
  dryRun?: boolean;
  /**
   * Force the alert phase even if vegetation is within normal range.
   * Useful for testing the script generation and call flow end-to-end.
   */
  forceAlert?: boolean;
}

const MONTH_NAMES = [
  "JAN",
  "FEB",
  "MAR",
  "APR",
  "MAY",
  "JUN",
  "JUL",
  "AUG",
  "SEP",
  "OCT",
  "NOV",
  "DEC",
];

let lastResult: IntelligenceResult | null = null;
let isRunning = false;

export const getLastResult = () => lastResult;
export const getIsRunning = () => isRunning;

/** Set by the scheduler on boot when hydrating from PostgreSQL cache. */
export function setLastResult(result: IntelligenceResult): void {
  lastResult = result;
}

/**
 * Patch the in-memory result with freshly refreshed climate + forecast
 * (called by the 6-hour scheduler). Keeps the heavy satellite analysis
 * intact while swapping in current weather context.
 */
export function applyClimateRefresh(
  climate: ClimateSnapshot,
  forecast: VegetationForecast | undefined,
): void {
  if (!lastResult) return;
  lastResult = { ...lastResult, climate, forecast };
}

export async function runIntelligenceCycle(
  phone: string,
  options: CycleOptions = {},
): Promise<IntelligenceResult> {
  if (isRunning) throw new Error("Intelligence cycle already running");
  isRunning = true;

  const { dryRun = false, forceAlert = false } = options;

  const now = new Date();
  const month = now.getMonth() + 1;
  const month_name = MONTH_NAMES[month - 1]!;

  if (dryRun)
    logger.info("[DRY RUN] Call will be skipped — all analysis steps run");
  if (forceAlert)
    logger.info("[FORCE ALERT] Trigger threshold bypassed for testing");

  try {
    // ── Steps 1 + 1b: Satellite pixel analysis AND climate snapshot (parallel) ─
    logger.info(
      { month, month_name },
      "[Satellite Check] Starting pixel-level analysis + climate fetch",
    );
    const [live, climate, vci] = await Promise.all([
      fetchLiveVegetation(),
      fetchClimateSnapshot().catch((err) => {
        logger.warn(
          { err },
          "[Climate] Fetch failed — continuing without climate data",
        );
        return undefined;
      }),
      // Fetch VCI from the engine's GEE endpoint — optional, degrades gracefully
      fetchSatelliteVCI("bula-pesa").catch((err) => {
        logger.warn(
          { err },
          "[GEE VCI] Fetch failed — continuing without VCI data",
        );
        return undefined;
      }),
    ]);

    logger.info(
      {
        NDVI: live.NDVI,
        stressedPixelPct: live.anomaly.wardStressedPixelPct,
        medianAnomalyPct: live.anomaly.NDVI.p50,
        worstQuadrant: live.anomaly.worstQuadrant,
        baselineSource: live.anomaly.baselineSource,
        currentImages: live.imageCount,
        imageDates: live.imageDates,
        climateTempC: climate?.current.temperatureC,
        climateMAI: climate?.rolling30Day.moistureAdequacyIndex,
        climateDrought: climate?.rolling30Day.droughtSeverity,
        climatePrecip30d: climate?.rolling30Day.totalPrecipMm,
      },
      "[Satellite+Climate] Analysis complete",
    );

    // ── Steps 2 + 2b: Baseline match AND 14-day forecast (parallel) ──────────
    logger.info(
      { month, month_name },
      "[Baseline Match] Fetching ward baseline + 14-day forecast",
    );
    // Resolve tenant slug → ward display name once, share across both calls.
    const { TENANT_HOME_WARD } = await import("./geoHelpers.js");
    const homeWardName = TENANT_HOME_WARD["bula-pesa"] ?? "Bulla Pesa";
    const [baseline, forecast] = await Promise.all([
      getMonthlyBaseline(month, homeWardName),
      computeForecast({
        stressedPixelPct: live.anomaly.wardStressedPixelPct,
        worstQuadrant: live.anomaly.worstQuadrant,
        currentMAI: climate?.rolling30Day.moistureAdequacyIndex ?? 0.5,
        month,
      }).catch((err) => {
        logger.warn(
          { err },
          "[Forecast] Compute failed — continuing without forecast",
        );
        return undefined;
      }),
    ]);

    // ── Step 3: Dual-signal trigger evaluation ─────────────────────────────
    const delta = calculateDelta(live, baseline);

    logger.info(
      {
        pixelTrigger: delta.pixelTrigger,
        wardMeanTrigger: delta.wardMeanTrigger,
        triggered: delta.triggered,
        forced: forceAlert,
        reason: delta.trigger_reason,
      },
      "[Detection Trigger] Dual-signal evaluation",
    );

    const result: IntelligenceResult = {
      timestamp: now.toISOString(),
      month,
      month_name,
      live,
      delta,
      triggered: delta.triggered || forceAlert,
      climate: climate ?? undefined,
      forecast: forecast ?? undefined,
      vci: vci ?? undefined,
      dry_run: dryRun || undefined,
    };

    const shouldAlert = delta.triggered || forceAlert;

    if (!shouldAlert) {
      result.skip_reason = delta.trigger_reason;
      logger.info(
        { skip_reason: result.skip_reason },
        "No alert triggered — vegetation within normal range",
      );
      lastResult = result;
      void saveSatelliteSnapshot(result);
      return result;
    }

    // ── Step 4: AI Script Generation ───────────────────────────────────────
    // Pass pixel context so the script references specific numbers:
    // "34% of the ward is stressed", "SW quadrant is worst", etc.
    logger.info(
      "[AI Script Generation] Building ArdaLink script with pixel context",
    );

    // Derive drought class from VCI: VCI < 10 = extreme, 10-20 = severe, 20-35 = moderate, 35-50 = mild, > 50 = no_drought
    function vciToDroughtClass(vci: number): string {
      if (vci < 10) return "extreme";
      if (vci < 20) return "severe";
      if (vci < 35) return "moderate";
      if (vci < 50) return "mild";
      return "no_drought";
    }

    // Compute NDVI vs baseline percentage from VCI snapshot
    function ndviVsBaselinePct(vci: VCISnapshot): number {
      const { ndvi_now, ndvi_min, ndvi_max } = vci;
      if (ndvi_now == null || ndvi_max == null || ndvi_max === 0) return 0;
      // VCI formula: (NDVI_now - NDVI_min) / (NDVI_max - NDVI_min) * 100
      // We invert to show how far current is from max (baseline)
      return ((ndvi_now - ndvi_max) / Math.abs(ndvi_max)) * 100;
    }

    // Format image freshness as "X days ago" or date
    function formatImageFreshness(vci: VCISnapshot): string {
      const captured = new Date(vci.captured_at);
      const now = new Date();
      const daysAgo = Math.floor((now.getTime() - captured.getTime()) / (1000 * 60 * 60 * 24));
      if (daysAgo === 0) return "today";
      if (daysAgo === 1) return "yesterday";
      if (daysAgo < 7) return `${daysAgo} days ago`;
      return captured.toISOString().split("T")[0] ?? vci.captured_at;
    }

    const px: PixelContext = {
      wardStressedPixelPct: live.anomaly.wardStressedPixelPct,
      medianAnomalyPct: live.anomaly.NDVI.p50,
      p5AnomalyPct: live.anomaly.NDVI.p5,
      worstQuadrant: live.anomaly.worstQuadrant,
      historicalImageCount: 0, // engine's baseline_pixel grid used — no EE historical count
      ...(vci
        ? {
            satellite: {
              vci: vci.vci,
              droughtClass: vciToDroughtClass(vci.vci),
              ndviVsBaseline: ndviVsBaselinePct(vci),
              imageFreshness: formatImageFreshness(vci),
              urbanMasked: vci.urban_masked,
              prosopisFactor: vci.prosopis_factor,
            },
          }
        : undefined),
      ...(climate
        ? {
            climate: {
              tempC: climate.current.temperatureC,
              humidityPct: climate.current.humidityPct,
              totalPrecip30dMm: climate.rolling30Day.totalPrecipMm,
              rainyDays: climate.rolling30Day.rainyDays,
              meanSoilMoisture: climate.rolling30Day.meanSoilMoisture,
              moistureAdequacyIndex: climate.rolling30Day.moistureAdequacyIndex,
              droughtSeverity: climate.rolling30Day.droughtSeverity,
              totalET0Mm: climate.rolling30Day.totalET0Mm,
            },
          }
        : {}),
      ...(forecast
        ? {
            forecast: {
              totalPrecip14dMm: forecast.forecast14d.totalPrecipMm,
              totalET0_14dMm: forecast.forecast14d.totalET0Mm,
              effectiveRainMm: forecast.forecast14d.effectiveRainMm,
              forecastMAI: forecast.forecast14d.forecastMAI,
              rainyDays: forecast.forecast14d.rainyDays,
              stressDirection: forecast.outlook.stressDirection,
              riskLevel: forecast.outlook.riskLevel,
              seasonalTrend: forecast.seasonal.trend,
              estimatedRecoveryDays: forecast.outlook.estimatedRecoveryDays,
              recommendation: forecast.outlook.recommendation,
            },
          }
        : {}),
    };
    const script = await generateScript(delta, month_name, px);
    result.script = script;

    if (dryRun) {
      logger.info("[DRY RUN] Skipping Africa's Talking call");
      lastResult = result;
      void saveSatelliteSnapshot(result);
      return result;
    }

    // ── Step 5: Call Triggered ─────────────────────────────────────────────
    logger.info(
      { phone },
      "[Call Triggered] Storing session and initiating call",
    );
    storeCallSession(phone, {
      script: script.script,
      question: script.question,
      delta,
      month: month_name,
      climate: climate ?? undefined,
      forecast: forecast ?? undefined,
    });

    await initiateCall(phone);
    result.call_initiated = true;
    logger.info({ phone }, "[Call Triggered] Africa's Talking call dispatched");

    lastResult = result;
    void saveSatelliteSnapshot(result);
    return result;
  } finally {
    isRunning = false;
  }
}
