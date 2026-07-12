import { Router, type IRouter, type Request, type Response } from "express";
import { logger } from "../lib/logger.js";
import { centroidForTenant, formatUssdLines } from "../lib/wpdx.js";
import {
  resolveHerderContext,
  buildLocalizedBrief,
  type HerderContext,
} from "../lib/herderContext.js";
import {
  upsertPastoralistLead,
  identityForPhone,
  logLeadInteraction,
} from "../lib/supabase.js";
import { sendSmsViaAt, initiateOutboundCall } from "../lib/africastalking.js";

// The 5 active Isiolo Sub-County wards, ordered so digit ↔ ward is
// stable across the Jisajili subscribe flow. Add / retire wards here
// only — the flow reads this list directly.
const WARDS_FOR_SUBSCRIBE: ReadonlyArray<{ code: string; name: string }> = [
  { code: "242", name: "Bulla Pesa" },
  { code: "241", name: "Wabera" },
  { code: "245", name: "Ngare Mara" },
  { code: "246", name: "Burat" },
  { code: "247", name: "Oldonyiro" },
];

const DEFAULT_TENANT_ID =
  process.env.DETERMINISTIC_TENANT_ID ?? "bula-pesa";

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
4. Toka
5. Jisajili / Register`;

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

/**
 * USSD brief screen — mirrors buildLocalizedBrief() so the herder
 * hears the same anomaly-driven line here as on SMS BULA. USSD caps
 * around 182 characters per screen, so we prefix END and trust the
 * brief helper's own 300-char cap.
 */
function buildBulaPesaReply(
  ctx: HerderContext | null,
  lang: "sw" | "en",
): string {
  if (!ctx) {
    return lang === "sw"
      ? "END Samahani, hakuna data ya leo. Jaribu tena baadaye."
      : "END Sorry, no data available. Try again later.";
  }
  const brief = buildLocalizedBrief(ctx, lang);
  // Keep well inside USSD's per-screen budget.
  const trimmed = brief.length > 175 ? brief.slice(0, 174) + "…" : brief;
  return `END ${trimmed}`;
}

// ── Jisajili (subscribe) flow helpers ──────────────────────────────────

/**
 * The Jisajili flow captures four inputs across four screens:
 *   5                            → ask for name
 *   5*<name>                     → ask for ward (numbered picker)
 *   5*<name>*<wardDigit>         → ask for language
 *   5*<name>*<wardDigit>*<langDigit> → confirm + upsert lead + welcome SMS + END
 *
 * A pastoralist already in `pastoralists` (tier='verified') is
 * short-circuited on the first screen with a warm message + no lead
 * row created. An existing lead re-runs the flow to refresh their
 * details (upsertPastoralistLead merges on phone_number).
 */
function ussdSubscribeAskName(): string {
  return "CON Karibu ArdaLink. Andika jina lako kamili:";
}

function ussdSubscribeAskWard(name: string): string {
  const clipped = name.trim().slice(0, 30) || "rafiki";
  const lines = WARDS_FOR_SUBSCRIBE.map(
    (w, i) => `${i + 1}. ${w.name}`,
  ).join("\n");
  return `CON Asante ${clipped}. Uko ward gani?\n${lines}`;
}

function ussdSubscribeAskLang(): string {
  return "CON Chagua lugha / language:\n1. Kiswahili\n2. English";
}

function ussdSubscribeAlreadyVerified(name: string | null): string {
  const who = name ? name.trim().slice(0, 20) : "";
  const suffix = who ? ` ${who}` : "";
  return `END Karibu tena${suffix}. Wewe tayari umesajiliwa. Tuma BULA kwa SMS kupata ripoti ya leo.`;
}

async function ussdSubscribeFinalize(
  phone: string,
  name: string,
  wardDigit: string,
  langDigit: string,
): Promise<string> {
  // Validate ward digit — return an invalid-choice terminal END if the
  // caller pressed something outside 1..5.
  const wardIdx = Number(wardDigit) - 1;
  const ward = WARDS_FOR_SUBSCRIBE[wardIdx];
  if (!ward) {
    return "END Ward batili. Tafadhali jaribu tena baadaye.";
  }
  const lang: "sw" | "en" = langDigit === "2" ? "en" : "sw";
  const trimmedName = name.trim().slice(0, 60);

  // Best-effort lead upsert. Failure is logged but never blocks the
  // END reply — the caller shouldn't hang on Supabase.
  try {
    await upsertPastoralistLead({
      phone_number: phone,
      full_name: trimmedName || null,
      preferred_language: lang,
      ward_id: ward.code,
      location_text: ward.name,
      enrollment_source: "ussd_self",
      status: "lead",
      alerts_enabled: true,
    });
  } catch (err) {
    logger.warn({ err, phone }, "[USSD] Jisajili upsert failed");
  }

  // Fire-and-forget welcome SMS. The USSD reply below acknowledges
  // the subscription immediately; the SMS is the closing loop.
  const welcome =
    lang === "sw"
      ? `Karibu ArdaLink${trimmedName ? " " + trimmedName : ""}. Umesajiliwa. Utapokea ripoti za ArdaLink. Tuma STOP kuacha.`
      : `Welcome to ArdaLink${trimmedName ? " " + trimmedName : ""}. You are subscribed and will receive updates. Text STOP to opt out.`;
  void sendSmsViaAt(phone, welcome).catch((err) =>
    logger.warn({ err, phone }, "[USSD] Jisajili welcome SMS failed"),
  );

  return lang === "sw"
    ? `END Umesajiliwa. ArdaLink itakupigia simu kesho. Utapata SMS ya kukaribishwa.`
    : `END You are subscribed. ArdaLink will call tomorrow to confirm. A welcome SMS is on the way.`;
}

function buildWaterPointsReply(): string {
  // Pulls the nearest 5 water points from the WPDx snapshot, anchored
  // to the default demo tenant's ward centroid. Working points are
  // ranked first so the herder sees usable infrastructure before broken.
  // AT USSD screens cap around 160 chars, so we're deliberately terse.
  const origin =
    centroidForTenant(DEFAULT_TENANT_ID) ?? { lat: 0.3453, lon: 37.5810 };
  const lines = formatUssdLines(origin, 5, { workingFirst: true });
  const body =
    lines.length > 0
      ? lines.map((l, i) => `${i + 1}. ${l}`).join("\n")
      : "Hakuna data ya WPDx / no WPDx data";
  return `END Malisho / Water points:\n${body}\n0. Rudi / Back`;
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

  // Wrap res.send so every reply automatically logs a
  // lead_interactions row without having to instrument every branch.
  // Tier is resolved lazily on first use so unknown-caller replies
  // (menu screens with no personalisation) still log tier='unknown'.
  let ctxTier: "verified" | "lead" | "unknown" | null = null;
  let ctxWardId: string | null = null;
  const originalSend = res.send.bind(res);
  res.send = ((chunk: string | Buffer) => {
    const replyText = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    // Resolve tier lazily via identity view — fast, cached — if we
    // haven't already for this request.
    const resolveTier = async (): Promise<{
      tier: "verified" | "lead" | "unknown";
      wardId: string | null;
    }> => {
      if (ctxTier != null) return { tier: ctxTier, wardId: ctxWardId };
      try {
        const id = await identityForPhone(phone);
        ctxTier = id?.tier ?? "unknown";
        ctxWardId = id?.ward_id ?? null;
      } catch {
        ctxTier = "unknown";
      }
      return { tier: ctxTier, wardId: ctxWardId };
    };
    void resolveTier().then(({ tier, wardId }) => {
      void logLeadInteraction({
        phone_number: phone,
        tier,
        channel: "ussd",
        session_id: body.sessionId ?? null,
        keyword: null,
        input_text: rawText,
        reply_text: replyText.slice(0, 500),
        ward_id: wardId,
        raw_body: {
          serviceCode: body.serviceCode ?? null,
          level,
          last,
        },
      });
    });
    return originalSend(chunk);
  }) as typeof res.send;

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
        case "5": {
          // Jisajili — check if the caller is already verified. If so,
          // short-circuit with a warm END instead of walking them
          // through a self-enroll flow that would only add a lead row
          // shadowed by their existing pastoralists row.
          const id = await identityForPhone(phone);
          if (id && id.tier === "verified") {
            res.set("Content-Type", "text/plain");
            res.send(ussdSubscribeAlreadyVerified(id.full_name));
            return;
          }
          res.set("Content-Type", "text/plain");
          res.send(ussdSubscribeAskName());
          return;
        }
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
          const ctx = await resolveHerderContext(phone, DEFAULT_TENANT_ID);
          res.set("Content-Type", "text/plain");
          res.send(buildBulaPesaReply(ctx, "sw"));
          return;
        }
        if (last === "2") {
          const ctx = await resolveHerderContext(phone, DEFAULT_TENANT_ID);
          res.set("Content-Type", "text/plain");
          res.send(buildBulaPesaReply(ctx, "en"));
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
          // Fire-and-forget the dispatch — USSD END goes back to the
          // caller immediately so they don't wait on the AT round-trip.
          void scheduleCall(phone, "now");
          res.set("Content-Type", "text/plain");
          res.send(
            "END ArdaLink inakupigia sasa. / ArdaLink is calling you now.",
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
      // Jisajili step 2 — name captured, ask for ward.
      if (top === "5") {
        const name = last; // free-text between the 5* and next *
        res.set("Content-Type", "text/plain");
        res.send(ussdSubscribeAskWard(name));
        return;
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

    // ── Level 3: third-tier ─────────────────────────────────────────────────
    if (level === 3) {
      const parts = rawText.split("*").filter((s) => s.length > 0);
      const top = parts[0] ?? "";
      // Jisajili step 3 — ward captured, ask for language.
      if (top === "5") {
        res.set("Content-Type", "text/plain");
        res.send(ussdSubscribeAskLang());
        return;
      }
      res.set("Content-Type", "text/plain");
      res.send(`END Chaguo batili. / Invalid choice.\n${MENU_HOME}`);
      return;
    }

    // ── Level 4: subscribe finalise ─────────────────────────────────────────
    if (level === 4) {
      const parts = rawText.split("*").filter((s) => s.length > 0);
      const top = parts[0] ?? "";
      if (top === "5") {
        const name = parts[1] ?? "";
        const wardDigit = parts[2] ?? "";
        const langDigit = parts[3] ?? "";
        const reply = await ussdSubscribeFinalize(
          phone,
          name,
          wardDigit,
          langDigit,
        );
        res.set("Content-Type", "text/plain");
        res.send(reply);
        return;
      }
    }

    // Anything deeper (or an unrecognised path) → terminate cleanly
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
 * Immediately dispatch an outbound voice call from AT — the herder's
 * handset rings within seconds. On failure we log + fall through; the
 * USSD END reply already went back to the caller so the promise of
 * "ArdaLink inakupigia sasa" isn't a lie even if the actual dispatch
 * hiccups (they'll get an SMS if we can't reach them).
 *
 * "tomorrow" is best-effort — no scheduler is wired yet (STATUS §8.4);
 * we log the request so ops can follow up manually.
 */
async function scheduleCall(phone: string, when: "now" | "tomorrow"): Promise<void> {
  if (when !== "now") {
    logger.info(
      { phone, when },
      "[USSD] Future-dated call request recorded (no scheduler yet)",
    );
    // Send a placeholder SMS so the caller doesn't sit waiting.
    void sendSmsViaAt(
      phone,
      "ArdaLink itakupigia simu kesho. Kama huoni simu, tuma ONGEA tena.",
    );
    return;
  }
  try {
    // Stash the current intelligence cycle onto the in-memory session
    // store so when AT hits our voice-callback the deterministic opener
    // can pull the fresh anomaly numbers. Best-effort — the pipeline
    // still runs (with a generic opener) if intelligence isn't ready.
    try {
      const voiceMod = await import("../lib/voice.js");
      const sessionMod = await import("../lib/intelligence.js");
      const last = sessionMod.getLastResult();
      if (last?.live?.anomaly && last?.script) {
        voiceMod.storeCallSession(phone, {
          script: last.script.script,
          question: last.script.question,
          delta: last.live.anomaly as never,
          month: last.month_name ?? "now",
          climate: last.climate ?? undefined,
          forecast: last.forecast ?? undefined,
        });
      }
    } catch (err) {
      logger.warn({ err, phone }, "[USSD] session prime failed — carrying on");
    }

    const result = await initiateOutboundCall(phone);
    logger.info(
      {
        phone,
        atOk: result.ok,
        atReason: result.reason,
        atSessionId: result.messageId,
      },
      "[USSD] Outbound call dispatch attempted",
    );
    if (!result.ok) {
      // Follow-up SMS so the herder knows what happened instead of
      // waiting for a call that isn't coming. Fail-soft.
      void sendSmsViaAt(
        phone,
        "ArdaLink hakuweza kupiga sasa. Tafadhali piga tena baada ya dakika 15 au tuma BULA kwa habari.",
      );
    }
  } catch (err: unknown) {
    logger.error({ err, phone }, "[USSD] Failed to dispatch outbound call");
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
