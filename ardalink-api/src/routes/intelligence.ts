import { Router, type IRouter } from "express";
import {
  runIntelligenceCycle,
  getLastResult,
  getIsRunning,
} from "../lib/intelligence.js";
import { computeForecast } from "../lib/predict.js";

const router: IRouter = Router();

/**
 * POST /api/trigger-check
 *
 * Body params:
 *   phone       {string}  — phone number to call (falls back to RECIPIENT_PHONE env var)
 *   dryRun      {boolean} — run satellite + AI steps but skip the actual AT call
 *   forceAlert  {boolean} — bypass the 15% threshold and run the full alert phase anyway
 *
 * Examples:
 *   Dry run (no phone needed):  { "dryRun": true, "forceAlert": true }
 *   Real call:                  { "phone": "+254711XXXXXX" }
 *   Force alert + real call:    { "phone": "+254711XXXXXX", "forceAlert": true }
 */
router.post("/trigger-check", async (req, res): Promise<void> => {
  const body = req.body as {
    phone?: string;
    dryRun?: boolean;
    forceAlert?: boolean;
  };

  const dryRun = body.dryRun === true;
  const forceAlert = body.forceAlert === true;
  const phone: string = body.phone ?? process.env.RECIPIENT_PHONE ?? "";

  if (!dryRun && !phone) {
    res.status(400).json({
      error:
        'A target phone number is required for a real call. Pass "phone" in the request body, set the RECIPIENT_PHONE env var, or use "dryRun": true to test without calling.',
    });
    return;
  }

  if (getIsRunning()) {
    res.status(409).json({
      error: "Intelligence cycle already running — try again shortly.",
    });
    return;
  }

  req.log.info(
    { phone: phone || "(dry run)", dryRun, forceAlert },
    "Intelligence cycle triggered",
  );

  try {
    const result = await runIntelligenceCycle(phone, { dryRun, forceAlert });
    res.json(result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    req.log.error({ err }, "Intelligence cycle failed");
    res.status(500).json({ error: message });
  }
});

/**
 * GET /api/status
 * Returns the result of the last intelligence cycle run.
 */
router.get("/status", (_req, res): void => {
  res.json({
    is_running: getIsRunning(),
    last_run: getLastResult(),
  });
});

/**
 * GET /api/forecast
 *
 * Returns a fresh 14-day vegetation stress forecast using the satellite state
 * from the most recent trigger-check run.
 *
 * Fetches two things in real-time (fast, no EE):
 *   1. 14-day weather forecast from Open-Meteo
 *   2. Next-month NDVI baseline from Cosmos DB monthly_baselines
 *
 * Requires at least one prior POST /api/trigger-check (or dryRun) to have run
 * so that satellite pixel data is available in memory.
 */
router.get("/forecast", async (req, res): Promise<void> => {
  const last = getLastResult();

  if (!last) {
    // Return 200 with an empty payload + a note so the dashboard
    // doesn't log a 404 every time it polls. The dashboard renders
    // nothing where forecast would be when `forecast == null`.
    res.json({
      forecast: null,
      note: "No satellite data available yet. Run POST /api/trigger-check (with dryRun: true) to populate the baseline.",
      basedOnSatelliteRunAt: null,
    });
    return;
  }

  // The intelligence cycle populates `last.live.anomaly` only when the
  // engine baseline has enough rows to compute a per-pixel comparison.
  // In a fresh engine (or when Supabase satellite_indices lags) the
  // anomaly block can be missing entirely — reading .anomaly then
  // 500s. Fall back to the same 200-with-note posture as `!last`.
  const anomaly = last.live?.anomaly;
  if (!anomaly) {
    res.json({
      forecast: null,
      note: "Satellite baseline not yet available for this ward. The intelligence cycle is running — check back after the next trigger.",
      basedOnSatelliteRunAt: last.timestamp ?? null,
    });
    return;
  }

  try {
    const forecast = await computeForecast({
      stressedPixelPct: anomaly.wardStressedPixelPct,
      worstQuadrant: anomaly.worstQuadrant,
      currentMAI: last.climate?.rolling30Day.moistureAdequacyIndex ?? 0.5,
      month: last.month,
    });

    req.log.info(
      {
        riskLevel: forecast.outlook.riskLevel,
        stressDirection: forecast.outlook.stressDirection,
        forecastMAI: forecast.forecast14d.forecastMAI,
        estimatedRecoveryDays: forecast.outlook.estimatedRecoveryDays,
      },
      "Forecast computed",
    );

    res.json({
      basedOnSatelliteRunAt: last.timestamp,
      stressedPixelPct: anomaly.wardStressedPixelPct,
      worstQuadrant: anomaly.worstQuadrant,
      currentMAI: last.climate?.rolling30Day.moistureAdequacyIndex,
      forecast,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    req.log.error({ err }, "Forecast computation failed");
    res.status(500).json({ error: message });
  }
});

export default router;
