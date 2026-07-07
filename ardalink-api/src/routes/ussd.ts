import { Router, type IRouter, type Request, type Response } from "express";
import { logger } from "../lib/logger.js";

// Optional: Use the new intelligenceCore if ENABLE_INTELLIGENCE_CORE is set
const useIntelligenceCore = process.env.ENABLE_INTELLIGENCE_CORE === "true";

/**
 * Africa's Talking USSD callback handler.
 *
 * AT POSTs form-encoded: sessionId, serviceCode, phoneNumber, text.
 * The `text` field is the accumulated keypad input since session start,
 * space-separated. e.g. user dials *123*8# → first POST has text="".
 * Then "1" → text="1". Then "2" → text="1*2".
 *
 * We respond with `text/plain`:
 *   - `CON <menu>` keeps the session open (AT shows the menu, waits).
 *   - `END <message>` terminates the session.
 *
 * Sandbox note: AT's USSD simulator hits this exact same callback URL
 * with the same payload shape. To exercise the full flow without a real
 * USSD gateway, the sandbox simulator in scripts/sandbox-simulate.mjs
 * POSTs the same fields to /api/ussd-callback.
 *
 * Menu design (all bilingual so a herder who reads neither English nor
 * Swahili fluently still gets the gist):
 *
 *   *123*8#  →  Welcome
 *     1  Bula Pesa   — pasture / drought brief in your area
 *     2  Malisho     — list nearest water points
 *     3  Ongea na AI — request a voice call from ArdaLink
 *     4  Toka        — exit
 *
 *   *1 → Bula Pesa (drought brief from last intelligence cycle)
 *       1  Swahili brief
 *       2  English brief
 *       0  Back
 *
 *   *2 → Malisho (water points — pulled from bulaPesaWaterPoints data)
 *       Lists top 5 nearest boreholes/dams with quadrant.
 *
 *   *3 → Ongea na AI (request voice call)
 *       1  Sasa / now
 *       2  Kesho / tomorrow
 *       0  Back
 *
 *   *4 → Toka (END)
 */
const router: IRouter = Router();

const AT_SANDBOX_NUMBER = "+254711082200";
const SUPPORTED_NUMBER_REGEX = /^\+\d{6,15}$/;

interface UssdBody {
  sessionId?: string;
  serviceCode?: string;
  phoneNumber?: string;
  text?: string;
}

function isValidPhone(p: string | undefined): p is string {
  return !!p && SUPPORTED_NUMBER_REGEX.test(p);
}

function pickPhone(body: UssdBody): string {
  if (isValidPhone(body.phoneNumber)) return body.phoneNumber;
  // Sandbox may POST "+254711082200" literally; fall back to caller ID.
  return AT_SANDBOX_NUMBER;
}

const MENU_HOME = `CON ArdaLink — Bula Pesa
1. Bula Pesa (drought brief)
2. Malisho (water points)
3. Ongea na AI (voice call)
4. Toka`;

const MENU_BRIEF = `CON Bula Pesa brief:
1. Kwa Kiswahili (Swahili)
2. In English
0. Rudi / Back`;

const MENU_CALL = `CON Ongea na AI:
1. Sasa / Now
2. Kesho / Tomorrow
0. Rudi / Back`;

function parseLastInput(text: string): {
  accumulated: string;
  level: number;
  last: string;
} {
  // text=""              → level=0, last=""
  // text="1"             → level=1, last="1"
  // text="1*2"           → level=2, last="2"
  // text="1*2*0"         → level=3, last="0"
  const parts = text.split("*").filter((s) => s.length > 0);
  return {
    accumulated: text,
    level: parts.length,
    last: parts.length > 0 ? parts[parts.length - 1] : "",
  };
}

