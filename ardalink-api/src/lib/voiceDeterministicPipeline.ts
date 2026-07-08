/**
 * Deterministic post-call voice pipeline (recording → transcript → indicators
 * → ground truth). This is the herder-facing production path — it does NOT
 * need Azure OpenAI Realtime, works with any chat deployment (`gpt-5-mini`
 * by default in our stack), and is robust on 2G because the whole flow is
 * a sequence of plain HTTP callbacks from Africa's Talking.
 *
 * Flow (called from POST /api/voice-callback after AT posts a recording URL):
 *
 *   1. Download the recording (AT hosts it briefly at a signed URL).
 *   2. Send to Azure Speech Fast Transcription with locales=[sw-KE, en-KE]
 *      so code-switching is detected automatically.
 *   3. Run the existing LLM indicator extractor + action tag generator
 *      through the provider-agnostic registry (currently Azure GPT-5 Mini).
 *   4. Snapshot the current satellite / climate context and write a full
 *      ground_truth_reports row with trust score.
 *   5. Bump `pastoralists.last_contact_at`.
 *
 * Failures are logged but never thrown — a broken transcription is worse
 * than no report, but a crashed handler would take down the whole callback
 * pipeline.
 */

import { groundTruthReportsTable } from "@workspace/db";
import { logger } from "./logger.js";
import { getLastResult } from "./intelligence.js";
import { extractIndicators, generateActionTag } from "./openai.js";
import { computeTrustScore, logTrustScore } from "./trustScore.js";
import { touchPastoralistLastContact } from "./pastoralistContact.js";
import { fastTranscribe, isSpeechConfigured } from "./speech.js";
import { withTenantContext } from "./tenancy-context.js";
import {
  insertGroundTruthCall,
  isSupabaseConfigured,
  pastoralistByPhone,
} from "./supabase.js";

// Demo/system tenant used for calls that don't have a JWT-derived tenant
// (browser demos, sandbox AT flows). Real herder calls should propagate the
// tenant from the operator who owns the pastoralist — that's Phase-2 work.
const DEFAULT_TENANT_ID =
  process.env.DETERMINISTIC_TENANT_ID ?? "bula-pesa";

export interface DeterministicPipelineInput {
  sessionId: string | null;
  phone: string | null;
  recordingUrl: string;
  durationSeconds: number | null;
  categoryId: string;
  categoryLabel: string;
}

interface DownloadedAudio {
  bytes: Uint8Array;
  contentType: string;
}

