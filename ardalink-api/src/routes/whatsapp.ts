import { Router, type IRouter } from "express";
import { logger } from "../lib/logger.js";
import {
  resolveHerderContext,
  buildLocalizedBrief,
  type HerderContext,
} from "../lib/herderContext.js";
import { centroidForTenant, nearestWorkingKnownPoints } from "../lib/wpdx.js";
import { languageForCaller } from "../lib/voiceCopy.js";
import {
  sendWhatsappSessionMessage,
  sendWhatsappInteractiveList,
  sendWhatsappLocation,
} from "../lib/threeSixtyDialog.js";
import {
  logWhatsappMessage,
  hasPriorWhatsappMessages,
  insertGroundTruthCall,
  isSupabaseConfigured,
  type SbWhatsappMessageInsert,
} from "../lib/supabase.js";
import { extractIndicators, generateActionTag } from "../lib/openai.js";
import { mapExtractedIndicatorsToGroundTruthRow } from "../lib/groundTruthMapping.js";
import { computeTrustScore, logTrustScore } from "../lib/trustScore.js";
import { touchPastoralistLastContact } from "../lib/pastoralistContact.js";
import { getLastResult } from "../lib/intelligence.js";

const DEFAULT_TENANT_ID = process.env.DETERMINISTIC_TENANT_ID ?? "bula-pesa";

/**
 * 360dialog forwards the Meta Cloud API webhook envelope verbatim.
 * `entry[].changes[].value.messages[]` for inbound messages,
 * `.statuses[]` for delivery/read receipts — both can appear on the
 * same endpoint, sometimes interleaved.
 */
interface WaWebhookBody {
  entry?: Array<{
    changes?: Array<{
      value?: {
        contacts?: Array<{ wa_id?: string; profile?: { name?: string } }>;
        messages?: Array<{
          from?: string;
          id?: string;
          timestamp?: string;
          type?: string;
          text?: { body?: string };
          interactive?: {
            list_reply?: { id?: string; title?: string };
            button_reply?: { id?: string; title?: string };
          };
          location?: { latitude?: number; longitude?: number };
          audio?: { id?: string };
        }>;
        statuses?: Array<{ id?: string; status?: string; recipient_id?: string }>;
      };
    }>;
  }>;
}

const router: IRouter = Router();

/** Meta/360dialog sends `from` as digits-only MSISDN — normalize to E.164. */
function toE164(raw: string): string {
  return raw.startsWith("+") ? raw : `+${raw}`;
}

function logInbound(
  from: string,
  ctx: HerderContext,
  messageType: SbWhatsappMessageInsert["message_type"],
  bodyText: string | null,
  rawPayload: unknown,
): void {
  void logWhatsappMessage({
    phone_number: from,
    tier: ctx.tier,
    direction: "in",
    message_type: messageType,
    body_text: bodyText,
    ward_id: ctx.wardId ?? null,
    raw_payload: rawPayload,
  });
}

function logOutbound(
  from: string,
  ctx: HerderContext,
  messageType: SbWhatsappMessageInsert["message_type"],
  bodyText: string | null,
  templateName?: string | null,
): void {
  void logWhatsappMessage({
    phone_number: from,
    tier: ctx.tier,
    direction: "out",
    message_type: messageType,
    template_name: templateName ?? null,
    body_text: bodyText,
    ward_id: ctx.wardId ?? null,
  });
}

/** The welcome interactive list — direct replacement for the USSD tree. */
async function sendWelcomeList(from: string, lang: "sw" | "en"): Promise<void> {
  await sendWhatsappInteractiveList(
    from,
    "Karibu ArdaLink",
    lang === "sw"
      ? "Chagua huduma unayotaka:"
      : "Choose the service you need:",
    lang === "sw" ? "Chagua" : "Choose",
    [
      {
        title: lang === "sw" ? "Huduma" : "Services",
        rows: [
          {
            id: "bula_pesa",
            title: "Bula Pesa",
            description: lang === "sw" ? "Hali ya ukame" : "Drought brief",
          },
          {
            id: "malisho",
            title: "Malisho",
            description: lang === "sw" ? "Maeneo ya maji" : "Water points",
          },
          {
            id: "ongea_na_ai",
            title: "Ongea na AI",
            description: lang === "sw" ? "Zungumza na AI" : "Talk to the AI",
          },
        ],
      },
    ],
  );
}

