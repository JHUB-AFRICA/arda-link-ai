/**
 * Demo Voice Simulator — Web UI for testing voice flows without Africa's Talking.
 *
 * This route provides a web-based simulator for voice interactions.
 * It allows testing the full voice conversation flow without needing
 * real phone calls or Africa's Talking Voice API.
 *
 * Endpoints:
 * - GET /api/demo/voice/simulator  → HTML page with voice simulator UI
 * - POST /api/demo/voice/start     → Start a voice session
 * - POST /api/demo/voice/message   → Send a transcript message (simulating speech)
 * - GET /api/demo/voice/state      → Get current session state
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { desc, eq, gt, and } from "drizzle-orm";
import { db, groundTruthReportsTable } from "@workspace/db";
import {
  parseVoiceInput,
  generateAiResponse,
  loadIntelligenceContext,
  createSession,
  updateSession,
  endSession,
  getSession,
  type ParsedInput,
} from "../../lib/channels/intelligenceCore";
import { VoiceAdapter } from "../../lib/channels/adapters";
import { mintToken, TOKEN_TTL_SECONDS } from "../../lib/callTokens";
import { logger } from "../../lib/logger";
import { fastTranscribe, isSpeechConfigured } from "../../lib/speech";
import { extractIndicators, generateActionTag } from "../../lib/openai";
import { getLastResult } from "../../lib/intelligence";
import { fetchSatelliteVCI, type VCISnapshot } from "../../lib/engine";
import { tenantForWardId } from "../../lib/wardMapping";
import { computeTrustScore, logTrustScore } from "../../lib/trustScore";
import { withTenantContext } from "../../lib/tenancy-context";
import {
  resolveHerderContext,
  buildLocalizedBrief,
  buildLocalizedVoiceOpener,
} from "../../lib/herderContext";
import {
  categoryLabelFor,
  dtmfConfirmation,
  dtmfMenuPrompt,
  noInputFallback,
  postRecordThanks,
  voiceOpener,
  type VoiceLang,
} from "../../lib/voiceCopy";

/**
 * DTMF categories in the same order + digit assignment used by the
 * real /api/voice-callback flow. We reflect this back to the browser
 * so the demo keypad is a faithful mirror of the AT flow.
 */
const DEMO_DTMF_CATEGORIES: ReadonlyArray<{ dtmf: string; id: string }> = [
  { dtmf: "1", id: "bcs" },
  { dtmf: "2", id: "water_point" },
  { dtmf: "3", id: "mortality" },
  { dtmf: "4", id: "feeding" },
  { dtmf: "5", id: "milk" },
  { dtmf: "6", id: "water_trek" },
  { dtmf: "7", id: "drought_signal" },
];

const DEMO_TENANT_ID = process.env.DETERMINISTIC_TENANT_ID ?? "bula-pesa";

const router: IRouter = Router();

/**
 * GET /api/demo/voice/context?phone=+254…
 *
 * Returns the herder-specific context the demo UI uses to build a
 * personalized opener. Mirrors the same resolveHerderContext() call the
 * real deterministic pipeline uses on inbound AT calls.
 */
router.get(
  "/context",
  async (req: Request, res: Response): Promise<void> => {
    const phone = String(req.query.phone ?? "").trim();
    if (!phone) {
      res.status(400).json({ error: "phone-required" });
      return;
    }
    try {
      let ctx = await resolveHerderContext(phone, DEMO_TENANT_ID);

      // Overlay LIVE engine data (GEE VCI + NDVI current/min/max +
      // urban mask + prosopis penalty) so the demo speaks numbers
      // the engine literally just fetched instead of the Supabase
      // monthly aggregate. The engine call takes ~15–30 s per ward
      // — fine for the demo (operator-driven, no AT timeout) but
      // gated behind ?live=false in case the caller wants to skip
      // for speed. Failures fall through silently.
      const wantLive = String(req.query.live ?? "true").toLowerCase() !== "false";
      let engineSnapshot: VCISnapshot | null = null;
      if (wantLive) {
        const tenantSlug =
          tenantForWardId(ctx.wardId ?? "") || DEMO_TENANT_ID;
        try {
          engineSnapshot = await fetchSatelliteVCI(tenantSlug, DEMO_TENANT_ID);
          if (engineSnapshot && engineSnapshot.ndvi_now != null) {
            // MODIS NDVI arrives as raw fixed-point (0..10000). Normalise
            // to the 0..1 range the rest of the codebase reasons in.
            const normNdvi = engineSnapshot.ndvi_now / 10000;
            const normMin = (engineSnapshot.ndvi_min ?? 0) / 10000;
            const normMax = (engineSnapshot.ndvi_max ?? 0) / 10000;
            ctx = {
              ...ctx,
              // Prefer engine's live NDVI over the Supabase monthly mean.
              wardNdviMean: normNdvi,
              // Override the Supabase-derived VCI with the engine's fresh
              // one — same 0..100 scale, but grounded in "now" not
              // "last-month-mean vs 11-year history".
              vciDerived: engineSnapshot.vci,
              // Keep the historical bounds too, but from engine's own
              // MODIS record range — different span than the Supabase
              // per-month percentile envelope.
              ndviBaselineP5: normMin,
              ndviBaselineP95: normMax,
            };
          }
        } catch (err) {
          logger.warn(
            { err, tenantSlug, wardId: ctx.wardId },
            "[Demo Voice] engine live fetch failed — falling back to Supabase-only ctx",
          );
        }
      }

      // Build the sequence AFTER the overlay so opener + brief
      // reflect the freshest numbers we have.
      const openerV2 = voiceOpener(ctx);
      const lang: VoiceLang = openerV2.lang;
      const categories = DEMO_DTMF_CATEGORIES.map((c) => ({
        dtmf: c.dtmf,
        id: c.id,
        label: categoryLabelFor(lang, c.id),
      }));

      res.json({
        ctx,
        // Live engine snapshot — the UI renders this as a "live from
        // GEE" pill so operators can see the demo is grounded in data
        // that was fetched seconds ago, not a stale monthly aggregate.
        engineSnapshot: engineSnapshot
          ? {
              vci: engineSnapshot.vci,
              ndviNow: (engineSnapshot.ndvi_now ?? 0) / 10000,
              ndviMin: (engineSnapshot.ndvi_min ?? 0) / 10000,
              ndviMax: (engineSnapshot.ndvi_max ?? 0) / 10000,
              urbanMasked: engineSnapshot.urban_masked,
              prosopisFactor: engineSnapshot.prosopis_factor,
              capturedAt: engineSnapshot.captured_at,
              wardName: engineSnapshot.ward_name,
            }
          : null,
        // legacy strings kept for anything still importing them
        opener: openerV2.text,
        briefSw: buildLocalizedBrief(ctx, "sw"),
        briefEn: buildLocalizedBrief(ctx, "en"),
        // v2 sequence — everything the demo needs to walk the call
        sequence: {
          lang,
          opener: openerV2.text,
          menuPrompt: dtmfMenuPrompt(lang),
          categories,
          confirmationTemplate: dtmfConfirmation(lang, "{{label}}"),
          postRecord: postRecordThanks(ctx, lang),
          noInput: noInputFallback(lang),
        },
      });
    } catch (err) {
      logger.error({ err }, "[Demo Voice] context lookup failed");
      res.status(500).json({ error: "context_lookup_failed" });
    }
  },
);

/**
 * POST /api/demo/voice/token
 *
 * Mints a phoneless (admin-mode) call token so the demo can open the
 * /api/browser-voice-stream WebSocket without a bearer JWT. Phoneless
 * mints bypass the public rate-limits + concurrency cap (see
 * mintToken()), which is what we want for a self-service demo. The token
 * is single-use, 15-min TTL, and the WS handshake enforces trusted
 * Origin so this endpoint can only be called from our own pages.
 */
router.post("/token", async (req: Request, res: Response): Promise<void> => {
  try {
    const { token, expiresAt } = await mintToken({
      ip: req.ip ?? null,
      tenantId: "demo",
    });
    res.json({ token, expiresAt, ttlSeconds: TOKEN_TTL_SECONDS });
  } catch (err) {
    logger.error({ err }, "[Demo Voice] token mint failed");
    res.status(500).json({ error: "token_mint_failed" });
  }
});

/**
 * GET /api/demo/voice/latest-report
 *
 * Returns the most recent ground-truth report from a browser demo call
 * (phone = 'browser-webrtc') so the UI can show what the AI actually
 * extracted from the conversation — BCS, mortality, water status, etc.
 * Bypasses tenant RLS because demo calls aren't tenant-scoped.
 */
