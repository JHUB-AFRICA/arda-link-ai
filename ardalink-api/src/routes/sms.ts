import { Router, type IRouter, type Request, type Response } from "express";
import { logger } from "../lib/logger.js";
import {
  resolveHerderContext,
  buildLocalizedBrief,
} from "../lib/herderContext/index.js";
import { centroidForTenant, formatUssdLines } from "../lib/wpdx.js";
import { formatRealWaterLines } from "../lib/waterNodes.js";
import { tenantForWardId } from "../lib/wardMapping.js";
import { languageForCaller } from "../lib/voiceCopy.js";
import { initiateOutboundCall, sendSmsViaAt } from "../lib/africastalking.js";
import {
  logLeadInteraction,
  insertGroundTruthCall,
  isSupabaseConfigured,
} from "../lib/supabase/index.js";

const DEFAULT_TENANT_ID =
  process.env.DETERMINISTIC_TENANT_ID ?? "bula-pesa";

// Optional: Use the new intelligenceCore if ENABLE_INTELLIGENCE_CORE is set
const useIntelligenceCore = process.env.ENABLE_INTELLIGENCE_CORE === "true";

/**
 * Africa's Talking inbound SMS callback.
 *
 * AT POSTs form-encoded:
 *   from, to, text, date, id, linkId
 *
 * Keywords handled:
 *   BULA       → reply with the Bula Pesa brief + trigger a voice call
 *   MALISHO    → reply with the nearest water points
 *   ONGEA      → reply confirming + trigger a voice call
 *   STOP / SITAKI → opt the number out of future auto-callbacks
 *
 * Reply format is plain text — AT forwards the response body as the SMS
 * body. We keep replies under 160 chars so a single SMS segment is enough.
 *
 * Sandbox: AT's SMS simulator sends the exact same shape to this callback,
 * so the sandbox-simulate.mjs script can exercise both voice AND SMS paths
 * without a real tunnel or sim card.
 */
const router: IRouter = Router();

const MAX_REPLY_CHARS = 160;
const AT_SANDBOX_NUMBER = "+254711082200";

interface SmsBody {
  from?: string;
  to?: string;
  text?: string;
  date?: string;
  id?: string;
  linkId?: string;
}

function normalise(text: string): string {
  return text.trim().toUpperCase().split(/\s+/)[0] ?? "";
}

function trimToSms(text: string): string {
  if (text.length <= MAX_REPLY_CHARS) return text;
  return text.slice(0, MAX_REPLY_CHARS - 1) + "…";
}