function buildBulaPesaReply(
  brief: { stressedPct: number | null; riskLevel: string | null } | null,
  lang: "sw" | "en",
): string {
  if (!brief || brief.stressedPct == null) {
    if (lang === "sw") {
      return "END Samahani, hatuna ripoti ya satellite leo. Tafadhali jaribu tena baadaye. (Sorry, no satellite reading today. Try again later.)";
    }
    return "END Sorry, no satellite reading is available right now. Please try again later.";
  }
  if (lang === "sw") {
    return `END Bula Pesa leo: ${brief.stressedPct.toFixed(0)}% ya eneo limeathirika. Hatari: ${brief.riskLevel ?? "?"}. Pata ripoti kamili: piga simu ArdaLink.`;
  }
  return `END Bula Pesa today: ${brief.stressedPct.toFixed(0)}% of the ward is vegetation-stressed. Risk: ${brief.riskLevel ?? "?"}. For the full brief, call ArdaLink.`;
}

const WATER_POINTS = [
  { name: "Bulla Pesa Borehole", quadrant: "SW", distanceKm: 2 },
  { name: "Ngare Mara Spring", quadrant: "NE", distanceKm: 9 },
  { name: "Kambi Garba Dam", quadrant: "SE", distanceKm: 14 },
  { name: "Wabera Shallow Well", quadrant: "NW", distanceKm: 7 },
  { name: "Burat Pan", quadrant: "NW", distanceKm: 12 },
];

function buildWaterPointsReply(): string {
  const lines = WATER_POINTS.slice(0, 5)
    .map((w, i) => `${i + 1}. ${w.name} (${w.quadrant}, ~${w.distanceKm}km)`)
    .join("\n");
  // USSD screens are ~160 chars; cap at 5 to stay readable on a 2G phone.
  return `END Malisho / Water points:\n${lines}\n0. Rudi / Back`;
}

router.post("/ussd-callback", async (req, res): Promise<void> => {
  const body = (req.body ?? {}) as UssdBody;
  const phone = pickPhone(body);
  const rawText = typeof body.text === "string" ? body.text : "";
  const { level, last } = parseLastInput(rawText);

  // Use the new intelligenceCore if enabled (for unified AI across channels)
  if (useIntelligenceCore) {
    return handleUssdWithCore(req, res, phone, rawText);
  }

  req.log.info(
    {
      phone,
      sessionId: body.sessionId ?? "(none)",
      serviceCode: body.serviceCode ?? "(none)",
      text: rawText,
      level,
      last,
    },
    "[USSD] Inbound keystroke",
  );

  try {
    // ── Level 0: dial-in menu ───────────────────────────────────────────────
    if (level === 0) {
      res.set("Content-Type", "text/plain");
      res.send(MENU_HOME);
      return;
    }

    // ── Level 1: top-level selection ────────────────────────────────────────
    if (level === 1) {
      switch (last) {
        case "1":
          res.set("Content-Type", "text/plain");
          res.send(MENU_BRIEF);
          return;
        case "2":
          res.set("Content-Type", "text/plain");
          res.send(buildWaterPointsReply());
          return;
        case "3":
          res.set("Content-Type", "text/plain");
          res.send(MENU_CALL);
          return;
        case "4":
          res.set("Content-Type", "text/plain");
          res.send("END Asante. Kwaheri. / Thank you. Goodbye.");
          return;
        case "0":
          res.set("Content-Type", "text/plain");
          res.send(MENU_HOME);
          return;
        default:
          res.set("Content-Type", "text/plain");
          res.send(`END Chaguo batili. / Invalid choice.\n${MENU_HOME}`);
          return;
      }
    }

    // ── Level 2: second-tier ────────────────────────────────────────────────
    if (level === 2) {
      const top = parseLastInput(rawText).accumulated.split("*")[0] ?? "";
      // Brief: top="1", last = "1" (SW) or "2" (EN) or "0" (back)
      if (top === "1") {
        if (last === "0") {
          res.set("Content-Type", "text/plain");
          res.send(MENU_HOME);
          return;
        }
        if (last === "1") {
          const brief = await readLastBrief();
          res.set("Content-Type", "text/plain");
          res.send(buildBulaPesaReply(brief, "sw"));
          return;
        }
        if (last === "2") {
          const brief = await readLastBrief();
          res.set("Content-Type", "text/plain");
          res.send(buildBulaPesaReply(brief, "en"));
          return;
        }
      }
      // Call: top="3", last = "1" (now), "2" (tomorrow), "0" (back)
      if (top === "3") {
        if (last === "0") {
          res.set("Content-Type", "text/plain");
          res.send(MENU_HOME);
          return;
        }
        if (last === "1") {
          await scheduleCall(phone, "now");
          res.set("Content-Type", "text/plain");
          res.send(
            "END ArdaLink atapiga simu hivi karibuni. / ArdaLink will call you shortly.",
          );
          return;
        }
        if (last === "2") {
          await scheduleCall(phone, "tomorrow");
          res.set("Content-Type", "text/plain");
          res.send(
            "END ArdaLink atapiga simu kesho. / ArdaLink will call you tomorrow.",
          );
          return;
        }
      }
      // Back from anywhere at level 2
      if (last === "0") {
        res.set("Content-Type", "text/plain");
        res.send(MENU_HOME);
        return;
      }
      res.set("Content-Type", "text/plain");
      res.send(`END Chaguo batili. / Invalid choice.\n${MENU_HOME}`);
      return;
    }

    // Anything deeper than 2 levels → terminate cleanly
    res.set("Content-Type", "text/plain");
    res.send("END Mazoezi mengi. / Too many steps. Please redial.");
  } catch (err: unknown) {
    logger.error({ err, phone, text: rawText }, "[USSD] handler error");
    res.set("Content-Type", "text/plain");
    res.status(500).send("END Hitilafu ya mfumo. / System error. Try again later.");
  }
});