router.get(
  "/latest-report",
  async (_req: Request, res: Response): Promise<void> => {
    try {
      const since = new Date(Date.now() - 10 * 60 * 1000);
      const rows = await db
        .select()
        .from(groundTruthReportsTable)
        .where(
          and(
            eq(groundTruthReportsTable.phone, "browser-webrtc"),
            gt(groundTruthReportsTable.createdAt, since),
          ),
        )
        .orderBy(desc(groundTruthReportsTable.createdAt))
        .limit(1);
      const row = rows[0];
      if (!row) {
        res.json({ report: null });
        return;
      }
      res.json({
        report: {
          id: row.id,
          createdAt: row.createdAt,
          actionTag: row.actionTag,
          bcsScore: row.bcsScore,
          bcsSpecies: row.bcsSpecies,
          bcsConfidence: row.bcsConfidence,
          offtakeRate: row.offtakeRate,
          mortalityRate: row.mortalityRate,
          milkProduction: row.milkProduction,
          waterTrekkingDistance: row.waterTrekkingDistance,
          waterPointName: row.waterPointName,
          waterPointStatus: row.waterPointStatus,
          supplementaryFeeding: row.supplementaryFeeding,
          reportedLocation: row.reportedLocation,
          reportedQuadrant: row.reportedQuadrant,
          indicatorsCollected: row.indicatorsCollected,
          dataCompletenessPercent: row.dataCompletenessPercent,
          callDurationSeconds: row.callDurationSeconds,
          trustScore: row.trustScore,
          transcript: row.userFeedback,
        },
      });
    } catch (err) {
      logger.error({ err }, "[Demo Voice] latest-report failed");
      res.status(500).json({ error: "latest_report_failed" });
    }
  },
);

/**
 * GET /api/demo/voice/simulator
 *
 * Returns an HTML page with an interactive voice simulator.
 */
/**
 * POST /api/demo/voice/record
 *
 * Deterministic demo path — mirrors the exact production flow used for
 * herder phone calls (Azure Fast Transcription → LLM extract →
 * ground_truth_reports), but takes an audio blob from the browser
 * instead of downloading an Africa's Talking recording. Content-type
 * is whatever MediaRecorder produced (usually `audio/webm;codecs=opus`).
 *
 *   query params:  category=bcs|water_point|mortality|...
 *   body:          raw audio bytes (multipart/form-data or application/octet-stream)
 *
 * Response: { reportId, transcript, indicators, trustScore } — the same
 * indicators that would be extracted from a real call, proven live.
 */
