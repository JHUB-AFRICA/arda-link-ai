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

import { logger } from "./logger.js";
import { getLastResult } from "./intelligence.js";
import { extractIndicators, generateActionTag } from "./openai.js";
import { computeTrustScore, logTrustScore } from "./trustScore.js";
import { touchPastoralistLastContact } from "./pastoralistContact.js";
import { fastTranscribe, isSpeechConfigured } from "./speech.js";
import {
  insertGroundTruthCall,
  isSupabaseConfigured,
  pastoralistByPhone,
} from "./supabase.js";
import { mapExtractedIndicatorsToGroundTruthRow } from "./groundTruthMapping.js";
import { resolveHerderContext } from "./herderContext.js";
import { languageForCaller } from "./voiceCopy.js";
import { sendSmsViaAt } from "./africastalking.js";

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
    logTrustScore(input.phone ?? "deterministic", null, trust);
    logger.info(
      {
        actionTag,
        bcs: indicators?.bcs_score,
        category: input.categoryId,
        collected: indicators?.indicators_collected,
        trustScore: trust.score,
      },
      "[Deterministic] Ground truth processed",
    );

    // Best-effort: bump last-contact so the dashboard shows this pastoralist
    // was reached today. Never blocks the pipeline.
    await touchPastoralistLastContact(input.phone);

    // ─── Supabase write ──────────────────────────────────────────────
    // Supabase ground_truth_calls is the source of truth. Write the thin
    // row so downstream analytics and partner dashboards see the call.
    // Failures are logged but never block.
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

    // ─── Post-call SMS handoff — closes the voice loop ───────────────
    // Per the "no open loops" rule (2026-07-11), every completed voice
    // call ends by sending a summary SMS in the caller's language.
    // Skip when we don't know who the caller is (tier='unknown').
    if (input.phone) {
      void sendPostCallSummary({
        phone: input.phone,
        indicators,
        actionTag,
        reportId: null,
      });
    }

    return null;
  } catch (err) {
    logger.error({ err }, "[Deterministic] Failed to process ground-truth");
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

/**
 * Send a summary SMS after the voice call completes. Closes the loop
 * per the "no open loops" policy: caller walks away knowing exactly
 * what we recorded and gets a written record for their own reference.
 *
 * Language + tier are read from HerderContext. Unknown callers (no
 * verified pastoralist AND no lead row) are skipped so we don't spam
 * random numbers. Env kill switch SEND_POSTCALL_SMS=false stops the
 * dispatch entirely, useful during dry-run demos.
 */
interface PostCallSummaryArgs {
  phone: string;
  indicators: Awaited<ReturnType<typeof extractIndicators>>;
  actionTag: string | null;
  reportId: number | null;
}
async function sendPostCallSummary(args: PostCallSummaryArgs): Promise<void> {
  const enabled = (process.env.SEND_POSTCALL_SMS ?? "true")
    .trim()
    .toLowerCase();
  if (enabled === "false" || enabled === "0") {
    logger.info(
      { phone: args.phone, reportId: args.reportId },
      "[Deterministic] SEND_POSTCALL_SMS=false — skipping summary SMS",
    );
    return;
  }
  try {
    const ctx = await resolveHerderContext(args.phone, DEFAULT_TENANT_ID);
    if (ctx.tier === "unknown") {
      logger.info(
        { phone: args.phone },
        "[Deterministic] Skipping post-call SMS — caller tier=unknown",
      );
      return;
    }
    const lang = languageForCaller(ctx);
    const body = buildPostCallSummaryText(ctx.name ?? null, args, lang);
    void sendSmsViaAt(args.phone, body);
    logger.info(
      { phone: args.phone, tier: ctx.tier, lang, reportId: args.reportId },
      "[Deterministic] Post-call summary SMS queued",
    );
  } catch (err) {
    logger.warn(
      { err: String(err), phone: args.phone },
      "[Deterministic] Post-call summary SMS failed",
    );
  }
}

/**
 * Compose a short (≤160 char) summary of what we captured. Includes:
 *   - caller's first name if known
 *   - action tag (e.g. "Dry Season Stress")
 *   - most notable indicators — BCS, mortality, water status
 * Keeps text natural: no jargon, no "action_tag=" style dumps.
 */
function buildPostCallSummaryText(
  name: string | null,
  args: PostCallSummaryArgs,
  lang: "sw" | "en",
): string {
  const nameBit = name ? " " + name.trim().split(/\s+/)[0] : "";
  const bcs = args.indicators?.bcs_score;
  const mortality = args.indicators?.mortality_rate;
  const waterStatus = args.indicators?.water_point_status;

  const bits: string[] = [];
  if (typeof bcs === "number") {
    bits.push(lang === "sw" ? `BCS ${bcs.toFixed(1)}` : `BCS ${bcs.toFixed(1)}`);
  }
  if (mortality != null) {
    // mortality_rate is a string enum ("1-3" | "4-plus" | ...).
    const mLabel = String(mortality).slice(0, 12);
    bits.push(lang === "sw" ? `Vifo: ${mLabel}` : `Losses: ${mLabel}`);
  }
  if (waterStatus) {
    const w = String(waterStatus).slice(0, 20);
    bits.push(lang === "sw" ? `Maji: ${w}` : `Water: ${w}`);
  }

  const captured =
    bits.length > 0
      ? bits.join(", ")
      : lang === "sw"
        ? "Tumepokea taarifa yako"
        : "Report received";

  const tail =
    lang === "sw"
      ? "Asante. Tutafuatilia."
      : "Thanks. We will follow up.";

  return `ArdaLink${nameBit}: ${captured}. ${tail}`.slice(0, 160);
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
    const result = await insertGroundTruthCall(
      mapExtractedIndicatorsToGroundTruthRow({
        pastoralistId: past.pastoralist_id,
        wardId,
        indicators: args.indicators,
        trustScore: args.trustScore,
        transcript: args.transcript,
        sourceLanguage: args.sourceLanguage,
        channel: "voice",
      }),
    );
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
