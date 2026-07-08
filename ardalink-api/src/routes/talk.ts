/**
 * Public /api/talk/* — the endpoints powering the /talk browser app.
 *
 * The /talk page is served publicly (no bearer JWT) because any herder,
 * partner, or funder should be able to leave a report from a link. So
 * these endpoints:
 *
 *   1. Live under a semantically-clean namespace (not /api/demo/*) so
 *      the code doesn't imply "internal only".
 *   2. Are listed in PUBLIC_PATHS in `middlewares/tenant.ts`.
 *   3. Reuse the deterministic pipeline components already used for the
 *      demo simulator and the real AT herder flow. There is only one
 *      Speech → LLM → ground-truth path; every surface funnels into it.
 *   4. Rate-limit per phone (in-process) so a scraper can't burn Azure
 *      Speech and GPT-5 Mini credit by looping /record.
 */

import {
  Router,
  type IRouter,
  type Request,
  type Response,
} from "express";
import { groundTruthReportsTable } from "@workspace/db";
import { logger } from "../lib/logger.js";
import {
  buildLocalizedBrief,
  buildLocalizedVoiceOpener,
  resolveHerderContext,
} from "../lib/herderContext.js";
import { fastTranscribe, isSpeechConfigured } from "../lib/speech.js";
import { extractIndicators, generateActionTag } from "../lib/openai.js";
import { getLastResult } from "../lib/intelligence.js";
import { computeTrustScore, logTrustScore } from "../lib/trustScore.js";
import { withTenantContext } from "../lib/tenancy-context.js";
import { touchPastoralistLastContact } from "../lib/pastoralistContact.js";
import {
  insertGroundTruthCall,
  isSupabaseConfigured,
  pastoralistByPhone,
} from "../lib/supabase.js";

const router: IRouter = Router();

const PUBLIC_TENANT_ID =
  process.env.DETERMINISTIC_TENANT_ID ?? "bula-pesa";

// In-process rate limit: 3 recordings per phone per hour. Cheap, resets
// on process restart, and lets legitimate testers try the flow multiple
// times without instantly getting locked out.
const RECORDING_LIMIT_PER_HOUR = parseInt(
  process.env.TALK_RECORD_LIMIT_PER_HOUR ?? "3",
  10,
);
const RECORDING_WINDOW_MS = 60 * 60 * 1000;
const recordingHistory = new Map<string, number[]>();

function rateLimitCheck(phone: string): {
  ok: boolean;
  retryAfterSeconds?: number;
} {
  const now = Date.now();
  const history = (recordingHistory.get(phone) ?? []).filter(
    (t) => now - t < RECORDING_WINDOW_MS,
  );
  recordingHistory.set(phone, history);
  if (history.length >= RECORDING_LIMIT_PER_HOUR) {
    const oldest = history[0];
    return {
      ok: false,
      retryAfterSeconds: Math.ceil((RECORDING_WINDOW_MS - (now - oldest)) / 1000),
    };
  }
  history.push(now);
  return { ok: true };
}

/**
 * GET /api/talk/context?phone=+254…
 *
 * Look up the herder's profile (if we've spoken with them before), their
 * most recent ground-truth report, and the current ward-level satellite
 * intelligence. Used by the /talk browser app to build a personalized
 * opener + brief before recording.
 */
router.get("/talk/context", async (req: Request, res: Response): Promise<void> => {
  const phone = String(req.query.phone ?? "").trim();
  if (!phone) {
    res.status(400).json({ error: "phone-required" });
    return;
  }
  try {
    const ctx = await resolveHerderContext(phone, PUBLIC_TENANT_ID);
    res.json({
      ctx,
      opener: buildLocalizedVoiceOpener(ctx),
      briefSw: buildLocalizedBrief(ctx, "sw"),
      briefEn: buildLocalizedBrief(ctx, "en"),
    });
  } catch (err) {
    logger.error({ err, phone }, "[Talk] context lookup failed");
    res.status(500).json({ error: "context_lookup_failed" });
  }
});

function indicatorLabelFromCategory(id: string): string {
  switch (id) {
    case "bcs":
      return "body condition score";
    case "water_point":
      return "water-point status";
    case "mortality":
      return "mortality";
    case "feeding":
      return "supplementary feeding";
    case "milk":
      return "milk production";
    case "water_trek":
      return "water trek distance";
    default:
      return "drought indicator";
  }
}

/**
 * POST /api/talk/record?phone=+254…&category=bcs
 *
 * Raw audio bytes (any MediaRecorder container) → Azure Speech →
 * GPT-5 Mini indicator extraction → ground_truth_reports row (RLS-scoped
 * to `PUBLIC_TENANT_ID`). Same pipeline as real herder phone calls.
 */
