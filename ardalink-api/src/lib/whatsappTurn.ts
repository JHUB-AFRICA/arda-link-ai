/**
 * Provider-agnostic WhatsApp turn processing — the actual conversation
 * logic (welcome list, Bula Pesa brief, Malisho water points, Ongea na
 * AI, free-text LLM turn, location/audio/status logging), extracted out
 * of routes/whatsapp.ts so both the 360dialog webhook
 * (routes/whatsapp.ts) and the Evolution API webhook
 * (routes/evolutionWhatsapp.ts) can share it instead of duplicating it.
 *
 * Each provider's route parses its own wire envelope into a
 * `NormalizedWaMessage` and calls `processInboundWhatsappMessage()` —
 * this file never touches a provider-specific payload shape. Outbound
 * sends go through whatsappProviderRegistry.ts, so which provider is
 * actually reached is a WA_PROVIDER env decision, invisible here.
 */

import { logger } from "./logger.js";
import {
  resolveHerderContext,
  buildLocalizedBrief,
  type HerderContext,
} from "./herderContext/index.js";
import { centroidForTenant, nearestWorkingKnownPoints } from "./wpdx.js";
import { languageForCaller } from "./voiceCopy.js";
import {
  sendWhatsappSessionMessage,
  sendWhatsappInteractiveButtons,
  sendWhatsappLocation,
} from "./whatsappProviderRegistry.js";
import {
  logWhatsappMessage,
  logLeadInteraction,
  hasPriorWhatsappMessages,
  recentWhatsappMessages,
  insertGroundTruthCall,
  isSupabaseConfigured,
  setLeadStatus,
  markPastoralistOptedOut,
  type SbWhatsappMessageInsert,
} from "./supabase/index.js";
import { extractIndicators, generateActionTag } from "./openai/index.js";
import { mapExtractedIndicatorsToGroundTruthRow } from "./groundTruthMapping.js";
import { computeTrustScore, logTrustScore } from "./trustScore.js";
import { touchPastoralistLastContact } from "./pastoralistContact.js";
import { getLastResult } from "./intelligence.js";
import type { LlmMessage } from "./llm/types.js";

const MENU_KEYWORDS = new Set(["MSAADA", "HELP", "MENU", "START"]);
const OPT_OUT_KEYWORDS = new Set(["STOP", "SITAKI"]);

const DEFAULT_TENANT_ID = process.env.DETERMINISTIC_TENANT_ID ?? "bula-pesa";

/**
 * The shape every provider-specific webhook parser normalizes its own
 * wire envelope into before calling processInboundWhatsappMessage().
 * Deliberately the union of what 360dialog's and Evolution's inbound
 * payloads can carry, flattened to exactly the fields this file's
 * branching logic needs — nothing provider-specific leaks in.
 */
export type NormalizedWaMessageType =
  | "text"
  | "audio"
  | "location"
  | "list_reply"
  | "button_reply"
  | "status";

