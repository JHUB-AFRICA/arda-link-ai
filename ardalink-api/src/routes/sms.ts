import { Router, type IRouter, type Request, type Response } from "express";
import { logger } from "../lib/logger.js";

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

  // AT expects a plain-text 200 with the reply body. Empty body means
  // "don't reply" — useful for STOP.
  const reply = (text: string): void => {
    res.set("Content-Type", "text/plain");
    res.send(trimToSms(text));
  };

  try {
    switch (keyword) {
      case "BULA": {
        const brief = await readLastBrief();
        const line = brief
          ? `Bula Pesa leo: ${brief.stressedPct?.toFixed(0) ?? "?"}% stressed, risk=${brief.riskLevel ?? "?"}. ArdaLink itapiga simu hivi karibuni.`
          : "Bula Pesa: hakuna ripoti mpya. ArdaLink itapiga simu hivi karibuni.";
        await maybeCallback(from, "BULA keyword");
        reply(line);
        return;
      }
      case "MALISHO": {
        reply(
          "Malisho karibu: 1) Bulla Pesa BH (SW, 2km) 2) Wabera Well (NW, 7km) 3) Ngare Mara Spring (NE, 9km)",
        );
        return;
      }
      case "ONGEA":
      case "AI": {
        await maybeCallback(from, `${keyword} keyword`);
        reply("ArdaLink itapiga simu hivi karibuni. / ArdaLink will call you shortly.");
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
          "ArdaLink: jibu BULA (brief), MALISHO (water), ONGEA (call), au STOP (opt-out).",
        );
        return;
      }
    }
  } catch (err: unknown) {
    logger.error({ err, from, keyword }, "[SMS] handler error");
    reply("ArdaLink: hitilafu. Jaribu tena. / Error. Try again.");
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