router.post("/talk/record", async (req: Request, res: Response): Promise<void> => {
  if (!isSpeechConfigured()) {
    res.status(503).json({ error: "speech-not-configured" });
    return;
  }
  const phone = String(req.query.phone ?? "").trim();
  const category = String(req.query.category ?? "drought_signal");
  const categoryLabel = indicatorLabelFromCategory(category);

  const rateKey = phone || "anonymous";
  const rate = rateLimitCheck(rateKey);
  if (!rate.ok) {
    res.status(429).json({
      error: "rate_limited",
      retryAfterSeconds: rate.retryAfterSeconds,
    });
    return;
  }

  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(Buffer.from(c)));
  await new Promise<void>((resolve, reject) => {
    req.on("end", () => resolve());
    req.on("error", (err) => reject(err));
  });
  const audio = Buffer.concat(chunks);
  if (audio.length === 0) {
    res.status(400).json({ error: "audio-required" });
    return;
  }
  const contentType =
    (req.header("content-type") ?? "").split(";")[0]?.trim() || "audio/webm";

  logger.info(
    { bytes: audio.length, contentType, category, phone: phone || "anon" },
    "[Talk] recording received",
  );

  const stt = await fastTranscribe(audio, contentType, {
    filename: "talk-app.webm",
  });
  if (!stt || !stt.transcript) {
    res.status(422).json({
      error: "transcription-empty",
      contentType,
      bytes: audio.length,
    });
    return;
  }

  const last = getLastResult();
  const month =
    last?.month_name ??
    new Date().toLocaleString("en", { month: "short" }).toUpperCase();
  const userFeedback = `User (${categoryLabel}): ${stt.transcript}`;

  const [actionTag, indicators] = await Promise.all([
    last?.delta
      ? generateActionTag(stt.transcript, {
          aiQuestion: `${categoryLabel} voice report`,
          month,
          delta: last.delta,
        })
      : Promise.resolve("Public Talk Report"),
    extractIndicators(userFeedback),
  ]);

  const ndvi = last?.delta?.NDVI.live ?? null;
  const ndviPct = last?.delta?.NDVI.delta_pct ?? null;
  const cl30 = last?.climate?.rolling30Day;
  const rainfall = cl30?.totalPrecipMm ?? null;
  const et0 = cl30?.totalET0Mm ?? null;
  const soilMoisture = cl30?.meanSoilMoisture ?? null;
  const ratio =
    rainfall != null && et0 != null && et0 > 0 ? rainfall / et0 : null;
  const completenessPct = indicators
    ? (indicators.indicators_collected / 7) * 100
    : null;

  const trust = computeTrustScore({
    indicators,
    wardAnomalyPct: last?.live?.anomaly?.NDVI?.p50 ?? null,
    callDurationSeconds: null,
    endReason: "unknown",
  });

  try {
    const [report] = await withTenantContext(PUBLIC_TENANT_ID, (tx) =>
      tx
        .insert(groundTruthReportsTable)
        .values({
          tenantId: PUBLIC_TENANT_ID,
          phone: phone || "public-talk",
          month,
          timestamp: new Date(),
          satelliteMetrics: last?.delta ?? null,
          aiQuestion: `${categoryLabel} voice report`,
          userFeedback,
          actionTag,
          recordingUrl: null,
          durationSeconds: null,
          bcsScore: indicators?.bcs_score ?? null,
          bcsRawResponse: indicators?.bcs_raw_response ?? null,
          bcsSpecies: indicators?.bcs_species ?? null,
          bcsConfidence: indicators?.bcs_confidence ?? null,
          bcsFlagFollowup: indicators?.bcs_flag_followup ?? null,
          offtakeRate: indicators?.offtake_rate ?? null,
          offtakeRawResponse: indicators?.offtake_raw_response ?? null,
          mortalityRate: indicators?.mortality_rate ?? null,
          mortalityRawResponse: indicators?.mortality_raw_response ?? null,
          milkProduction: indicators?.milk_production ?? null,
          milkRawResponse: indicators?.milk_raw_response ?? null,
          waterTrekkingDistance: indicators?.water_trekking_distance ?? null,
          waterTrekkingRaw: indicators?.water_trekking_raw ?? null,
          waterPointName: indicators?.water_point_name ?? null,
          waterPointStatus: indicators?.water_point_status ?? null,
          waterPointRawResponse: indicators?.water_point_raw_response ?? null,
          supplementaryFeeding: indicators?.supplementary_feeding ?? null,
          supplementaryRawResponse:
            indicators?.supplementary_raw_response ?? null,
          reportedQuadrant: indicators?.reported_quadrant ?? null,
          reportedLocation: indicators?.reported_location ?? null,
          ndviScore: ndvi,
          ndviVsBaselinePercent: ndviPct,
          rainfall30dayMm: rainfall,
          soilMoistureIndex: soilMoisture,
          evaporationRate: et0,
          rainfallEvapRatio: ratio,
          indicatorsCollected: indicators?.indicators_collected ?? null,
          dataCompletenessPercent: completenessPct,
          callDurationSeconds: null,
          trustScore: trust.score,
          trustFlags: trust.flags,
        })
        .returning(),
    );

    logTrustScore(phone || "public-talk", report?.id ?? null, trust);
    if (phone) {
      await touchPastoralistLastContact(phone);
    }
    logger.info(
      {
        id: report?.id,
        category,
        phone: phone || "anon",
        bcs: indicators?.bcs_score,
        collected: indicators?.indicators_collected,
        trustScore: trust.score,
      },
      "[Talk] ground truth stored (local mirror)",
    );

    // Supabase mirror — thin ground_truth_calls row. Non-blocking.
    // Only mirrors when the pastoralist already exists on Supabase (i.e.
    // has been enrolled out-of-band). We do NOT auto-upsert profiles —
    // the pilot isn't live yet and pastoralists must not be auto-created.
    if (isSupabaseConfigured() && phone) {
      const past = await pastoralistByPhone(phone);
      if (!past || !past.ward_id) {
        // Skip the Supabase mirror silently. The local rich row is the
        // source of truth until the pilot enrolls this herder.
        res.json({
          ok: true,
          reportId: report?.id ?? null,
          transcript: stt.transcript,
          detectedLocale: stt.locale ?? null,
          actionTag,
          indicators,
          trustScore: trust.score,
          indicatorsCollected: indicators?.indicators_collected ?? 0,
          dataCompletenessPercent: completenessPct,
          herderContext: phone
            ? await resolveHerderContext(phone, PUBLIC_TENANT_ID)
            : null,
        });
        return;
      }
      const wardId = past.ward_id;
      const trekKm =
        indicators?.water_trekking_distance === "under_5km"
          ? 2.5
          : indicators?.water_trekking_distance === "5-10km"
            ? 7.5
            : indicators?.water_trekking_distance === "over_10km"
              ? 12
              : null;
      // Supabase mortality_rate + offtake_rate are proportions [0,1].
      const mortalityNum =
        indicators?.mortality_rate === "4-plus"
          ? 0.15
          : indicators?.mortality_rate === "1-3"
            ? 0.05
            : indicators?.mortality_rate === "none"
              ? 0
              : null;
      const offtakeNum =
        indicators?.offtake_rate === "early"
          ? 0.6
          : indicators?.offtake_rate === "normal"
            ? 0.3
            : indicators?.offtake_rate === "not_selling"
              ? 0
              : null;
      void insertGroundTruthCall({
        pastoralist_id: past.pastoralist_id,
        ward_id: wardId,
        call_timestamp: new Date().toISOString(),
        bcs_score: indicators?.bcs_score ?? null,
        mortality_rate: mortalityNum,
        offtake_rate: offtakeNum,
        water_point_status: indicators?.water_point_status ?? null,
        water_trek_distance_km: trekKm,
        supplementary_feeding:
          indicators?.supplementary_feeding === "yes"
            ? true
            : indicators?.supplementary_feeding === "no"
              ? false
              : null,
        trust_score:
          trust.score != null
            ? Math.max(0, Math.min(1, trust.score / 100))
            : null,
        source_language:
          stt.locale && stt.locale.startsWith("sw") ? "sw" : "en",
        transcript: stt.transcript,
      }).then((r) => {
        if (r)
          logger.info(
            { call_id: r.call_id, wardId },
            "[Talk] Supabase mirror ok",
          );
      });
    }

    const ctx = phone ? await resolveHerderContext(phone, PUBLIC_TENANT_ID) : null;

    res.json({
      ok: true,
      reportId: report?.id ?? null,
      transcript: stt.transcript,
      detectedLocale: stt.locale ?? null,
      actionTag,
      indicators,
      trustScore: trust.score,
      indicatorsCollected: indicators?.indicators_collected ?? 0,
      dataCompletenessPercent: completenessPct,
      herderContext: ctx,
    });
  } catch (err) {
    logger.error({ err }, "[Talk] ground-truth insert failed");
    res.status(500).json({ error: "insert_failed" });
  }
});

export default router;