router.post("/sms-callback", async (req, res): Promise<void> => {
  const body = (req.body ?? {}) as SmsBody;
  const from = typeof body.from === "string" ? body.from : AT_SANDBOX_NUMBER;
  const rawText = typeof body.text === "string" ? body.text : "";
  const keyword = normalise(rawText);

  // Use the new intelligenceCore if enabled (for unified AI across channels)
  if (useIntelligenceCore) {
    return handleSmsWithCore(req, res, from, rawText);
  }

  req.log.info(
    {
      from,
      to: body.to ?? "(unknown)",
      keyword,
      rawTextLen: rawText.length,
      smsId: body.id ?? "(none)",
    },
    "[SMS] Inbound keyword",
  );

  // AT's inbound SMS webhook contract does NOT treat the HTTP response
  // body as an auto-reply (that's USSD's convention). For SMS we have
  // to explicitly POST to /version1/messaging to send a reply. We fire
  // sendSmsViaAt with bypassRateLimit=true because these are direct
  // responses to the herder's own inbound — they're not proactive
  // dispatch and shouldn't count against the daily-drill cap.
  //
  // We still put the text in the HTTP response body as a defensive
  // fallback (some AT products / older sandbox versions do consume it),
  // and to keep test fixtures / grep-based CI checks stable.
  //
  // Every reply also logs a lead_interactions row so the ops
  // CallbackLog panel can show what the herder saw. Tier is
  // captured at reply-time so ops can filter for leads vs verified.
  let capturedTier: "verified" | "lead" | "unknown" = "unknown";
  let capturedWardId: string | null = null;
  const reply = (text: string): void => {
    const smsBody = trimToSms(text);
    res.set("Content-Type", "text/plain");
    res.send(smsBody);
    if (smsBody && from) {
      void sendSmsViaAt(from, smsBody, { bypassRateLimit: true });
    }
    void logLeadInteraction({
      phone_number: from,
      tier: capturedTier,
      channel: "sms",
      session_id: body.id ?? null,
      keyword,
      input_text: rawText,
      reply_text: smsBody || null,
      ward_id: capturedWardId,
      raw_body: { to: body.to ?? null, smsId: body.id ?? null },
    });
  };

  try {
    // Resolve the caller's context once so every reply is
    // language-aware + personalized. Unknown callers get a bounded
    // default context that still routes on Kiswahili.
    const ctx = await resolveHerderContext(from, DEFAULT_TENANT_ID);
    const lang = languageForCaller(ctx);
    capturedTier = ctx.tier;
    capturedWardId = ctx.wardId ?? null;

    switch (keyword) {
      case "BULA": {
        // Full localized brief — the same one USSD selection 1
        // renders. buildLocalizedBrief caps at 300 chars and
        // trimToSms trims to 160 for the SMS segment.
        //
        // NOTE (2026-07-12): BULA no longer triggers a voice
        // callback. It's a pull-brief keyword — the reply IS the
        // response. ONGEA is the dedicated call-me-back keyword;
        // the daily drill cron is what does proactive outreach.
        // The legacy maybeCallback() dependency was throwing when
        // the intelligence cycle hadn't populated a .script yet,
        // which surfaced as an unhelpful "hitilafu" error reply.
        const brief = buildLocalizedBrief(ctx, lang);
        reply(brief);
        return;
      }
      case "MALISHO": {
        // WPDx-backed water points (same as USSD selection 2 and
        // the demo SMS simulator). Prefer working infrastructure
        // first so herders see the good options at the top.
        //
        // Real, confirmed bug (2026-08-06, same pattern as WhatsApp's
        // handleMalisho before its own fix): this always resolved
        // centroidForTenant(DEFAULT_TENANT_ID), ignoring ctx.wardId, so
        // every SMS herder outside Bula Pesa got Bula Pesa's water
        // points. Fixed to prefer the herder's own registered location,
        // then their own ward's real centroid (straight from Supabase,
        // no hardcoded fallback table/literal — see wpdx.ts's
        // centroidForTenant).
        const origin =
          ctx.lastKnownLat != null && ctx.lastKnownLon != null
            ? { lat: ctx.lastKnownLat, lon: ctx.lastKnownLon }
            : ((await centroidForTenant(tenantForWardId(ctx.wardId))) ??
              (await centroidForTenant(DEFAULT_TENANT_ID)));
        // Real water_nodes first (see waterNodes.ts); the static WPDx
        // snapshot is only a fallback for an unreachable engine. Capped
        // at 3 (not 5) so the "text MAJI to report" hint below survives
        // the 160-char single-segment budget instead of always getting
        // truncated away — matches WhatsApp handleMalisho's own cap.
        const lines = origin
          ? ((await formatRealWaterLines(origin, 3)) ??
            formatUssdLines(origin, 3, { workingFirst: true }))
          : [];
        const body =
          lines.length > 0
            ? lines.join("; ")
            : lang === "sw"
              ? "Hakuna data ya WPDx bado"
              : "No WPDx data yet";
        reply(
          (lang === "sw" ? "Malisho karibu nawe: " : "Water points near you: ") +
            body +
            (lang === "sw"
              ? " Tuma MAJI SAWA/MBAYA kuripoti."
              : " Text MAJI SAWA/MBAYA to report."),
        );
        return;
      }
      case "MAJI":
      case "WATER": {
        // Ground-truth confirm — most water_nodes rows are unsurveyed
        // ("unknown"), not broken, and a herder close enough to know one
        // is the best source we have for turning that into a real
        // answer. References ctx.nearestWaterPointName — the same point
        // the MALISHO reply just showed as nearest — so no extra state
        // needs to be threaded across this stateless keyword callback.
        const statusWord = (rawText.trim().split(/\s+/)[1] ?? "").toUpperCase();
        const isWorking = /^(SAWA|POA|OK|FINE|WORKING)$/.test(statusWord);
        const isBroken = /^(MBAYA|HARIBIKA|IMEHARIBIKA|BROKEN|BAD|DRY|KAVU)$/.test(
          statusWord,
        );
        if (!isWorking && !isBroken) {
          reply(
            lang === "sw"
              ? "Tuma 'MAJI SAWA' (inafanya kazi) au 'MAJI MBAYA' (imeharibika) kuripoti kituo cha karibu nawe."
              : "Text 'MAJI SAWA' (working) or 'MAJI MBAYA' (broken) to report the water point nearest you.",
          );
          return;
        }
        const pointName = ctx.nearestWaterPointName;
        if (!pointName) {
          reply(
            lang === "sw"
              ? "Sina kituo cha maji cha karibu cha kuthibitisha bado. Tuma MALISHO kwanza."
              : "No nearby water point on file to confirm yet. Text MALISHO first.",
          );
          return;
        }
        if (ctx.pastoralistId && ctx.wardId && isSupabaseConfigured()) {
          void insertGroundTruthCall({
            pastoralist_id: ctx.pastoralistId,
            ward_id: ctx.wardId,
            call_timestamp: new Date().toISOString(),
            water_point_name: pointName,
            water_point_status: isWorking ? "operational_good" : "not_operational",
            source_language: lang,
            transcript: rawText,
            channel: "sms",
            reported_lat: ctx.lastKnownLat ?? null,
            reported_lon: ctx.lastKnownLon ?? null,
          });
        }
        reply(
          lang === "sw"
            ? `Asante — tumerekodi ${pointName}: ${isWorking ? "inafanya kazi" : "haifanyi kazi"}.`
            : `Thanks — recorded ${pointName}: ${isWorking ? "working" : "not working"}.`,
        );
        return;
      }
      case "ONGEA":
      case "AI": {
        // Dispatch the outbound call in the background so the SMS
        // reply goes back to the herder immediately. The AT
        // africastalking.ts shim enforces the 1-per-15min voice cap
        // and logs the outcome. Failure fires a follow-up SMS to
        // close the loop (see the .then/.catch below).
        void initiateOutboundCall(from).then((r) => {
          if (!r.ok) {
            void sendSmsViaAt(
              from,
              lang === "sw"
                ? "ArdaLink hakuweza kupiga sasa. Jaribu tena baada ya dakika 15."
                : "ArdaLink could not call now. Please try again in 15 minutes.",
            );
          }
        });
        reply(
          lang === "sw"
            ? "Sawa. ArdaLink inakupigia sasa kupokea ripoti yako."
            : "Okay. ArdaLink is calling you now to record your report.",
        );
        return;
      }
      case "RIPOTI":
      case "REPORT": {
        // My last report — matches the demo SMS handler and the
        // RIPOTI keyword advertised in help. Falls back to a
        // localised "no report yet" when the caller isn't in the
        // ground_truth_reports table for this tenant.
        if (!ctx.known || ctx.lastBcsScore == null) {
          reply(
            lang === "sw"
              ? "Hakuna ripoti bado. Piga ONGEA kuomba simu ya kutoa ripoti."
              : "No report yet. Text ONGEA to request a voice call.",
          );
          return;
        }
        const bcs = ctx.lastBcsScore.toFixed(1);
        const species = ctx.lastBcsSpecies ?? "?";
        const where = ctx.lastReportedLocation
          ? (lang === "sw"
              ? ` Ulisema uko ${ctx.lastReportedLocation}.`
              : ` You said you were at ${ctx.lastReportedLocation}.`)
          : "";
        reply(
          lang === "sw"
            ? `Ripoti yako ya mwisho: BCS ${bcs} (${species}), ${ctx.lastActionTag ?? "hakuna alama"}.${where}`
            : `Your last report: BCS ${bcs} (${species}), ${ctx.lastActionTag ?? "no tag"}.${where}`,
        );
        return;
      }
      case "STOP":
      case "SITAKI":
      case "UNDO": {
        logger.info({ from, keyword }, "[SMS] Opt-out keyword");
        reply("");
        return;
      }
      default: {
        reply(
          lang === "sw"
            ? "ArdaLink: BULA (habari), MALISHO (maji), ONGEA (simu), RIPOTI (yako), STOP (toa)."
            : "ArdaLink: BULA (brief), MALISHO (water), ONGEA (call), RIPOTI (last report), STOP.",
        );
        return;
      }
    }
  } catch (err: unknown) {
    logger.error({ err, from, keyword }, "[SMS] handler error");
    reply(
      "ArdaLink: hitilafu. Jaribu tena. / Error. Try again.",
    );
  }
});