async function downloadRecording(
  recordingUrl: string,
): Promise<DownloadedAudio | null> {
  try {
    const res = await fetch(recordingUrl, {
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      logger.warn(
        { status: res.status, body: text.slice(0, 400), recordingUrl },
        "[Deterministic] Failed to download recording",
      );
      return null;
    }
    const ab = await res.arrayBuffer();
    const bytes = new Uint8Array(ab);
    const contentType =
      res.headers.get("content-type")?.split(";")[0]?.trim() || "audio/wav";
    if (bytes.length === 0) {
      logger.warn({ recordingUrl }, "[Deterministic] Recording is empty");
      return null;
    }
    return { bytes, contentType };
  } catch (err) {
    logger.error(
      { err, recordingUrl },
      "[Deterministic] Recording download failed",
    );
    return null;
  }
}

function parseDurationSeconds(raw: number | null): number | null {
  if (raw == null) return null;
  if (!Number.isFinite(raw) || raw <= 0) return null;
  return Math.round(raw);
}

/**
 * The main handler. Returns the inserted report id (or null on failure)
 * so callers can log / surface it in test scaffolding.
 */
export async function processDeterministicVoiceRecording(
  input: DeterministicPipelineInput,
): Promise<number | null> {
  if (!isSpeechConfigured()) {
    logger.warn(
      "[Deterministic] Azure Speech not configured — cannot transcribe",
    );
    return null;
  }

  const downloaded = await downloadRecording(input.recordingUrl);
  if (!downloaded) return null;

  const stt = await fastTranscribe(downloaded.bytes, downloaded.contentType, {
    locales: (process.env.AZURE_SPEECH_STT_LANGUAGES ?? "sw-KE,en-KE")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    filename: "call-audio.wav",
  });

  if (!stt || !stt.transcript) {
    logger.warn(
      {
        sessionId: input.sessionId,
        phone: input.phone,
        categoryId: input.categoryId,
      },
      "[Deterministic] Pipeline ended with no transcript",
    );
    return null;
  }

  const last = getLastResult();
  const month =
    last?.month_name ??
    new Date().toLocaleString("en", { month: "short" }).toUpperCase();
  const userFeedback = `User (${input.categoryLabel}): ${stt.transcript}`;

  const [actionTag, indicators] = await Promise.all([
    last?.delta
      ? generateActionTag(stt.transcript, {
          aiQuestion: `${input.categoryLabel} voice report`,
          month,
          delta: last.delta,
        })
      : Promise.resolve("Deterministic Voice Report"),
    extractIndicators(userFeedback),
  ]);

  // Snapshot satellite + climate context at the moment of the call so the
  // ground-truth row is self-contained for later analysis.
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
  const durationSeconds = parseDurationSeconds(input.durationSeconds);

  const trust = computeTrustScore({
    indicators,
    wardAnomalyPct: last?.live?.anomaly?.NDVI?.p50 ?? null,
    callDurationSeconds: durationSeconds,
    endReason: "unknown",
  });

  try {
    const [report] = await withTenantContext(DEFAULT_TENANT_ID, (tx) =>
      tx
        .insert(groundTruthReportsTable)
        .values({
          tenantId: DEFAULT_TENANT_ID,
          phone: input.phone ?? "deterministic-voice",
          month,
          timestamp: new Date(),
          satelliteMetrics: last?.delta ?? null,
          aiQuestion: `${input.categoryLabel} voice report`,
          userFeedback,
          actionTag,
          recordingUrl: input.recordingUrl,
          durationSeconds,
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
          callDurationSeconds: durationSeconds,
          trustScore: trust.score,
          trustFlags: trust.flags,
        })
        .returning(),
    );

    logTrustScore(input.phone ?? "deterministic", report?.id ?? null, trust);
    logger.info(
      {
        id: report?.id,
        actionTag,
        bcs: indicators?.bcs_score,
        category: input.categoryId,
        collected: indicators?.indicators_collected,
        trustScore: trust.score,
      },
      "[Deterministic] Ground truth stored (local mirror)",
    );

    // Best-effort: bump last-contact so the dashboard shows this pastoralist
    // was reached today. Never blocks the pipeline.
    await touchPastoralistLastContact(input.phone);

    // ─── Supabase mirror write ───────────────────────────────────────
    // Supabase is source of truth: also write a thin ground_truth_calls
    // row so downstream analytics and partner dashboards see the call.
    // Failures are logged but never block — the local row is our backup.
    if (isSupabaseConfigured() && input.phone) {
      void writeSupabaseMirror({
        phone: input.phone,
        tenantId: DEFAULT_TENANT_ID,
        indicators,
        trustScore: trust.score,
        transcript: stt.transcript,
        locale: stt.locale ?? null,
        sourceLanguage:
          stt.locale && stt.locale.startsWith("sw") ? "sw" : "en",
      });
    }

    return report?.id ?? null;
  } catch (err) {
    logger.error({ err }, "[Deterministic] Failed to insert ground-truth row");
    return null;
  }
}

interface SupabaseMirrorArgs {
  phone: string;
  tenantId: string;
  indicators: Awaited<ReturnType<typeof extractIndicators>>;
  trustScore: number | null;
  transcript: string;
  locale: string | null;
  sourceLanguage: string;
}

async function writeSupabaseMirror(args: SupabaseMirrorArgs): Promise<void> {
  try {
    // Only mirror to Supabase when a pastoralist row already exists there.
    // We do NOT auto-upsert pastoralists — that would create pilot-shaped
    // profile data before the pilot is enrolled. Enrollment happens on
    // Supabase side out-of-band; this path is a passive mirror.
    const past = await pastoralistByPhone(args.phone);
    if (!past) {
      logger.info(
        { phone: args.phone },
        "[Deterministic] Skipping Supabase mirror — pastoralist not yet enrolled",
      );
      return;
    }
    const wardId = past.ward_id ?? null;
    if (!wardId) {
      logger.warn(
        { phone: args.phone, pastoralist_id: past.pastoralist_id },
        "[Deterministic] Skipping Supabase mirror — enrolled pastoralist has no ward_id",
      );
      return;
    }
    const trekDistanceKm =
      args.indicators?.water_trekking_distance === "under_5km"
        ? 2.5
        : args.indicators?.water_trekking_distance === "5-10km"
          ? 7.5
          : args.indicators?.water_trekking_distance === "over_10km"
            ? 12
            : null;
    // Supabase mortality_rate + offtake_rate are proportions (0-1). Our
    // extractor returns categorical buckets; map them to representative
    // rates within [0,1] so the CHECK constraints pass.
    const mortalityRate =
      args.indicators?.mortality_rate === "4-plus"
        ? 0.15
        : args.indicators?.mortality_rate === "1-3"
          ? 0.05
          : args.indicators?.mortality_rate === "none"
            ? 0
            : null;
    const offtakeRate =
      args.indicators?.offtake_rate === "early"
        ? 0.6
        : args.indicators?.offtake_rate === "normal"
          ? 0.3
          : args.indicators?.offtake_rate === "not_selling"
            ? 0
            : null;
    // Supabase trust_score is a proportion [0,1]; our local score is 0-100.
    const trustScoreNorm =
      args.trustScore != null ? Math.max(0, Math.min(1, args.trustScore / 100)) : null;
    const result = await insertGroundTruthCall({
      pastoralist_id: past.pastoralist_id,
      ward_id: wardId,
      call_timestamp: new Date().toISOString(),
      bcs_score: args.indicators?.bcs_score ?? null,
      mortality_rate: mortalityRate,
      offtake_rate: offtakeRate,
      water_point_status: args.indicators?.water_point_status ?? null,
      water_trek_distance_km: trekDistanceKm,
      supplementary_feeding:
        args.indicators?.supplementary_feeding === "yes"
          ? true
          : args.indicators?.supplementary_feeding === "no"
            ? false
            : null,
      trust_score: trustScoreNorm,
      source_language: args.sourceLanguage,
      transcript: args.transcript,
    });
    if (result) {
      logger.info(
        {
          call_id: result.call_id,
          wardId,
          hasPastoralist: past != null,
        },
        "[Deterministic] Supabase ground_truth_calls mirror ok",
      );
    }
  } catch (err) {
    logger.warn({ err }, "[Deterministic] Supabase mirror write failed");
  }
}
