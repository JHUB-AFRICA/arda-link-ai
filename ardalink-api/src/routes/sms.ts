import { Router, type IRouter, type Request, type Response } from "express";
import { logger } from "../lib/logger.js";
import {
  resolveHerderContext,
  buildLocalizedBrief,
} from "../lib/herderContext.js";
import { centroidForTenant, formatUssdLines } from "../lib/wpdx.js";
import { languageForCaller } from "../lib/voiceCopy.js";
import { initiateOutboundCall, sendSmsViaAt } from "../lib/africastalking.js";

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
  const reply = (text: string): void => {
    const body = trimToSms(text);
    res.set("Content-Type", "text/plain");
    res.send(body);
    if (body && from) {
      void sendSmsViaAt(from, body, { bypassRateLimit: true });
    }
  };

  try {
    // Resolve the caller's context once so every reply is
    // language-aware + personalized. Unknown callers get a bounded
    // default context that still routes on Kiswahili.
    const ctx = await resolveHerderContext(from, DEFAULT_TENANT_ID);
    const lang = languageForCaller(ctx);

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
        const origin =
          centroidForTenant(DEFAULT_TENANT_ID) ??
          { lat: 0.3453, lon: 37.5810 };
        const lines = formatUssdLines(origin, 5, { workingFirst: true });
        const body =
          lines.length > 0
            ? lines.join("; ")
            : lang === "sw"
              ? "Hakuna data ya WPDx bado"
              : "No WPDx data yet";
        reply(
          (lang === "sw" ? "Malisho karibu nawe: " : "Water points near you: ") +
            body,
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