async function handleBulaPesa(
  from: string,
  ctx: HerderContext,
  lang: "sw" | "en",
): Promise<void> {
  const brief = buildLocalizedBrief(ctx, lang);
  await sendWhatsappSessionMessage(from, brief);
  logOutbound(from, ctx, "text", brief);
}

async function handleMalisho(
  from: string,
  ctx: HerderContext,
  lang: "sw" | "en",
): Promise<void> {
  // Bypass herderContext's overlayNearestWaterPoint (which drops
  // lat/lon) — call wpdx.ts directly so we can send real map pins
  // instead of USSD-style text lines.
  const origin =
    centroidForTenant(DEFAULT_TENANT_ID) ?? { lat: 0.3453, lon: 37.581 };
  const points = nearestWorkingKnownPoints(origin, 3);
  if (points.length === 0) {
    const text =
      lang === "sw" ? "Hakuna data ya WPDx bado." : "No WPDx data yet.";
    await sendWhatsappSessionMessage(from, text);
    logOutbound(from, ctx, "text", text);
    return;
  }
  const nearWard = ctx.wardName
    ? `${lang === "sw" ? "karibu na" : "near"} ${ctx.wardName}`
    : lang === "sw"
      ? "karibu na kituo cha wodi"
      : "near the ward center";
  for (const p of points) {
    await sendWhatsappLocation(from, p.point.lat, p.point.lon, p.displayName, nearWard);
    logOutbound(from, ctx, "location", p.displayName);
  }
}

async function handleOngeaAck(
  from: string,
  ctx: HerderContext,
  lang: "sw" | "en",
): Promise<void> {
  const text =
    lang === "sw"
      ? "Sawa, niambie mifugo yako inaendeleaje."
      : "Okay, tell me how your animals are doing.";
  await sendWhatsappSessionMessage(from, text);
  logOutbound(from, ctx, "text", text);
}

async function handleAudioNote(
  from: string,
  ctx: HerderContext,
  lang: "sw" | "en",
): Promise<void> {
  const text =
    lang === "sw"
      ? "Ujumbe wa sauti unakuja hivi karibuni. Kwa sasa, tafadhali andika ujumbe wako."
      : "Voice notes are coming soon. For now, please type your message.";
  await sendWhatsappSessionMessage(from, text);
  logOutbound(from, ctx, "text", text);
}

/**
 * Free-form conversational turn. Reuses the same channel-agnostic
 * pieces the voice deterministic pipeline uses: extractIndicators() /
 * generateActionTag() from openai.ts, computeTrustScore(), and
 * mapExtractedIndicatorsToGroundTruthRow() for the ground_truth_calls
 * write — nothing here is voice-specific.
 */