async function readLastBrief(): Promise<{
  stressedPct: number | null;
  riskLevel: string | null;
} | null> {
  try {
    const mod = await import("../lib/intelligence.js");
    const last = mod.getLastResult();
    if (!last?.live?.anomaly) return null;
    return {
      stressedPct: last.live.anomaly.wardStressedPixelPct ?? null,
      riskLevel: last.forecast?.outlook.riskLevel ?? null,
    };
  } catch {
    return null;
  }
}

async function maybeCallback(phone: string, reason: string): Promise<void> {
  try {
    const voiceMod = await import("../lib/voice.js");
    const intelMod = await import("../lib/intelligence.js");
    const last = intelMod.getLastResult();
    if (!last?.live?.anomaly || !last?.script) {
      logger.warn(
        { phone, reason },
        "[SMS] No intelligence cycle yet — cannot trigger contextual callback",
      );
      return;
    }
    voiceMod.storeCallSession(phone, {
      script: last.script.script,
      question: last.script.question,
      delta: last.live.anomaly as never,
      month: last.month_name ?? "now",
      climate: last.climate ?? undefined,
      forecast: last.forecast ?? undefined,
    });
    await voiceMod.initiateCall(phone);
    logger.info({ phone, reason }, "[SMS] Outbound callback triggered");
  } catch (err: unknown) {
    logger.error({ err, phone, reason }, "[SMS] callback failed");
  }
}