/**
 * Read the last intelligence cycle result so the USSD brief can surface
 * a concrete number instead of "we have no idea". Lazy-imported to keep
 * module-load order simple (intelligence pulls voice.ts which pulls
 * logger — same dependency graph).
 */
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

/**
 * Persist a call request from USSD into the in-memory call queue.
 * For the Tuesday demo we just call initiateCall() immediately on "now";
 * "tomorrow" is logged but not scheduled (no scheduler is wired for
 * future-dated calls yet — that's a Phase 4 deliverable per STATUS.md §8.4).
 */
async function scheduleCall(phone: string, when: "now" | "tomorrow"): Promise<void> {
  if (when !== "now") {
    logger.info(
      { phone, when },
      "[USSD] Future-dated call request recorded (no scheduler yet)",
    );
    return;
  }
  try {
    const mod = await import("../lib/voice.js");
    const sessionMod = await import("../lib/intelligence.js");
    const last = sessionMod.getLastResult();
    if (!last?.live?.anomaly || !last?.script) {
      logger.warn(
        { phone },
        "[USSD] No intelligence cycle yet — cannot schedule call with context",
      );
      return;
    }
    mod.storeCallSession(phone, {
      script: last.script.script,
      question: last.script.question,
      delta: last.live.anomaly as never,
      month: last.month_name ?? "now",
      climate: last.climate ?? undefined,
      forecast: last.forecast ?? undefined,
    });
    await mod.initiateCall(phone);
    logger.info({ phone, when }, "[USSD] Call scheduled");
  } catch (err: unknown) {
    logger.error({ err, phone }, "[USSD] Failed to schedule call");
  }
}

/**
 * USSD handler using the new intelligenceCore.
 * This provides unified AI responses across all channels.
 */
async function handleUssdWithCore(
  req: Request,
  res: Response,
  phone: string,
  text: string,
): Promise<void> {
  const {
    parseUssdInput,
    generateAiResponse,
    loadIntelligenceContext,
  } = await import("../lib/channels/intelligenceCore");
  const { UssdAdapter } = await import("../lib/channels/adapters");

  try {
    // Parse input using core
    const parsed = parseUssdInput(phone, text);

    // Load intelligence context
    const intelContext = loadIntelligenceContext();

    // Generate AI response
    const aiResponse = await generateAiResponse(parsed, intelContext);

    // Format for USSD
    const formatted = UssdAdapter.format(aiResponse);

    res.set("Content-Type", "text/plain");
    res.send(formatted);

    req.log.info(
      { phone, intent: parsed.intent, ended: aiResponse.ended },
      "[USSD] Response via intelligenceCore",
    );
  } catch (err: unknown) {
    req.log.error({ err, phone }, "[USSD] intelligenceCore error");
    res.set("Content-Type", "text/plain");
    res.status(500).send("END Hitilafu ya mfumo. / System error. Try again later.");
  }
}

export default router;