export interface NormalizedWaMessage {
  from: string; // E.164, e.g. "+254712345678"
  type: NormalizedWaMessageType;
  text?: string;
  replyId?: string;
  location?: { lat: number; lon: number };
  audioRef?: unknown;
  status?: { id?: string; status?: string; recipientId?: string };
  raw: unknown;
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

/**
 * Writes one lead_interactions row per turn — the same operator-facing
 * audit trail + trust-score feature source that ussd/sms/voice already
 * write on every hit (see routes/voice.ts's logVoiceHit, routes/sms.ts's
 * reply()). WhatsApp previously only logged to whatsapp_messages
 * (a raw message-level log, two rows per turn) and never appeared in
 * the ops CallbackLog panel or the lead_interactions-sourced ground
 * truth trail the other channels feed. This brings WhatsApp to parity.
 */
function logInteraction(
  from: string,
  ctx: HerderContext,
  keyword: string,
  inputText: string | null,
  replyText: string | null,
): void {
  void logLeadInteraction({
    phone_number: from,
    tier: ctx.tier,
    channel: "whatsapp",
    session_id: null,
    keyword,
    input_text: inputText,
    reply_text: replyText ? replyText.slice(0, 500) : null,
    ward_id: ctx.wardId ?? null,
    raw_body: null,
  });
}

/**
 * The welcome menu — direct replacement for the USSD tree. Uses
 * interactive BUTTONS, not a list: live-tested against a real Evolution
 * API (Baileys) instance and found that list messages crash Evolution's
 * send path ("this.isZero is not a function" — an internal error, not a
 * WhatsApp-side rejection; list-message support appears broken for
 * personal/non-Business WhatsApp accounts on this stack). Buttons were
 * confirmed working end-to-end on the same live instance. Since the
 * menu only ever has exactly 3 options, buttons (Meta's 3-button limit)
 * are a lossless substitute — no functionality gap on either provider.
 */
async function sendWelcomeList(from: string, lang: "sw" | "en"): Promise<void> {
  await sendWhatsappInteractiveButtons(
    from,
    lang === "sw" ? "Karibu ArdaLink. Chagua huduma:" : "Welcome to ArdaLink. Choose a service:",
    [
      { id: "bula_pesa", title: "Bula Pesa" },
      { id: "malisho", title: "Malisho" },
      { id: "ongea_na_ai", title: "Ongea na AI" },
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
  logInteraction(from, ctx, "bula_pesa", "bula_pesa", brief);
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
    logInteraction(from, ctx, "malisho", "malisho", text);
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
  logInteraction(
    from,
    ctx,
    "malisho",
    "malisho",
    points.map((p) => p.displayName).join(", "),
  );
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
  logInteraction(from, ctx, "ongea_na_ai", "ongea_na_ai", text);
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
  logInteraction(from, ctx, "audio_note", null, text);
}

/**
 * Free-form conversational turn. Reuses the same channel-agnostic
 * pieces the voice deterministic pipeline uses: extractIndicators() /
 * generateActionTag() from openai.ts, computeTrustScore(), and
 * mapExtractedIndicatorsToGroundTruthRow() for the ground_truth_calls
 * write — nothing here is voice-specific.
 *
 * Conversation memory: fetches recentWhatsappMessages() and gives the
 * LLM the real prior turns instead of just the current message — this
 * is the fix for the live-tested bug where the bot re-asked "uko wapi
 * leo na mifugo yako" every turn regardless of what the herder had
 * already answered (handleFreeText had zero history before this).
 * The same accumulated history + current message is also joined into
 * a plain transcript for extractIndicators(), so indicators mentioned
 * in an earlier turn aren't invisible to the extractor on later turns.
 */
async function handleFreeText(
  from: string,
  ctx: HerderContext,
  lang: "sw" | "en",
  rawText: string,
): Promise<void> {
  const { complete } = await import("./llm/index.js");
  const { buildWhatsappSystemPrompt } = await import("./whatsappConversation.js");

  const history = await recentWhatsappMessages(from, 12);
  // Only plain text in/out turns are real conversational content —
  // status rows, template sends, location pins, and interactive
  // list/button sends don't belong in the LLM's chat history.
  const conversational = history.filter(
    (m) =>
      (m.direction === "in" || m.direction === "out") &&
      m.message_type === "text" &&
      !!m.body_text,
  );
  const hasHistory = conversational.length > 0;
  const systemPrompt = buildWhatsappSystemPrompt(ctx, lang, hasHistory);

  const historyMessages: LlmMessage[] = conversational.map((m) => ({
    role: m.direction === "in" ? "user" : "assistant",
    content: m.body_text as string,
  }));

  const transcript = [
    ...conversational.map(
      (m) => `${m.direction === "in" ? "Mchungaji" : "ArdaLink"}: ${m.body_text}`,
    ),
    `Mchungaji: ${rawText}`,
  ].join("\n");

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
          ...historyMessages,
          { role: "user", content: rawText },
        ],
        temperature: 0.7,
        maxTokens: 400,
      },
      { tenantId: DEFAULT_TENANT_ID },
    ),
    extractIndicators(transcript),
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
  logInteraction(from, ctx, "free_text", rawText, reply);