router.post(
  "/record",
  async (req: Request, res: Response): Promise<void> => {
    if (!isSpeechConfigured()) {
      res.status(503).json({ error: "speech-not-configured" });
      return;
    }
    const category = String(req.query.category ?? "drought_signal");
    const categoryLabel = indicatorLabelFromCategory(category);
    const phone = String(req.query.phone ?? "").trim();

    // Read raw bytes from the request. We accept application/octet-stream
    // (browser fetch of a Blob) — simplest to parse without multer.
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
      (req.header("content-type") ?? "").split(";")[0]?.trim() ||
      "audio/webm";

    logger.info(
      { bytes: audio.length, contentType, category },
      "[Demo Voice] deterministic recording received",
    );

    const stt = await fastTranscribe(audio, contentType, {
      filename: "browser-demo.webm",
    });
    if (!stt || !stt.transcript) {
      res
        .status(422)
        .json({ error: "transcription-empty", contentType, bytes: audio.length });
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
        : Promise.resolve("Deterministic Demo"),
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
      const [report] = await withTenantContext(DEMO_TENANT_ID, (tx) =>
        tx
          .insert(groundTruthReportsTable)
          .values({
            tenantId: DEMO_TENANT_ID,
            phone: phone || "browser-deterministic",
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

      logTrustScore("browser-deterministic", report?.id ?? null, trust);
      logger.info(
        {
          id: report?.id,
          category,
          bcs: indicators?.bcs_score,
          collected: indicators?.indicators_collected,
          trustScore: trust.score,
        },
        "[Demo Voice] deterministic ground truth stored",
      );

      // Herder context lookup — used both for personalizing the reply
      // (so the demo mirrors the real flow) and for updating pastoralist
      // last-contact where appropriate.
      const ctx = phone
        ? await resolveHerderContext(phone, DEMO_TENANT_ID)
        : null;

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
      logger.error({ err }, "[Demo Voice] deterministic insert failed");
      res.status(500).json({ error: "insert_failed" });
    }
  },
);

/**
 * GET /api/demo/voice/deterministic  (legacy path — kept for existing links)
 * GET /api/demo/voice/simulator      (the default, since 2026-07-07)
 *
 * Standalone browser page that captures 20 seconds of audio via
 * MediaRecorder, POSTs to /api/demo/voice/record, and renders the
 * extracted ground truth. Uses the same Speech + LLM stack as real
 * herder phone calls — proves the deterministic pipeline works without
 * an Africa's Talking sandbox.
 */
router.get(
  "/deterministic",
  (_req: Request, res: Response): void => {
    res.set("Content-Type", "text/html");
    res.send(deterministicDemoHtml());
  },
);

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
 * GET /api/demo/voice/simulator   — the primary voice demo since 2026-07-07.
 *
 * Serves the deterministic phone-call sim (record 20 s → Azure Speech →
 * GPT-5 Mini indicator extract → ground truth). This mirrors the exact
 * flow real herder calls run through Africa's Talking. The old realtime
 * WebSocket demo lives at `/simulator-realtime` for reference; it will
 * become the herder default again in Phase 3 (see llm-integration.md §5.2).
 */
router.get("/simulator", (_req: Request, res: Response): void => {
  res.set("Content-Type", "text/html");
  res.send(deterministicDemoHtml());
});

/**
 * GET /api/demo/voice/simulator-realtime — Phase-3 preview only.
 *
 * The Azure OpenAI Realtime WS bridge. Requires a live
 * `gpt-4o-realtime-preview` deployment. Not shown in the demo hub since
 * 2026-07-07 to avoid confusion — deterministic is the herder path.
 */
router.get("/simulator-realtime", (_req: Request, res: Response): void => {
  res.set("Content-Type", "text/html");
  const apiPort = process.env.PORT ?? "3000";
  res.send(realtimeSimulatorHtml(apiPort));
});

function realtimeSimulatorHtml(apiPort: string): string {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ArdaLink Voice — Real-time Call</title>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      max-width: 560px; margin: 0 auto; padding: 20px;
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
      min-height: 100vh; color: #fff;
    }
    .phone { background: #2d2d44; border-radius: 26px; padding: 22px; box-shadow: 0 20px 60px rgba(0,0,0,0.5); }
    .header { display: flex; justify-content: space-between; align-items: center; padding-bottom: 12px; border-bottom: 1px solid #444; }
    .header h1 { font-size: 17px; margin: 0; color: #4ade80; }
    .status { font-size: 12px; color: #888; }
    .status.connecting { color: #fbbf24; }
    .status.live { color: #4ade80; }
    .status.speaking { color: #60a5fa; }
    .status.listening { color: #f472b6; }
    .status.ended { color: #ef4444; }
    .badges { display: flex; gap: 6px; flex-wrap: wrap; padding: 10px 0 6px; font-size: 11px; }
    .badge { background: #1e293b; border: 1px solid #334155; padding: 3px 8px; border-radius: 12px; color: #cbd5e1; }
    .badge.live { border-color: #4ade80; color: #4ade80; }
    .badge.warn { border-color: #fbbf24; color: #fbbf24; }
    .badge.err  { border-color: #ef4444; color: #ef4444; }
    .transcript { min-height: 280px; max-height: 380px; overflow-y: auto; padding: 12px 0; }
    .msg { margin: 8px 0; padding: 10px 14px; border-radius: 14px; font-size: 14px; line-height: 1.5; }
    .msg.ai { background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%); border-bottom-left-radius: 4px; }
    .msg.you { background: #3d3d5c; border-bottom-right-radius: 4px; margin-left: auto; max-width: 85%; }
    .msg .who { font-size: 10px; opacity: 0.7; margin-bottom: 3px; text-transform: uppercase; letter-spacing: 1px; }
    .meter { display: flex; align-items: center; gap: 10px; padding: 10px 0; }
    .meter .bar { flex: 1; height: 6px; background: #1e293b; border-radius: 3px; overflow: hidden; }
    .meter .bar > div { height: 100%; background: linear-gradient(90deg, #4ade80, #fbbf24, #ef4444); width: 0%; transition: width 0.08s linear; }
    .controls { display: flex; gap: 10px; padding-top: 14px; border-top: 1px solid #444; }
    .btn { flex: 1; padding: 14px 6px; border: none; border-radius: 14px; font-size: 15px; font-weight: 600; cursor: pointer; transition: transform 0.1s; }
    .btn:disabled { opacity: 0.4; cursor: not-allowed; }
    .btn:active:not(:disabled) { transform: scale(0.97); }
    .btn-call   { background: #22c55e; color: #fff; }
    .btn-hangup { background: #ef4444; color: #fff; }
    .report {
      margin-top: 14px; padding: 14px; background: #0f172a;
      border: 1px solid #1e293b; border-radius: 14px; font-size: 13px;
    }
    .report h3 { margin: 0 0 8px; font-size: 14px; color: #4ade80; }
    .report .row { display: flex; justify-content: space-between; padding: 3px 0; border-bottom: 1px solid #1e293b; }
    .report .row:last-child { border-bottom: none; }
    .report .row .k { color: #94a3b8; }
    .report .row .v { color: #f1f5f9; font-weight: 600; }
    .hidden { display: none; }
    .hint { font-size: 11px; color: #888; text-align: center; padding-top: 8px; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
    .pulse { animation: pulse 1.4s infinite; }
  </style>
</head>
<body>
  <div class="phone">
    <div class="header">
      <h1>📞 ArdaLink Real-time Voice</h1>
      <span class="status" id="status">Ready</span>
    </div>

    <div class="badges">
      <span class="badge" id="wsBadge">ws: —</span>
      <span class="badge" id="micBadge">mic: —</span>
      <span class="badge" id="providerBadge">brain: Azure Realtime</span>
      <span class="badge" id="durBadge">00:00</span>
    </div>

    <div class="meter">
      <span style="font-size:10px;color:#94a3b8;">MIC</span>
      <div class="bar"><div id="micBar"></div></div>
    </div>

    <div class="transcript" id="transcript">
      <div class="msg ai">
        <div class="who">ArdaLink</div>
        <div>Press "Start Call" and I'll greet you in Swahili. Speak naturally — I'll interrupt if you interrupt me. The call ends when you hang up or I finish delivering advice.</div>
      </div>
    </div>

    <div class="controls">
      <button class="btn btn-call" id="callBtn">📞 Start Call</button>
      <button class="btn btn-hangup" id="hangupBtn" disabled>📴 Hang Up</button>
    </div>
    <div class="hint">Real audio, Azure OpenAI Realtime (gpt-4o-realtime-preview), server-VAD barge-in, live transcript.</div>

    <div id="reportSection" class="hidden">
      <div class="report" id="report">
        <h3>📋 Ground-truth extracted</h3>
        <div id="reportBody">Waiting for AI to process the call…</div>
      </div>
    </div>
  </div>

  <script>
  (() => {
    // ── State ────────────────────────────────────────────────────────────
    const els = {
      status: document.getElementById('status'),
      wsBadge: document.getElementById('wsBadge'),
      micBadge: document.getElementById('micBadge'),
      providerBadge: document.getElementById('providerBadge'),
      durBadge: document.getElementById('durBadge'),
      transcript: document.getElementById('transcript'),
      callBtn: document.getElementById('callBtn'),
      hangupBtn: document.getElementById('hangupBtn'),
      micBar: document.getElementById('micBar'),
      reportSection: document.getElementById('reportSection'),
      reportBody: document.getElementById('reportBody'),
    };

    let ws = null;
    let audioCtx = null;
    let micStream = null;
    let micSource = null;
    let micWorkletNode = null;
    let micProcessor = null; // legacy fallback
    let playbackTime = 0;
    let audioQueueTail = 0;
    let pendingSources = new Set();
    let sessionStart = 0;
    let durationTimer = null;
    let live = false;

    const SAMPLE_RATE = 24000; // Azure Realtime pcm16 sample rate

    // ── UI helpers ───────────────────────────────────────────────────────
    function setStatus(t, cls) { els.status.textContent = t; els.status.className = 'status ' + (cls || ''); }
    function setBadge(el, text, cls) { el.textContent = text; el.className = 'badge' + (cls ? ' ' + cls : ''); }
    function addMsg(text, who, isAi) {
      const div = document.createElement('div');
      div.className = 'msg ' + (isAi ? 'ai' : 'you');
      div.innerHTML = '<div class="who">' + who + '</div><div>' + escapeHtml(text) + '</div>';
      els.transcript.appendChild(div); els.transcript.scrollTop = els.transcript.scrollHeight;
      return div;
    }
    function escapeHtml(s) { return String(s).replace(/[&<>\"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;' }[c])); }

    // ── Audio: convert Float32 → Int16 PCM → base64 ───────────────────────
    function floatToPcm16(input) {
      const out = new Int16Array(input.length);
      for (let i = 0; i < input.length; i++) {
        const s = Math.max(-1, Math.min(1, input[i]));
        out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      return out;
    }
    function pcm16ToFloat(buf) {
      const view = new Int16Array(buf);
      const out = new Float32Array(view.length);
      for (let i = 0; i < view.length; i++) out[i] = view[i] / (view[i] < 0 ? 0x8000 : 0x7fff);
      return out;
    }
    function b64FromBuf(buf) {
      const bytes = new Uint8Array(buf);
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      }
      return btoa(bin);
    }
    function bufFromB64(b64) {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return bytes.buffer;
    }

    function resample(input, fromRate, toRate) {
      if (fromRate === toRate) return input;
      const ratio = fromRate / toRate;
      const outLen = Math.floor(input.length / ratio);
      const out = new Float32Array(outLen);
      for (let i = 0; i < outLen; i++) {
        const idx = i * ratio;
        const i0 = Math.floor(idx);
        const i1 = Math.min(i0 + 1, input.length - 1);
        const frac = idx - i0;
        out[i] = input[i0] * (1 - frac) + input[i1] * frac;
      }
      return out;
    }

    // ── Call lifecycle ──────────────────────────────────────────────────
    async function startCall() {
      els.callBtn.disabled = true;
      els.callBtn.textContent = '☎️ Connecting…';
      setStatus('Connecting…', 'connecting');
      els.reportSection.classList.add('hidden');

      // 1) Get mic
      try {
        micStream = await navigator.mediaDevices.getUserMedia({
          audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
        });
        setBadge(els.micBadge, 'mic: ready', 'live');
      } catch (e) {
        setBadge(els.micBadge, 'mic: denied', 'err');
        addMsg('Microphone access denied. Please allow the mic and reload.', 'System', false);
        resetUi();
        return;
      }

      // 2) Mint a demo call token
      let tokenPayload;
      try {
        const r = await fetch('/api/demo/voice/token', { method: 'POST' });
        tokenPayload = await r.json();
        if (!r.ok || !tokenPayload.token) throw new Error(tokenPayload.error || 'mint failed');
      } catch (e) {
        setBadge(els.wsBadge, 'ws: token failed', 'err');
        addMsg('Could not mint call token: ' + e.message, 'System', false);
        resetUi();
        return;
      }

      // 3) Open WS.
      // The static frontend proxy (web-server.py :8080) only forwards HTTP,
      // not the WebSocket upgrade. So we ALWAYS point the WS at the API's
      // own port, injected at render time from process.env.PORT.
      const API_PORT = '${apiPort}';
      const wsScheme = location.protocol === 'https:' ? 'wss://' : 'ws://';
      const wsHost = location.port === API_PORT ? location.host : location.hostname + ':' + API_PORT;
      const wsUrl = wsScheme + wsHost + '/api/browser-voice-stream?token=' + encodeURIComponent(tokenPayload.token);
      ws = new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer';

      ws.onopen = async () => {
        setBadge(els.wsBadge, 'ws: connected', 'live');
        setStatus('Connected', 'live');
        live = true;
        els.callBtn.textContent = '📞 In Call';
        els.hangupBtn.disabled = false;
        sessionStart = Date.now();
        durationTimer = setInterval(() => {
          const s = Math.floor((Date.now() - sessionStart) / 1000);
          const m = Math.floor(s / 60), ss = s % 60;
          setBadge(els.durBadge, String(m).padStart(2,'0') + ':' + String(ss).padStart(2,'0'));
        }, 500);

        // 4) Start streaming mic to WS
        await startMicPump();
      };

      ws.onmessage = onWsMessage;

      ws.onclose = () => {
        setBadge(els.wsBadge, 'ws: closed', '');
        setStatus('Call ended', 'ended');
        finishCall();
      };
      ws.onerror = () => {
        setBadge(els.wsBadge, 'ws: error', 'err');
      };
    }

    // Inline AudioWorklet — batches mic samples into 4096-sample chunks and
    // posts them to the main thread. Loaded via Blob URL so no separate .js
    // file is needed. Falls back to the deprecated ScriptProcessorNode on
    // browsers without AudioWorklet support.
    const workletSource = \`
      class MicPumpProcessor extends AudioWorkletProcessor {
        constructor() {
          super();
          this.buf = new Float32Array(4096);
          this.pos = 0;
        }
        process(inputs) {
          const ch = inputs[0] && inputs[0][0];
          if (!ch) return true;
          for (let i = 0; i < ch.length; i++) {
            this.buf[this.pos++] = ch[i];
            if (this.pos === this.buf.length) {
              this.port.postMessage(this.buf.slice(0));
              this.pos = 0;
            }
          }
          return true;
        }
      }
      registerProcessor('mic-pump', MicPumpProcessor);
    \`;

    async function startMicPump() {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: SAMPLE_RATE });
      // Some browsers refuse the requested sampleRate; use the actual one.
      const actualRate = audioCtx.sampleRate;
      micSource = audioCtx.createMediaStreamSource(micStream);

      let peak = 0;
      const handleChunk = (raw) => {
        // Mic level meter (RMS)
        let sumSq = 0;
        for (let i = 0; i < raw.length; i++) sumSq += raw[i] * raw[i];
        const rms = Math.sqrt(sumSq / raw.length);
        peak = Math.max(peak * 0.85, Math.min(1, rms * 4));
        els.micBar.style.width = (peak * 100).toFixed(0) + '%';

        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        const resampled = resample(raw, actualRate, SAMPLE_RATE);
        const pcm = floatToPcm16(resampled);
        ws.send(JSON.stringify({ type: 'audio', data: b64FromBuf(pcm.buffer) }));
      };

      if (audioCtx.audioWorklet && typeof AudioWorkletNode !== 'undefined') {
        // Modern path: AudioWorkletNode
        const blobUrl = URL.createObjectURL(new Blob([workletSource], { type: 'application/javascript' }));
        try {
          await audioCtx.audioWorklet.addModule(blobUrl);
          micWorkletNode = new AudioWorkletNode(audioCtx, 'mic-pump');
          micWorkletNode.port.onmessage = (ev) => handleChunk(ev.data);
          micSource.connect(micWorkletNode);
          // AudioWorkletNode does not need to connect to destination to run.
          return;
        } catch (e) {
          console.warn('AudioWorklet load failed, falling back to ScriptProcessor', e);
        } finally {
          URL.revokeObjectURL(blobUrl);
        }
      }

      // Fallback: deprecated ScriptProcessorNode (still works everywhere)
      micProcessor = audioCtx.createScriptProcessor(4096, 1, 1);
      micProcessor.onaudioprocess = (ev) => handleChunk(ev.inputBuffer.getChannelData(0));
      micSource.connect(micProcessor);
      micProcessor.connect(audioCtx.destination);
    }

    // ── WS message handling ─────────────────────────────────────────────
    function onWsMessage(ev) {
      let msg;
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data)); }
      catch { return; }

      switch (msg.type) {
        case 'audio':
          scheduleAudio(msg.data);
          setStatus('AI speaking…', 'speaking');
          break;
        case 'audio_done':
          // Nothing to do — playback drainage triggers 'playback_ended'.
          break;
        case 'interrupt':
          // Barge-in: stop scheduled AI audio immediately.
          for (const src of pendingSources) { try { src.stop(); } catch(_){} }
          pendingSources.clear();
          playbackTime = audioCtx ? audioCtx.currentTime : 0;
          audioQueueTail = 0;
          setStatus('Listening…', 'listening');
          break;
        case 'transcript':
          addMsg(msg.text, msg.role === 'assistant' ? 'ArdaLink' : 'You', msg.role === 'assistant');
          if (msg.role === 'assistant') setBadge(els.providerBadge, 'brain: Azure Realtime (live turn)', 'live');
          break;
        case 'end_call':
          addMsg('Call ending: ' + (msg.reason || 'complete'), 'System', false);
          break;
        case 'error':
          addMsg('Error: ' + msg.message, 'System', false);
          break;
      }
    }

    function scheduleAudio(b64) {
      if (!audioCtx) return;
      const buf = bufFromB64(b64);
      const float = pcm16ToFloat(buf);
      const abuf = audioCtx.createBuffer(1, float.length, SAMPLE_RATE);
      abuf.getChannelData(0).set(float);
      const src = audioCtx.createBufferSource();
      src.buffer = abuf;
      src.connect(audioCtx.destination);
      const now = audioCtx.currentTime;
      const startAt = Math.max(now, audioQueueTail);
      src.start(startAt);
      audioQueueTail = startAt + abuf.duration;
      pendingSources.add(src);
      src.onended = () => {
        pendingSources.delete(src);
        // Once queue drains, tell the server so it can safely close after end_call.
        if (pendingSources.size === 0 && ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'playback_ended' }));
          if (live) setStatus('Connected', 'live');
        }
      };
    }

    // ── Hang up ─────────────────────────────────────────────────────────
    function hangup(reason) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify({ type: 'stop', reason: reason || 'user_hangup' })); } catch(_){}
      }
      setStatus('Hanging up…', 'ended');
    }

    async function finishCall() {
      live = false;
      if (durationTimer) clearInterval(durationTimer);
      if (micWorkletNode) { try { micWorkletNode.port.close(); micWorkletNode.disconnect(); } catch(_){} }
      if (micProcessor)   { try { micProcessor.disconnect();   } catch(_){} }
      if (micSource)      { try { micSource.disconnect();      } catch(_){} }
      if (audioCtx)       { try { await audioCtx.close();      } catch(_){} }
      if (micStream)      { micStream.getTracks().forEach(t => t.stop()); }
      audioCtx = null; micStream = null; micProcessor = null; micWorkletNode = null; micSource = null;
      els.callBtn.textContent = '📞 Start Call';
      els.callBtn.disabled = false;
      els.hangupBtn.disabled = true;
      els.micBar.style.width = '0%';
      // Now poll for the ground-truth report the server extracted.
      pollForReport();
    }

    function resetUi() {
      els.callBtn.textContent = '📞 Start Call';
      els.callBtn.disabled = false;
      els.hangupBtn.disabled = true;
      setStatus('Ready', '');
    }

    // ── Ground truth surface ────────────────────────────────────────────
    async function pollForReport() {
      els.reportSection.classList.remove('hidden');
      els.reportBody.textContent = 'Extracting indicators from transcript…';
      // The server runs extractIndicators() in endBrowserCall(). Give it a
      // few seconds, then poll.
      for (let i = 0; i < 15; i++) {
        await new Promise(r => setTimeout(r, 1500));
        try {
          const r = await fetch('/api/demo/voice/latest-report');
          const j = await r.json();
          if (j.report) {
            renderReport(j.report);
            return;
          }
        } catch (_) {}
      }
      els.reportBody.textContent = 'No report captured yet. (If the call was very short, no indicators were extracted.)';
    }

    function renderReport(rp) {
      const rows = [
        ['Action tag', rp.actionTag],
        ['Location', rp.reportedLocation || rp.reportedQuadrant || '(not shared)'],
        ['Species', rp.bcsSpecies],
        ['BCS score (1–5)', rp.bcsScore != null ? rp.bcsScore + ' (' + (rp.bcsConfidence || '') + ')' : null],
        ['Mortality', rp.mortalityRate],
        ['Milk production', rp.milkProduction],
        ['Water trekking', rp.waterTrekkingDistance],
        ['Water point', rp.waterPointName && rp.waterPointStatus ? rp.waterPointName + ' — ' + rp.waterPointStatus : null],
        ['Supplementary feed', rp.supplementaryFeeding],
        ['Offtake', rp.offtakeRate],
        ['Indicators collected', rp.indicatorsCollected + ' / 7 (' + (rp.dataCompletenessPercent || 0).toFixed(0) + '%)'],
        ['Trust score', rp.trustScore],
        ['Call length', rp.callDurationSeconds ? rp.callDurationSeconds + 's' : null],
      ];
      const html = rows.filter(r => r[1] != null && r[1] !== '')
        .map(r => '<div class="row"><span class="k">' + escapeHtml(r[0]) + '</span><span class="v">' + escapeHtml(String(r[1])) + '</span></div>')
        .join('');
      els.reportBody.innerHTML = html || 'No structured indicators extracted from this call.';
    }

    // ── Wire up button handlers (inside the IIFE so scope is preserved) ──
    els.callBtn.addEventListener('click', () => { void startCall(); });
    els.hangupBtn.addEventListener('click', () => { hangup('user_hangup'); });
  })();
  </script>
</body>
</html>
  `;
}

// Legacy turn-based sim endpoints below are kept for backwards compatibility
// with older demo entry-points and quick JSON smoke-tests. The primary demo
// is now the real-time WS bridge (/simulator + /token + /latest-report).
router.get("/simulator-legacy", (_req: Request, res: Response): void => {
  res.set("Content-Type", "text/html");
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ArdaLink Voice Call Simulator</title>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      max-width: 520px;
      margin: 0 auto;
      padding: 20px;
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
      min-height: 100vh;
      color: #fff;
    }
    .phone { background: #2d2d44; border-radius: 30px; padding: 22px; box-shadow: 0 20px 60px rgba(0,0,0,0.5); }
    .header {
      display: flex; justify-content: space-between; align-items: center;
      padding-bottom: 14px; border-bottom: 1px solid #444;
    }
    .header h1 { font-size: 17px; margin: 0; color: #4ade80; }
    .status { font-size: 12px; color: #888; }
    .status.connected { color: #4ade80; }
    .status.calling { color: #fbbf24; }
    .status.speaking { color: #60a5fa; }
    .status.listening { color: #f472b6; }
    .status.ended { color: #ef4444; }
    .badges {
      display: flex; gap: 6px; flex-wrap: wrap;
      padding: 10px 0 4px; font-size: 11px;
    }
    .badge {
      background: #1e293b; border: 1px solid #334155;
      padding: 3px 8px; border-radius: 12px; color: #cbd5e1;
    }
    .badge.live { border-color: #4ade80; color: #4ade80; }
    .badge.warn { border-color: #fbbf24; color: #fbbf24; }
    .conversation {
      min-height: 300px; max-height: 420px; overflow-y: auto;
      padding: 14px 0;
    }
    .message {
      margin: 10px 0; padding: 12px 14px; border-radius: 14px;
      font-size: 14px; line-height: 1.5;
    }
    .message.ai { background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%); border-bottom-left-radius: 4px; }
    .message.herder { background: #3d3d5c; border-bottom-right-radius: 4px; margin-left: auto; max-width: 85%; }
    .message .speaker { font-size: 10px; opacity: 0.7; margin-bottom: 4px; text-transform: uppercase; letter-spacing: 1px; }
    .message .meta-line { font-size: 10px; opacity: 0.6; margin-top: 6px; }
    .lang-toggle {
      display: flex; gap: 6px; margin-left: auto; margin-right: 10px;
    }
    .lang-toggle button {
      background: transparent; border: 1px solid #666; color: #ccc;
      padding: 3px 8px; border-radius: 10px; font-size: 11px; cursor: pointer;
    }
    .lang-toggle button.active { background: #4ade80; color: #111; border-color: #4ade80; }
    .controls {
      display: flex; gap: 10px; padding-top: 14px; border-top: 1px solid #444;
    }
    .btn {
      flex: 1; padding: 14px 6px; border: none; border-radius: 14px;
      font-size: 15px; font-weight: 600; cursor: pointer; transition: transform 0.1s;
    }
    .btn:disabled { opacity: 0.4; cursor: not-allowed; }
    .btn:active:not(:disabled) { transform: scale(0.97); }
    .btn-call { background: #22c55e; color: #fff; }
    .btn-mic { background: #f472b6; color: #111; }
    .btn-mic.recording { background: #ef4444; color: #fff; animation: pulse 1.2s infinite; }
    .btn-hangup { background: #ef4444; color: #fff; }
    .input-area { display: flex; gap: 8px; padding-top: 12px; }
    .input-area input {
      flex: 1; padding: 10px 14px; border: none; border-radius: 18px;
      background: #3d3d5c; color: #fff; font-size: 14px;
    }
    .input-area button { padding: 10px 16px; background: #4ade80; border: none; border-radius: 18px; cursor: pointer; }
    .hint { font-size: 11px; color: #888; text-align: center; padding: 10px 0 0; }
    .quicks { display: flex; gap: 6px; padding-top: 10px; flex-wrap: wrap; justify-content: center; }
    .quick-btn {
      padding: 5px 10px; background: #3d3d5c; border: 1px solid #555;
      border-radius: 12px; font-size: 11px; cursor: pointer; color: #aaa;
    }
    .quick-btn:hover { background: #4d4d6c; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.55; } }
  </style>
</head>
<body>
  <div class="phone">
    <div class="header">
      <h1>🌾 ArdaLink Voice</h1>
      <div class="lang-toggle">
        <button id="langSw" class="active" onclick="setLang('sw')">SW</button>
        <button id="langEn" onclick="setLang('en')">EN</button>
      </div>
      <span class="status" id="status">Ready</span>
    </div>

    <div class="badges" id="badges">
      <span class="badge" id="providerBadge">provider: —</span>
      <span class="badge" id="latencyBadge">— ms</span>
      <span class="badge" id="ttsBadge">tts: —</span>
      <span class="badge" id="sttBadge">mic: —</span>
    </div>

    <div class="conversation" id="conversation">
      <div class="message ai">
        <div class="speaker">ArdaLink AI</div>
        <div>Press "Start Call" — the AI will greet you in Swahili and you can reply by voice or text.</div>
      </div>
    </div>

    <div class="controls">
      <button class="btn btn-call" id="callBtn" onclick="startCall()">📞 Start Call</button>
      <button class="btn btn-mic" id="micBtn" disabled onmousedown="startMic()" onmouseup="stopMic()"
        ontouchstart="startMic()" ontouchend="stopMic()">🎙 Hold to Speak</button>
      <button class="btn btn-hangup" id="hangupBtn" disabled onclick="hangup()">📴 Hang Up</button>
    </div>

    <div class="hint" id="hint">Hold the mic and speak, or type below</div>
    <div class="input-area">
      <input type="text" id="input" placeholder="Type your response…" disabled>
      <button id="sendBtn" onclick="sendTranscript()" disabled>Send</button>
    </div>
    <div class="quicks">
      <button class="quick-btn" onclick="quickReply('Niko Ngare Mara na nina mbuzi')">Niko Ngare Mara</button>
      <button class="quick-btn" onclick="quickReply('Nina ng\\u2019ombe na mbuzi')">Ng'ombe na mbuzi</button>
      <button class="quick-btn" onclick="quickReply('Mifugo wangu wamekonda sana')">Wamekonda</button>
      <button class="quick-btn" onclick="quickReply('Maji hakuna kabisa')">Maji hakuna</button>
    </div>
  </div>

  <script>
    const phoneNumber = '+254711082200';
    let inCall = false;
    let currentQuestion = '';
    let lang = 'sw';
    let currentAudio = null;
    let recognition = null;
    let recognizing = false;
    const sttSupported = 'webkitSpeechRecognition' in window || 'SpeechRecognition' in window;

    // ── Provider badge state ──────────────────────────────────────────────
    function setBadge(id, text, cls) {
      const el = document.getElementById(id);
      el.textContent = text;
      el.className = 'badge' + (cls ? ' ' + cls : '');
    }
    setBadge('sttBadge', sttSupported ? 'mic: browser STT ready' : 'mic: not supported (type instead)', sttSupported ? 'live' : 'warn');

    // Probe /api/speech/status once so the TTS badge is honest
    fetch('/api/speech/status').then(r => r.json()).then(d => {
      if (d.configured) setBadge('ttsBadge', 'tts: Azure ' + d.region, 'live');
      else setBadge('ttsBadge', 'tts: not configured', 'warn');
    }).catch(() => setBadge('ttsBadge', 'tts: offline', 'warn'));

    // ── UI helpers ────────────────────────────────────────────────────────
    function setStatus(text, cls) {
      const s = document.getElementById('status');
      s.textContent = text; s.className = 'status ' + (cls || '');
    }
    function addMessage(text, speaker, isAi, meta) {
      const conv = document.getElementById('conversation');
      const msg = document.createElement('div');
      msg.className = 'message ' + (isAi ? 'ai' : 'herder');
      msg.innerHTML =
        '<div class="speaker">' + speaker + '</div>' +
        '<div>' + text + '</div>' +
        (meta ? '<div class="meta-line">' + meta + '</div>' : '');
      conv.appendChild(msg); conv.scrollTop = conv.scrollHeight;
    }
    function setLang(v) {
      lang = v;
      document.getElementById('langSw').classList.toggle('active', v === 'sw');
      document.getElementById('langEn').classList.toggle('active', v === 'en');
      if (recognition) recognition.lang = v === 'sw' ? 'sw-KE' : 'en-KE';
    }

    // ── TTS playback ──────────────────────────────────────────────────────
    async function speak(text) {
      if (!text || !text.trim()) return;
      try {
        if (currentAudio) { currentAudio.pause(); currentAudio.src = ''; }
        setStatus('speaking…', 'speaking');
        const r = await fetch('/api/speech/tts', {
          method: 'POST', headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({ text: text, lang: lang })
        });
        if (!r.ok) throw new Error('tts ' + r.status);
        const blob = await r.blob();
        const url = URL.createObjectURL(blob);
        currentAudio = new Audio(url);
        currentAudio.onended = () => { if (inCall) setStatus('Connected', 'connected'); };
        await currentAudio.play();
      } catch (e) {
        console.warn('TTS failed', e);
        setStatus('Connected', 'connected');
      }
    }

    // ── Call lifecycle ────────────────────────────────────────────────────
    async function startCall() {
      inCall = true;
      document.getElementById('callBtn').disabled = true;
      document.getElementById('callBtn').textContent = '☎️ Calling…';
      setStatus('Calling…', 'calling');
      try {
        const r = await fetch('/api/demo/voice/start', {
          method: 'POST', headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({ phone: phoneNumber })
        });
        const data = await r.json();
        if (!data.started) throw new Error('start_failed');
        setStatus('Connected', 'connected');
        document.getElementById('callBtn').style.display = 'none';
        document.getElementById('micBtn').disabled = !sttSupported;
        document.getElementById('hangupBtn').disabled = false;
        document.getElementById('input').disabled = false;
        document.getElementById('sendBtn').disabled = false;
        document.getElementById('conversation').innerHTML = '';
        const greeting = data.greeting || 'Habari yako. Mimi ni ArdaLink.';
        addMessage(greeting, 'ArdaLink', true);
        currentQuestion = data.question || '';
        if (currentQuestion) addMessage(currentQuestion, 'ArdaLink', true);
        // Speak greeting + question as one utterance for a natural call feel
        await speak([greeting, currentQuestion].filter(Boolean).join(' '));
      } catch (e) {
        setStatus('Failed', 'ended');
        inCall = false;
        document.getElementById('callBtn').disabled = false;
        document.getElementById('callBtn').textContent = '📞 Start Call';
        addMessage('Connection failed: ' + e.message, 'System', false);
      }
    }

    async function sendTranscript(text) {
      if (!inCall) return;
      const input = document.getElementById('input');
      const value = (typeof text === 'string' ? text : input.value).trim();
      if (!value) return;
      addMessage(value, 'You', false);
      input.value = '';
      setStatus('thinking…', 'calling');
      try {
        const r = await fetch('/api/demo/voice/message', {
          method: 'POST', headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({ phone: phoneNumber, transcript: value, previousQuestion: currentQuestion })
        });
        const data = await r.json();
        if (data.meta) {
          setBadge('providerBadge', 'provider: ' + data.meta.provider + '/' + data.meta.model, 'live');
          setBadge('latencyBadge', data.meta.latencyMs + ' ms' + (data.meta.cached ? ' (cached)' : ''), '');
        }
        const parts = [];
        if (data.response) { addMessage(data.response, 'ArdaLink', true); parts.push(data.response); }
        if (data.question) { addMessage(data.question, 'ArdaLink', true); currentQuestion = data.question; parts.push(data.question); }
        await speak(parts.join(' '));
        if (data.shouldEnd) setTimeout(hangup, 1200);
      } catch (e) {
        addMessage('Error: ' + e.message, 'System', false);
        setStatus('Connected', 'connected');
      }
    }

    function quickReply(t) { sendTranscript(t); }

    // ── Mic (push-to-talk) ────────────────────────────────────────────────
    function ensureRecognition() {
      if (recognition) return recognition;
      const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!Ctor) return null;
      recognition = new Ctor();
      recognition.continuous = false;
      recognition.interimResults = false;
      recognition.lang = lang === 'sw' ? 'sw-KE' : 'en-KE';
      recognition.onresult = (ev) => {
        const t = Array.from(ev.results).map(r => r[0].transcript).join(' ').trim();
        if (t) sendTranscript(t);
      };
      recognition.onerror = (ev) => {
        console.warn('STT err', ev.error);
        setStatus('Connected', 'connected');
      };
      recognition.onend = () => {
        recognizing = false;
        document.getElementById('micBtn').classList.remove('recording');
        if (inCall) setStatus('Connected', 'connected');
      };
      return recognition;
    }
    function startMic() {
      if (!inCall) return;
      const r = ensureRecognition();
      if (!r) { setBadge('sttBadge', 'mic: not supported', 'warn'); return; }
      if (recognizing) return;
      if (currentAudio) currentAudio.pause();
      try {
        r.lang = lang === 'sw' ? 'sw-KE' : 'en-KE';
        r.start();
        recognizing = true;
        document.getElementById('micBtn').classList.add('recording');
        setStatus('listening…', 'listening');
      } catch (e) { console.warn(e); }
    }
    function stopMic() {
      if (recognition && recognizing) recognition.stop();
    }

    function hangup() {
      inCall = false;
      if (currentAudio) currentAudio.pause();
      if (recognition && recognizing) { try { recognition.stop(); } catch (_){} }
      document.getElementById('callBtn').style.display = '';
      document.getElementById('callBtn').textContent = '📞 Start Call';
      document.getElementById('callBtn').disabled = false;
      document.getElementById('micBtn').disabled = true;
      document.getElementById('hangupBtn').disabled = true;
      document.getElementById('input').disabled = true;
      document.getElementById('sendBtn').disabled = true;
      setStatus('Call ended', 'ended');
      currentQuestion = '';
      fetch('/api/demo/voice/end', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ phone: phoneNumber })
      }).catch(() => {});
      addMessage('Call ended. Asante.', 'System', false);
    }

    document.getElementById('input').addEventListener('keypress', (e) => {
      if (e.key === 'Enter') sendTranscript();
    });
  </script>
</body>
</html>
  `);
});

/**
 * POST /api/demo/voice/start
 *
 * Starts a voice session and returns the initial greeting.
 */
router.post("/start", async (req: Request, res: Response): Promise<void> => {
  const { phone = "+254711082200" } = req.body as { phone?: string };

  try {
    // Create session
    const session = createSession(phone, "voice");

    // Load intelligence context
    const intelContext = loadIntelligenceContext();

    // Generate opening script using the existing intelligence result
    const lastResult = intelContext.lastResult;
    let greeting = "Habari! Mimi ni ArdaLink, msimamizi wa malisho.";
    let question = "Uko wapi leo na mifugo yako?";

    if (lastResult?.script) {
      greeting = lastResult.script.script;
      question = lastResult.script.question;
    } else {
      // Fallback greeting
      greeting = "Habari yako! Mimi ni ArdaLink. Tunafanya kazi ya kufuatilia hali ya malisho kupiga satellite.";
      question = "Uko wapi leo na unafuga mifugo aina gani?";
    }

    res.json({
      phone,
      started: true,
      sessionId: session.phone,
      greeting,
      question,
      satelliteAvailable: intelContext.satellite !== null,
    });
  } catch (err: unknown) {
    res.status(500).json({
      error: "voice_start_failed",
      message: err instanceof Error ? err.message : String(err),
    });
  }
});

/**
 * POST /api/demo/voice/message
 *
 * Processes a transcript message (simulating speech recognition)
 * and returns the AI response.
 */
router.post("/message", async (req: Request, res: Response): Promise<void> => {
  const { phone = "+254711082200", transcript = "", previousQuestion } = req.body as {
    phone?: string;
    transcript?: string;
    previousQuestion?: string;
  };

  try {
    const session = getSession(phone);
    if (!session) {
      res.status(404).json({ error: "session_not_found" });
      return;
    }

    // Parse voice input
    const parsed: ParsedInput = parseVoiceInput(phone, transcript);

    // Load intelligence context
    const intelContext = loadIntelligenceContext();

    // Generate AI response
    const aiResponse = await generateAiResponse(parsed, intelContext, previousQuestion);

    // Format for voice
    const formatted = VoiceAdapter.format(aiResponse);

    // Update session
    updateSession(phone, {
      lastQuestion: formatted.question,
    });

    res.json({
      phone,
      response: formatted.text,
      question: formatted.question,
      shouldEnd: formatted.shouldEnd,
      timestamp: new Date().toISOString(),
      meta: aiResponse.meta ?? null,
    });
  } catch (err: unknown) {
    res.status(500).json({
      error: "voice_message_failed",
      message: err instanceof Error ? err.message : String(err),
    });
  }
});

/**
 * POST /api/demo/voice/end
 *
 * Ends a voice session.
 */
router.post("/end", (req: Request, res: Response): void => {
  const { phone = "+254711082200" } = req.body as { phone?: string };
  endSession(phone);
  res.json({ ended: true });
});

/**
 * GET /api/demo/voice/state?phone=...
 *
 * Get current session state.
 */
router.get("/state", (req: Request, res: Response): void => {
  const phone = (req.query.phone as string) ?? "+254711082200";
  const session = getSession(phone);

  if (!session) {
    res.status(404).json({ error: "session_not_found" });
    return;
  }

  res.json({
    phone: session.phone,
    channel: session.channel,
    startedAt: session.startedAt,
    lastInteraction: session.lastInteraction,
    lastQuestion: session.lastQuestion,
    indicatorState: session.indicatorState,
  });
});

function deterministicDemoHtml(): string {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ArdaLink — Call Simulator (Kiswahili / English)</title>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      max-width: 560px; margin: 0 auto; padding: 20px;
      background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%);
      min-height: 100vh; color: #f1f5f9;
    }
    .card { background: #1e293b; border-radius: 20px; padding: 22px; box-shadow: 0 20px 60px rgba(0,0,0,0.5); }
    h1 { font-size: 18px; margin: 0 0 4px; color: #4ade80; }
    .sub { font-size: 12px; color: #94a3b8; margin-bottom: 14px; }
    label { display: block; font-size: 12px; color: #94a3b8; margin: 12px 0 6px; text-transform: uppercase; letter-spacing: 1px; }
    select, button {
      width: 100%; padding: 12px 14px; border-radius: 12px; border: 1px solid #334155;
      background: #0f172a; color: #f1f5f9; font-size: 14px;
    }
    button { cursor: pointer; font-weight: 600; margin-top: 8px; }
    .btn-record { background: #ef4444; color: #fff; border-color: #dc2626; }
    .btn-record.recording { animation: pulse 1.2s infinite; }
    .btn-stop { background: #64748b; color: #fff; border-color: #475569; }
    .btn-stop:disabled, .btn-record:disabled { opacity: 0.4; cursor: not-allowed; }
    .meter { display: flex; align-items: center; gap: 10px; padding: 12px 0; }
    .meter .bar { flex: 1; height: 6px; background: #0f172a; border-radius: 3px; overflow: hidden; }
    .meter .bar > div { height: 100%; background: linear-gradient(90deg, #4ade80, #fbbf24, #ef4444); width: 0%; transition: width 0.08s linear; }
    .timer { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: #cbd5e1; font-size: 14px; }
    .status { font-size: 12px; color: #94a3b8; padding-top: 6px; text-align: center; }
    .status.busy { color: #fbbf24; }
    .status.ok { color: #4ade80; }
    .status.err { color: #ef4444; }
    .report { margin-top: 14px; padding: 14px; background: #0f172a; border: 1px solid #334155; border-radius: 14px; font-size: 13px; }
    .report h3 { margin: 0 0 8px; font-size: 14px; color: #4ade80; }
    .report .row { display: flex; justify-content: space-between; padding: 3px 0; border-bottom: 1px solid #1e293b; gap: 12px; }
    .report .row .k { color: #94a3b8; }
    .report .row .v { color: #f1f5f9; font-weight: 600; text-align: right; }
    .transcript { padding: 10px 12px; background: #0f172a; border-left: 3px solid #4ade80; border-radius: 4px; font-style: italic; color: #cbd5e1; margin-top: 8px; }
    .hidden { display: none; }
    .badges { display: flex; gap: 6px; padding: 8px 0; font-size: 11px; }
    .badge { background: #0f172a; border: 1px solid #334155; padding: 3px 8px; border-radius: 12px; color: #cbd5e1; }
    .badge.live { border-color: #4ade80; color: #4ade80; }
    .badge.warn { border-color: #fbbf24; color: #fbbf24; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
  </style>
</head>
<body>
  <div class="card">
    <h1>📞 ArdaLink Call Simulator</h1>
    <div class="sub">Full deterministic call flow, in the caller's own language. Opener → DTMF menu → category → 20 s record → indicator extraction. Same pipeline Africa's Talking hits for real herder calls.</div>

    <div class="badges">
      <span class="badge" id="sttBadge">stt: —</span>
      <span class="badge" id="micBadge">mic: —</span>
      <span class="badge live">llm: azure/gpt-5-mini</span>
      <span class="badge" id="engineBadge">engine: —</span>
      <span class="badge" id="langBadge">lang: —</span>
      <span class="badge" id="herderBadge">herder: —</span>
    </div>

    <!-- Live engine snapshot — appears after context lookup so
         operators can see the caller's satellite data came fresh
         from Google Earth Engine seconds ago, not from a stale
         monthly aggregate. -->
    <div id="engineSnapshot" class="hidden" style="margin-top:10px;padding:12px;background:linear-gradient(135deg,#065f46 0%,#064e3b 100%);border-radius:12px;border:1px solid #10b981;">
      <div style="font-size:11px;color:#a7f3d0;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">🛰 Live from GEE engine</div>
      <div id="engineFacts" style="display:grid;grid-template-columns:repeat(2,1fr);gap:6px 12px;font-size:12px;color:#ecfdf5;"></div>
      <div id="engineFresh" style="font-size:10px;color:#6ee7b7;margin-top:6px;"></div>
    </div>

    <label for="phone">Caller phone (used to look up ward, language, and history)</label>
    <input type="tel" id="phone" placeholder="+254712000004" style="width:100%;padding:12px 14px;border-radius:12px;border:1px solid #334155;background:#0f172a;color:#f1f5f9;font-size:14px;" />
    <button id="startCallBtn" style="width:100%;padding:12px;margin-top:8px;border-radius:12px;border:none;background:#22c55e;color:#fff;font-size:14px;font-weight:600;cursor:pointer;">📞 Start Call</button>

    <!-- Call transcript — grows as the sequence advances -->
    <div id="callTranscript" class="hidden" style="margin-top:14px;display:flex;flex-direction:column;gap:6px;"></div>

    <!-- DTMF keypad — appears after opener + menu play -->
    <div id="dtmfKeypad" class="hidden" style="margin-top:12px;">
      <div style="font-size:12px;color:#94a3b8;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Press a key to answer</div>
      <div id="dtmfButtons" style="display:grid;grid-template-columns:repeat(2,1fr);gap:8px;"></div>
    </div>

    <!-- Recording controls — appear after confirmation plays -->
    <div id="recordingBlock" class="hidden" style="margin-top:12px;">
      <button class="btn-record" id="recordBtn">🔴 Record answer (20 s max)</button>
      <button class="btn-stop" id="stopBtn" disabled>⏹ Stop &amp; send</button>
      <div class="meter">
        <span class="timer" id="timer">0.0 s</span>
        <div class="bar"><div id="micBar"></div></div>
      </div>
    </div>

    <div class="status" id="status">Enter a phone and press Start Call.</div>

    <div id="reportSection" class="hidden">
      <div class="report">
        <h3>📋 Ground truth extracted</h3>
        <div id="transcriptSection" class="transcript">Waiting…</div>
        <div id="reportBody">Processing…</div>
      </div>
    </div>
  </div>

<script>
(async () => {
  const els = {
    recordBtn: document.getElementById('recordBtn'),
    stopBtn: document.getElementById('stopBtn'),
    micBar: document.getElementById('micBar'),
    timer: document.getElementById('timer'),
    status: document.getElementById('status'),
    sttBadge: document.getElementById('sttBadge'),
    micBadge: document.getElementById('micBadge'),
    langBadge: document.getElementById('langBadge'),
    herderBadge: document.getElementById('herderBadge'),
    reportSection: document.getElementById('reportSection'),
    transcriptSection: document.getElementById('transcriptSection'),
    reportBody: document.getElementById('reportBody'),
    phone: document.getElementById('phone'),
    startCallBtn: document.getElementById('startCallBtn'),
    callTranscript: document.getElementById('callTranscript'),
    dtmfKeypad: document.getElementById('dtmfKeypad'),
    dtmfButtons: document.getElementById('dtmfButtons'),
    recordingBlock: document.getElementById('recordingBlock'),
    engineBadge: document.getElementById('engineBadge'),
    engineSnapshot: document.getElementById('engineSnapshot'),
    engineFacts: document.getElementById('engineFacts'),
    engineFresh: document.getElementById('engineFresh'),
  };

  // Call-sequence state. sequence is the payload from
  // /api/demo/voice/context: opener text, menuPrompt, categories,
  // confirmationTemplate, postRecord, noInput, lang. Each stage is a
  // play-then-await pattern; the UI unlocks the next control (keypad
  // or record button) only when the current TTS has finished,
  // mirroring how a real caller would hear the flow.
  let sequence = null;
  let currentAudio = null;
  let selectedCategory = null;

  let stream = null;
  let recorder = null;
  let chunks = [];
  let audioCtx = null;
  let analyser = null;
  let meterRaf = null;
  let startAt = 0;
  let timerId = null;
  let mimeType = 'audio/webm';

  function setStatus(text, cls) {
    els.status.textContent = text;
    els.status.className = 'status' + (cls ? ' ' + cls : '');
  }
  function setBadge(el, text, cls) {
    el.textContent = text; el.className = 'badge' + (cls ? ' ' + cls : '');
  }
  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function show(el) { el.classList.remove('hidden'); }
  function hide(el) { el.classList.add('hidden'); }

  // Append a chat-style bubble to the call transcript. speaker is
  // "ArdaLink" for TTS output or "You" for the caller's keypad taps.
  function pushBubble(speaker, text, kind) {
    const bg = kind === 'you' ? '#3d3d5c' : '#0f172a';
    const border = kind === 'you' ? 'transparent' : '#60a5fa';
    const align = kind === 'you' ? 'flex-end' : 'flex-start';
    const div = document.createElement('div');
    div.style.cssText = 'max-width:88%;padding:10px 12px;background:' + bg + ';border-left:3px solid ' + border + ';border-radius:6px;font-size:13px;color:#e2e8f0;align-self:' + align + ';';
    div.innerHTML = '<div style="opacity:0.6;font-size:10px;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">' + escapeHtml(speaker) + '</div><div>' + escapeHtml(text) + '</div>';
    els.callTranscript.appendChild(div);
    els.callTranscript.scrollTop = els.callTranscript.scrollHeight;
    return div;
  }

  // Speak text via server TTS in the given language. Resolves when
  // playback ends (or immediately if TTS is unavailable — the demo
  // still walks the flow so the transcript stays legible).
  async function say(text, lang) {
    if (!text) return;
    if (currentAudio) { try { currentAudio.pause(); currentAudio.src = ''; } catch(_){} currentAudio = null; }
    try {
      const tts = await fetch('/api/speech/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, lang }),
      });
      if (!tts.ok) return;
      const blob = await tts.blob();
      currentAudio = new Audio(URL.createObjectURL(blob));
      await new Promise((resolve) => {
        currentAudio.onended = resolve;
        currentAudio.onerror = resolve;
        currentAudio.play().catch(resolve);
      });
      currentAudio = null;
    } catch { currentAudio = null; }
  }

  // Probe speech status once so we're honest about availability.
  try {
    const d = await fetch('/api/speech/status').then(r => r.json());
    if (d.configured) setBadge(els.sttBadge, 'stt: Azure Fast (' + d.region + ')', 'live');
    else setBadge(els.sttBadge, 'stt: not configured', 'warn');
  } catch { setBadge(els.sttBadge, 'stt: offline', 'warn'); }

  function renderKeypad(categories) {
    els.dtmfButtons.innerHTML = '';
    categories.forEach((c) => {
      const btn = document.createElement('button');
      btn.style.cssText = 'padding:12px 8px;border-radius:12px;border:1px solid #334155;background:#0f172a;color:#e2e8f0;font-size:13px;cursor:pointer;text-align:left;';
      btn.innerHTML = '<span style="display:inline-block;width:22px;height:22px;line-height:22px;text-align:center;background:#22c55e;color:#0f172a;border-radius:50%;font-weight:700;margin-right:8px;font-size:12px;">' + c.dtmf + '</span>' + escapeHtml(c.label);
      btn.addEventListener('click', () => onKeypadPress(c));
      els.dtmfButtons.appendChild(btn);
    });
  }

  async function startCall() {
    const phone = els.phone.value.trim();
    if (!phone) { setStatus('Enter a phone first.', 'err'); return; }
    els.startCallBtn.disabled = true;
    els.startCallBtn.style.opacity = 0.5;
    hide(els.reportSection);
    hide(els.dtmfKeypad);
    hide(els.recordingBlock);
    els.callTranscript.innerHTML = '';
    show(els.callTranscript);
    setStatus('Dialling… looking up caller.', 'busy');

    let data;
    try {
      const r = await fetch('/api/demo/voice/context?phone=' + encodeURIComponent(phone));
      data = await r.json();
      if (!r.ok) { setStatus('Lookup failed.', 'err'); resetCallButton(); return; }
    } catch (e) {
      setStatus('Lookup error: ' + e.message, 'err');
      resetCallButton();
      return;
    }

    sequence = data.sequence;
    const ctx = data.ctx || {};
    const snap = data.engineSnapshot;
    setBadge(els.langBadge, 'lang: ' + sequence.lang, 'live');
    if (ctx.known) {
      setBadge(els.herderBadge, 'herder: ' + (ctx.name || phone), 'live');
    } else {
      setBadge(els.herderBadge, 'herder: new caller', 'warn');
    }

    // Render live engine snapshot pill if we got one from the engine.
    if (snap) {
      setBadge(els.engineBadge, 'engine: LIVE (VCI ' + snap.vci.toFixed(1) + ')', 'live');
      renderEngineSnapshot(snap);
      show(els.engineSnapshot);
    } else {
      setBadge(els.engineBadge, 'engine: unreachable', 'warn');
      hide(els.engineSnapshot);
    }

    // Stage 1 — opener. Show + speak, then advance.
    setStatus('ArdaLink is speaking (opener)…', 'busy');
    pushBubble('ArdaLink', sequence.opener, 'ai');
    await say(sequence.opener, sequence.lang);

    // Stage 2 — DTMF menu prompt. Show + speak, then unlock keypad.
    setStatus('ArdaLink is speaking (menu)…', 'busy');
    pushBubble('ArdaLink', sequence.menuPrompt, 'ai');
    await say(sequence.menuPrompt, sequence.lang);

    renderKeypad(sequence.categories);
    show(els.dtmfKeypad);
    setStatus('Waiting for your keypad press…', 'ok');
  }

  function resetCallButton() {
    els.startCallBtn.disabled = false;
    els.startCallBtn.style.opacity = 1;
  }

  function renderEngineSnapshot(snap) {
    // Six live facts fresh from the GEE MODIS composite the engine
    // pulled seconds ago: VCI 0-100, current NDVI, historic MODIS
    // min/max range, whether urban pixels were masked, and the
    // Prosopis penalty factor. This is the "the demo is real" pill.
    const facts = [
      ['VCI',            snap.vci.toFixed(1) + ' / 100'],
      ['NDVI now',       snap.ndviNow.toFixed(3)],
      ['NDVI min',       snap.ndviMin.toFixed(3)],
      ['NDVI max',       snap.ndviMax.toFixed(3)],
      ['Urban masked',   snap.urbanMasked ? 'yes' : 'no'],
      ['Prosopis factor', snap.prosopisFactor.toFixed(2)],
    ];
    els.engineFacts.innerHTML = facts.map(function(f) {
      return '<div><span style="color:#6ee7b7">' + escapeHtml(f[0]) + '</span> <b>' + escapeHtml(String(f[1])) + '</b></div>';
    }).join('');
    // Freshness — how many seconds ago the engine captured this data.
    var age = '(unknown age)';
    try {
      var capMs = Date.parse(snap.capturedAt);
      if (!isNaN(capMs)) {
        var s = Math.max(0, Math.round((Date.now() - capMs) / 1000));
        age = s < 60 ? s + ' s ago' : Math.round(s / 60) + ' min ago';
      }
    } catch(_) {}
    els.engineFresh.textContent = 'Captured ' + age + ' · ward ' + (snap.wardName || '');
  }

  async function onKeypadPress(c) {
    if (!sequence) return;
    selectedCategory = c;
    hide(els.dtmfKeypad);
    pushBubble('You', c.dtmf + ' — ' + c.label, 'you');
    // Substitute the picked label into the confirmation template.
    const conf = (sequence.confirmationTemplate || '').replace('{{label}}', c.label);
    pushBubble('ArdaLink', conf, 'ai');
    setStatus('ArdaLink is speaking (confirmation)…', 'busy');
    await say(conf, sequence.lang);
    // Unlock the recording controls once the confirmation has finished.
    show(els.recordingBlock);
    setStatus('Press Record and speak your answer.', 'ok');
  }

  els.startCallBtn.addEventListener('click', startCall);

  async function ensureStream() {
    if (stream) return stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
      setBadge(els.micBadge, 'mic: ready', 'live');
    } catch (e) {
      setBadge(els.micBadge, 'mic: denied', 'warn');
      throw e;
    }
    return stream;
  }

  function pickMime() {
    const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
    for (const c of candidates) if (window.MediaRecorder && MediaRecorder.isTypeSupported(c)) return c;
    return '';
  }

  function startMeter() {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const src = audioCtx.createMediaStreamSource(stream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    src.connect(analyser);
    const buf = new Uint8Array(analyser.fftSize);
    let peak = 0;
    const tick = () => {
      analyser.getByteTimeDomainData(buf);
      let sumSq = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = (buf[i] - 128) / 128;
        sumSq += v * v;
      }
      const rms = Math.sqrt(sumSq / buf.length);
      peak = Math.max(peak * 0.9, Math.min(1, rms * 4));
      els.micBar.style.width = (peak * 100).toFixed(0) + '%';
      meterRaf = requestAnimationFrame(tick);
    };
    tick();
  }

  function stopMeter() {
    if (meterRaf) cancelAnimationFrame(meterRaf);
    if (audioCtx) { try { audioCtx.close(); } catch(_){} }
    audioCtx = null; analyser = null; meterRaf = null;
    els.micBar.style.width = '0%';
  }

  async function beginRecording() {
    els.reportSection.classList.add('hidden');
    els.recordBtn.disabled = true;
    els.recordBtn.classList.add('recording');
    els.stopBtn.disabled = false;
    try {
      await ensureStream();
    } catch (e) {
      setStatus('Microphone denied.', 'err');
      els.recordBtn.disabled = false;
      els.recordBtn.classList.remove('recording');
      els.stopBtn.disabled = true;
      return;
    }
    mimeType = pickMime();
    chunks = [];
    try {
      recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    } catch (e) {
      setStatus('MediaRecorder unsupported: ' + e.message, 'err');
      return;
    }
    recorder.ondataavailable = (ev) => { if (ev.data && ev.data.size > 0) chunks.push(ev.data); };
    recorder.onstop = () => uploadAndProcess();
    recorder.start();
    startAt = Date.now();
    startMeter();
    setStatus('Listening… speak now.', 'busy');
    timerId = setInterval(() => {
      const s = (Date.now() - startAt) / 1000;
      els.timer.textContent = s.toFixed(1) + ' s';
      if (s >= 20) endRecording();
    }, 100);
  }

  function endRecording() {
    if (!recorder || recorder.state === 'inactive') return;
    if (timerId) { clearInterval(timerId); timerId = null; }
    try { recorder.stop(); } catch(_) {}
    els.recordBtn.classList.remove('recording');
    els.stopBtn.disabled = true;
    stopMeter();
  }

  async function uploadAndProcess() {
    setStatus('Transcribing + extracting indicators…', 'busy');
    const blob = new Blob(chunks, { type: mimeType || 'audio/webm' });
    const category = (selectedCategory && selectedCategory.id) || 'drought_signal';
    const phone = els.phone.value.trim();
    try {
      const qs = new URLSearchParams({ category });
      if (phone) qs.set('phone', phone);
      const r = await fetch('/api/demo/voice/record?' + qs.toString(), {
        method: 'POST',
        headers: { 'Content-Type': blob.type },
        body: blob,
      });
      const data = await r.json();
      els.recordBtn.disabled = false;
      if (!r.ok || !data.ok) {
        setStatus('Failed: ' + (data.error || r.statusText), 'err');
        return;
      }
      // Stage 4 — caller hears the post-record thanks in their
      // language before the report renders. Feels like the real
      // asante-kwaheri close of an AT call.
      pushBubble('You', data.transcript || '(no transcript)', 'you');
      if (sequence && sequence.postRecord) {
        pushBubble('ArdaLink', sequence.postRecord, 'ai');
        setStatus('ArdaLink is speaking (thanks)…', 'busy');
        await say(sequence.postRecord, sequence.lang);
      }
      setStatus('Call complete. Report #' + data.reportId + ' captured.', 'ok');
      show(els.reportSection);
      els.transcriptSection.innerHTML = '"' + escapeHtml(data.transcript) + '"' + (data.detectedLocale ? ' <span style="color:#94a3b8">— ' + data.detectedLocale + '</span>' : '');
      renderReport(data);
      resetCallButton();
    } catch (e) {
      setStatus('Upload error: ' + e.message, 'err');
      els.recordBtn.disabled = false;
    }
  }

  function renderReport(d) {
    const ind = d.indicators || {};
    const rows = [
      ['Action tag', d.actionTag],
      ['Location', ind.reported_location || ind.reported_quadrant || '(not shared)'],
      ['Species', ind.bcs_species],
      ['BCS score', ind.bcs_score != null ? ind.bcs_score + ' (' + (ind.bcs_confidence || '') + ')' : null],
      ['Mortality', ind.mortality_rate],
      ['Milk', ind.milk_production],
      ['Water trekking', ind.water_trekking_distance],
      ['Water point', ind.water_point_name && ind.water_point_status ? (ind.water_point_name + ' — ' + ind.water_point_status) : null],
      ['Supplementary feed', ind.supplementary_feeding],
      ['Offtake', ind.offtake_rate],
      ['Indicators collected', (ind.indicators_collected ?? 0) + ' / 7 (' + (d.dataCompletenessPercent || 0).toFixed(0) + '%)'],
      ['Trust score', d.trustScore],
      ['Report #', d.reportId],
    ];
    const html = rows.filter(r => r[1] != null && r[1] !== '' && r[1] !== 'null')
      .map(r => '<div class="row"><span class="k">' + escapeHtml(r[0]) + '</span><span class="v">' + escapeHtml(String(r[1])) + '</span></div>')
      .join('');
    els.reportBody.innerHTML = html || 'No structured indicators extracted — try again with more detail.';
  }

  els.recordBtn.addEventListener('click', beginRecording);
  els.stopBtn.addEventListener('click', endRecording);
})();
</script>
</body>
</html>
  `;
}

export default router;