/**
 * SMS handler using the new intelligenceCore.
 * This provides unified AI responses across all channels.
 */
async function handleSmsWithCore(
  req: Request,
  res: Response,
  phone: string,
  text: string,
): Promise<void> {
  const {
    parseSmsInput,
    generateAiResponse,
    loadIntelligenceContext,
  } = await import("../lib/channels/intelligenceCore");
  const { SmsAdapter } = await import("../lib/channels/adapters");

  try {
    // Parse input using core
    const parsed = parseSmsInput(phone, text);

    // Load intelligence context
    const intelContext = loadIntelligenceContext();

    // Generate AI response
    const aiResponse = await generateAiResponse(parsed, intelContext);

    // Format for SMS
    const formatted = SmsAdapter.format(aiResponse);

    // Set plain text response for Africa's Talking
    res.set("Content-Type", "text/plain");
    res.send(formatted);

    req.log.info(
      { phone, intent: parsed.intent, ended: aiResponse.ended },
      "[SMS] Response via intelligenceCore",
    );
  } catch (err: unknown) {
    req.log.error({ err, phone }, "[SMS] intelligenceCore error");
    res.set("Content-Type", "text/plain");
    res.status(500).send("ArdaLink: hitilafu. / Error. Try again.");
  }
}

export default router;