  logger.info(
    { from, actionTag, hasHistory, collected: indicators?.indicators_collected },
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
        transcript,
        sourceLanguage: lang,
        channel: "whatsapp",
      }),
    );
  }

  await touchPastoralistLastContact(from);
}

/**
 * Single entry point every provider's webhook route calls after
 * normalizing its own wire envelope. Mirrors exactly the branching that
 * used to live inline in routes/whatsapp.ts's Express handler.
 */
export async function processInboundWhatsappMessage(
  msg: NormalizedWaMessage,
  tenantId: string = DEFAULT_TENANT_ID,
): Promise<void> {
  if (msg.type === "status") {
    void logWhatsappMessage({
      phone_number: msg.status?.recipientId ?? msg.from ?? "unknown",
      direction: "status",
      message_type: "status",
      body_text: msg.status?.status ?? null,
      raw_payload: msg.raw,
    });
    return;
  }

  const ctx = await resolveHerderContext(msg.from, tenantId);
  const lang = languageForCaller(ctx);

  if (msg.type === "location" && msg.location) {
    logInbound(msg.from, ctx, "location", null, msg.raw);
    // Phase 0/1: log only. No herder-GPS-driven feature exists yet
    // anywhere in the codebase — this just lands the first rows of it.
    return;
  }

  if (msg.type === "audio") {
    logInbound(msg.from, ctx, "audio", null, msg.raw);
    await handleAudioNote(msg.from, ctx, lang);
    return;
  }

  if (msg.type === "list_reply" || msg.type === "button_reply") {
    logInbound(msg.from, ctx, msg.type, msg.replyId ?? null, msg.raw);
    if (msg.replyId === "bula_pesa") {
      await handleBulaPesa(msg.from, ctx, lang);
    } else if (msg.replyId === "malisho") {
      await handleMalisho(msg.from, ctx, lang);
    } else if (msg.replyId === "ongea_na_ai") {
      await handleOngeaAck(msg.from, ctx, lang);
    }
    return;
  }

  if (msg.type === "text" && msg.text) {
    logInbound(msg.from, ctx, "text", msg.text, null);
    const normalized = msg.text.trim().toUpperCase();

    // Discoverability: MSAADA/HELP/MENU/START always resurfaces the
    // menu, regardless of prior-contact state — mirrors the
    // RIPOTI/BULA-style keyword-menu precedent already used by SMS.
    if (MENU_KEYWORDS.has(normalized)) {
      await sendWelcomeList(msg.from, lang);
      logOutbound(msg.from, ctx, "interactive_buttons", "welcome_list");
      logInteraction(msg.from, ctx, "menu_keyword", msg.text, "welcome_list");
      return;
    }

    // Opt-out parity with SMS's STOP/SITAKI handling — WhatsApp free
    // text previously had no way out at all.
    if (OPT_OUT_KEYWORDS.has(normalized)) {
      const [leadOk, pastOk] = await Promise.all([
        setLeadStatus(msg.from, "opted_out"),
        markPastoralistOptedOut(msg.from),
      ]);
      const confirmText =
        lang === "sw"
          ? "Sawa, hutapokea tena ujumbe kutoka ArdaLink. Andika MSAADA wakati wowote ukitaka kurudi."
          : "Okay, you won't receive further messages from ArdaLink. Text MSAADA anytime you want to come back.";
      await sendWhatsappSessionMessage(msg.from, confirmText);
      logOutbound(msg.from, ctx, "text", confirmText);
      logInteraction(msg.from, ctx, "opt_out", msg.text, confirmText);
      logger.info({ from: msg.from, leadOk, pastOk }, "[WhatsApp] Opt-out applied");
      return;
    }

    const seenBefore = await hasPriorWhatsappMessages(msg.from);
    if (!seenBefore) {
      await sendWelcomeList(msg.from, lang);
      logOutbound(msg.from, ctx, "interactive_buttons", "welcome_list");
      logInteraction(msg.from, ctx, "welcome", msg.text, "welcome_list");
      return;
    }
    await handleFreeText(msg.from, ctx, lang, msg.text);
    return;
  }
}