async function handleFreeText(
  from: string,
  ctx: HerderContext,
  lang: "sw" | "en",
  rawText: string,
): Promise<void> {
  const { complete } = await import("../lib/llm/index.js");
  const { buildWhatsappSystemPrompt } = await import(
    "../lib/whatsappConversation.js"
  );
  const systemPrompt = buildWhatsappSystemPrompt(ctx, lang);
  const last = getLastResult();
  const month =
    last?.month_name ??
    new Date().toLocaleString("en", { month: "short" }).toUpperCase();

  const [llmResponse, indicators, actionTag] = await Promise.all([
    complete(
      "multilingual",
      {
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: rawText },
        ],
        temperature: 0.7,
        maxTokens: 400,
      },
      { tenantId: DEFAULT_TENANT_ID },
    ),
    extractIndicators(rawText),
    last?.delta
      ? generateActionTag(rawText, {
          aiQuestion: "WhatsApp free-text report",
          month,
          delta: last.delta,
        })
      : Promise.resolve("WhatsApp Report"),
  ]);

  const reply = llmResponse.content || (
    lang === "sw" ? "Asante kwa ujumbe wako." : "Thanks for your message."
  );
  await sendWhatsappSessionMessage(from, reply);
  logOutbound(from, ctx, "text", reply);

  logger.info(
    { from, actionTag, collected: indicators?.indicators_collected },
    "[WhatsApp] Free-text turn processed",
  );

  if (
    indicators &&
    indicators.indicators_collected > 0 &&
    ctx.pastoralistId &&
    ctx.wardId &&
    isSupabaseConfigured()
  ) {
    const trust = computeTrustScore({
      indicators,
      wardAnomalyPct: last?.live?.anomaly?.NDVI?.p50 ?? null,
      callDurationSeconds: null,
      endReason: "unknown",
    });
    logTrustScore(from, null, trust);
    void insertGroundTruthCall(
      mapExtractedIndicatorsToGroundTruthRow({
        pastoralistId: ctx.pastoralistId,
        wardId: ctx.wardId,
        indicators,
        trustScore: trust.score,
        transcript: rawText,
        sourceLanguage: lang,
        channel: "whatsapp",
      }),
    );
  }

  await touchPastoralistLastContact(from);
}

router.post("/whatsapp-webhook", async (req, res): Promise<void> => {
  // 360dialog/Meta expects a fast 200 regardless of downstream outcome —
  // slow or non-2xx responses trigger their own retry/backoff.
  res.status(200).json({ received: true });

  const body = (req.body ?? {}) as WaWebhookBody;
  const value = body.entry?.[0]?.changes?.[0]?.value;
  if (!value) return;

  if (value.statuses && value.statuses.length > 0) {
    for (const status of value.statuses) {
      void logWhatsappMessage({
        phone_number: status.recipient_id ?? "unknown",
        direction: "status",
        message_type: "status",
        body_text: status.status ?? null,
        raw_payload: status,
      });
    }
    return;
  }

  const message = value.messages?.[0];
  if (!message?.from) return;

  const from = toE164(message.from);

  try {
    const ctx = await resolveHerderContext(from, DEFAULT_TENANT_ID);
    const lang = languageForCaller(ctx);

    if (message.type === "location" && message.location) {
      logInbound(from, ctx, "location", null, message.location);
      // Phase 0/1: log only. No herder-GPS-driven feature exists yet
      // anywhere in the codebase — this just lands the first rows of it.
      return;
    }

    if (message.type === "audio") {
      logInbound(from, ctx, "audio", null, message.audio);
      await handleAudioNote(from, ctx, lang);
      return;
    }

    if (message.type === "interactive") {
      const replyId =
        message.interactive?.list_reply?.id ??
        message.interactive?.button_reply?.id;
      logInbound(from, ctx, "list_reply", replyId ?? null, message.interactive);
      if (replyId === "bula_pesa") {
        await handleBulaPesa(from, ctx, lang);
      } else if (replyId === "malisho") {
        await handleMalisho(from, ctx, lang);
      } else if (replyId === "ongea_na_ai") {
        await handleOngeaAck(from, ctx, lang);
      }
      return;
    }

    if (message.type === "text" && message.text?.body) {
      const rawText = message.text.body;
      logInbound(from, ctx, "text", rawText, null);

      const seenBefore = await hasPriorWhatsappMessages(from);
      if (!seenBefore) {
        await sendWelcomeList(from, lang);
        logOutbound(from, ctx, "interactive_list", "welcome_list");
        return;
      }
      await handleFreeText(from, ctx, lang, rawText);
      return;
    }
  } catch (err) {
    logger.error({ err, from }, "[WhatsApp] webhook handler error");
  }
});

export default router;
