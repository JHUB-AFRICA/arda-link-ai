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
import { tenantForWardId } from "./wardMapping.js";
import { languageForCaller } from "./voiceCopy.js";
import {
  sendWhatsappSessionMessage,
  sendWhatsappInteractiveButtons,
  sendWhatsappLocation,
} from "./whatsappProviderRegistry.js";
import { fetchGrazingAdvisory, type GrazingAdvisory } from "./engine.js";
import { upsertPendingLocation, getPendingLocation } from "./grazingRingPending.js";
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
  //
  // Real, confirmed-live bug (2026-08-06): this used to always resolve
  // `centroidForTenant(DEFAULT_TENANT_ID)` — DEFAULT_TENANT_ID is a
  // fixed env var ("bula-pesa") — so every herder in Wabera, Ngare
  // Mara, Burat, or Oldonyiro who tapped "Malisho" got BULA PESA's
  // water points sent as real location pins, regardless of their own
  // registered ward. Fixed to use the herder's own ward first, same
  // pattern overlayNearestWaterPoint (herderContext/overlays/waterPoint.ts)
  // already used correctly two files away.
  const origin =
    centroidForTenant(tenantForWardId(ctx.wardId)) ??
    centroidForTenant(DEFAULT_TENANT_ID) ??
    { lat: 0.3453, lon: 37.581 };
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

const GRAZING_SPECIES_BUTTON_IDS: Record<string, "cattle" | "shoat" | "camel"> = {
  grazing_species_cattle: "cattle",
  grazing_species_shoat: "shoat",
  grazing_species_camel: "camel",
};

// Swahili/English keywords for each species group — used to catch a
// herder answering the species prompt by typing instead of tapping a
// button. Deliberately simple substring matching (not full NLP): a false
// negative just falls through to handleFreeText's normal LLM path, a
// false positive would misroute one question, both low-stakes compared
// to the alternative this exists to prevent (see below).
const SPECIES_KEYWORDS: Array<[RegExp, "cattle" | "shoat" | "camel"]> = [
  [/\b(ng'?ombe|cow|cows|cattle)\b/i, "cattle"],
  [/\b(mbuzi|kondoo|goat|goats|sheep|shoat)\b/i, "shoat"],
  [/\b(ngamia|camel|camels)\b/i, "camel"],
];

function detectSpeciesGroup(text: string): "cattle" | "shoat" | "camel" | null {
  for (const [re, group] of SPECIES_KEYWORDS) {
    if (re.test(text)) return group;
  }
  return null;
}

// Phrases that mean "how far / where am I relative to water" — if a
// location is already pending and the herder asks this in free text
// (rather than tapping a species button), the answer must come from a
// real distance calculation, never from the LLM. Deliberately narrow;
// anything not matched here still passes through the grounding rules in
// whatsappConversation.ts as a second layer of defense.
const DISTANCE_QUESTION_RE =
  /\b(how far|umbali|mbali|ni mbali|niko wapi|how far am i|which way|njia gani)\b/i;

/**
 * A herder just shared their GPS location. We don't know their species
 * yet (no such field exists in Supabase's pastoralists table today — see
 * the piosphere-zones plan), so ask via 3 buttons before we can call the
 * engine's ring-scoped advisory. The location is stashed in
 * grazing_ring_pending until the button reply arrives (a separate
 * webhook turn) — see that table's migration (0006) for why.
 */
async function handleLocationShare(
  from: string,
  ctx: HerderContext,
  lang: "sw" | "en",
  lat: number,
  lon: number,
  tenantId: string,
): Promise<void> {
  await upsertPendingLocation(from, lat, lon, tenantId);
  await sendWhatsappInteractiveButtons(
    from,
    lang === "sw" ? "Mifugo yako ni gani?" : "Which animals do you keep?",
    [
      { id: "grazing_species_cattle", title: "Ng'ombe" },
      { id: "grazing_species_shoat", title: "Mbuzi/Kondoo" },
      { id: "grazing_species_camel", title: "Ngamia" },
    ],
  );
  logOutbound(from, ctx, "interactive_buttons", "grazing_species_prompt");
  logInteraction(from, ctx, "grazing_location_share", `${lat},${lon}`, "grazing_species_prompt");
}

/** Swahili/English grazing-condition gloss from VCI — same rough
 * tiering as the choropleth's own color bands (see geoHelpers.ts). */
function grazingConditionText(vci: number | null, lang: "sw" | "en"): string {
  if (vci === null) return lang === "sw" ? "haijulikani" : "unknown";
  if (vci >= 60) return lang === "sw" ? "nzuri" : "good";
  if (vci >= 30) return lang === "sw" ? "wastani" : "fair";
  return lang === "sw" ? "mbaya" : "poor";
}

function formatGrazingAdvisory(advisory: GrazingAdvisory, lang: "sw" | "en"): string {
  if (!advisory.nearestWaterNode) {
    return lang === "sw"
      ? "Hatuna data ya maji karibu na eneo lako bado."
      : "No water-point data for your area yet.";
  }
  const { name, distanceKm, direction } = advisory.nearestWaterNode;
  const condition = grazingConditionText(advisory.vci, lang);
  if (lang === "sw") {
    const reach = advisory.inRing
      ? "Mifugo yako inaweza kufika."
      : "Mifugo yako HAIWEZI kufika huko (ni mbali sana).";
    return `Maji karibu: ${name} (${distanceKm}km ${direction}). Malisho: ${condition}. ${reach}`;
  }
  const reach = advisory.inRing
    ? "Your herd can reach it."
    : "Your herd CANNOT reach it (too far).";
  return `Nearest water: ${name} (${distanceKm}km ${direction}). Grazing: ${condition}. ${reach}`;
}

/**
 * The herder tapped a species button after sharing location. Look up the
 * pending location (may be missing/stale — e.g. >15 min since share) and
 * call the engine's ring-scoped advisory.
 *
 * Deliberately does NOT clear grazing_ring_pending on success — leaving
 * it in place (it still ages out via getPendingLocation's own 15-minute
 * staleness check) lets a ground-truth free-text report made shortly
 * afterward in the same conversation carry these coordinates through to
 * ground_truth_calls.reported_lat/lon (see handleFreeText below and
 * migration 0007) for QA against the ring advisory. Re-tapping a species
 * button within that window just re-fetches (cache-hit, harmless).
 */
async function handleGrazingSpeciesReply(
  from: string,
  ctx: HerderContext,
  lang: "sw" | "en",
  speciesGroup: "cattle" | "shoat" | "camel",
  tenantId: string,
): Promise<void> {
  const pending = await getPendingLocation(from);
  if (!pending) {
    const text =
      lang === "sw"
        ? "Tafadhali tuma tena mahali ulipo (share location)."
        : "Please share your location again.";
    await sendWhatsappSessionMessage(from, text);
    logOutbound(from, ctx, "text", text);
    logInteraction(from, ctx, "grazing_species_reply", speciesGroup, text);
    return;
  }

  const advisory = await fetchGrazingAdvisory(pending.lat, pending.lon, speciesGroup, tenantId);
  const text = advisory
    ? formatGrazingAdvisory(advisory, lang)
    : lang === "sw"
      ? "Samahani, huduma ya malisho haipatikani kwa sasa."
      : "Sorry, the grazing advisory isn't available right now.";

  await sendWhatsappSessionMessage(from, text);
  logOutbound(from, ctx, "text", text);
  logInteraction(from, ctx, "grazing_species_reply", speciesGroup, text);
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
  tenantId: string,
): Promise<void> {
  // Real, observed incident (2026-08-05): a herder shared a real location,
  // got the species-selection buttons, then answered by typing "10 cows"
  // instead of tapping one — and the LLM path below, with no distance-
  // calculation capability at all, went on to confidently state
  // "*25.7 km*" to the one water point in its context. Challenged
  // ("Hii si kweli" — this isn't true), it backed off, then later claimed
  // to have "received a live location" from a herder who had only typed
  // the words "Hii live" as plain text, and repeated the same invented
  // number. Prompt rules alone did not stop this. If a location is
  // already pending (getPendingLocation, same store handleLocationShare/
  // handleGrazingSpeciesReply use) and this message looks like a species
  // answer or a distance question, route to the real, computed advisory
  // instead of ever asking the LLM — no prompt engineering substitutes
  // for an actual grounded answer existing.
  const pendingLocation = await getPendingLocation(from);
  if (pendingLocation) {
    const species = detectSpeciesGroup(rawText);
    if (species) {
      await handleGrazingSpeciesReply(from, ctx, lang, species, tenantId);
      return;
    }
    if (DISTANCE_QUESTION_RE.test(rawText)) {
      await sendWhatsappInteractiveButtons(
        from,
        lang === "sw" ? "Mifugo yako ni gani?" : "Which animals do you keep?",
        [
          { id: "grazing_species_cattle", title: "Ng'ombe" },
          { id: "grazing_species_shoat", title: "Mbuzi/Kondoo" },
          { id: "grazing_species_camel", title: "Ngamia" },
        ],
      );
      logOutbound(from, ctx, "interactive_buttons", "grazing_species_prompt");
      logInteraction(from, ctx, "grazing_location_share", rawText, "grazing_species_prompt");
      return;
    }
  }

  const { complete } = await import("./llm/index.js");
  const { buildWhatsappSystemPrompt } = await import("./whatsappConversation.js");

  // Fell through the fast-paths above (no species/distance keyword
  // matched) but a location is still pending — availing the real nearest
  // water point to the LLM's context now, computed synchronously and in
  // memory (no backend round-trip, nothing for the LLM to wait on), so
  // whatever the herder actually asked has a real number behind it
  // instead of the LLM needing to invent or recall one. This is the
  // general fix behind the narrow keyword intercepts above: don't rely
  // on catching every phrasing, make the real data available up front.
  const freshWaterPoint = pendingLocation
    ? (() => {
        const [nearest] = nearestWorkingKnownPoints(pendingLocation, 1);
        return nearest
          ? { name: nearest.displayName, distanceKm: nearest.distanceKm, status: nearest.status }
          : null;
      })()
    : null;

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
  // How long since the herder's (or the bot's) last message in this
  // thread — see buildWhatsappSystemPrompt's historyLine for why this
  // matters: without it, a conversation that went cold for hours reads
  // to the LLM exactly like one still mid-exchange, and it reflexively
  // continues the old topic instead of responding to what's actually
  // being asked now.
  const lastMessageAt = conversational.at(-1)?.occurred_at;
  const gapMinutes = lastMessageAt
    ? (Date.now() - new Date(lastMessageAt).getTime()) / 60_000
    : null;
  const systemPrompt = buildWhatsappSystemPrompt(
    ctx,
    lang,
    hasHistory,
    freshWaterPoint,
    gapMinutes,
  );

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

  // Shown both when the LLM registry falls back to mock (no real
  // secondary provider is configured behind Azure as of 2026-08-06 —
  // ZAI_API_KEY/MINIMAX_API_KEY are unset, a deliberate owner decision
  // to accept Azure-only for now) and on a genuine empty completion.
  // Deliberately says there's a hiccup and to retry, rather than a
  // generic "thanks" that reads as if the herder's actual question was
  // ignored.
  const safeDefault =
    lang === "sw"
      ? "Samahani, kuna hitilafu ya muda mfupi kwenye mfumo — jaribu tena baada ya dakika chache. 🙏"
      : "Sorry, there's a brief system hiccup — please try again in a few minutes. 🙏";
  // Hard backstop: MockClient (used when no real provider is reachable —
  // see llm/providers/mock.ts) must never reach a live herder. This
  // checks `isMock`, NOT `provider` — MockClient is constructed as
  // `new MockClient('z', 'glm-4.5-flash')` etc. specifically to
  // impersonate the real provider it's standing in for, so `provider`
  // is never the literal string "mock" in practice. A prior version of
  // this guard checked `provider === "mock"` and could therefore never
  // fire: confirmed live on 2026-08-06 when the z.ai->minimax fallback
  // chain bottomed out mid-conversation and "[MOCK z/glm-4.5-flash]
  // niko Ngare Mara" (the raw mock echo) reached a real WhatsApp tester
  // verbatim. If this ever fires, fail safe to the same default reply
  // used for an empty completion rather than surface a degraded/
  // placeholder answer.
  if (llmResponse.isMock) {
    logger.error(
      { from, provider: llmResponse.provider, model: llmResponse.model },
      "[WhatsApp] Free-text turn: LLM registry fell back to mock — sending safe default instead of mock content",
    );
  }
  const reply = llmResponse.isMock
    ? safeDefault
    : llmResponse.content || safeDefault;
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
    // Best-effort: carry through coordinates from a recent location
    // share (grazing_ring_pending, still-fresh within its own 15-minute
    // staleness window — see handleGrazingSpeciesReply's docstring for
    // why that row isn't cleared on use) so this ground-truth row can
    // later be QA'd against the piosphere-ring advisory it followed.
    // null when no location share preceded this report — expected and
    // fine, not every ground-truth turn follows a location share.
    const recentLocation = await getPendingLocation(from);
    void insertGroundTruthCall(
      mapExtractedIndicatorsToGroundTruthRow({
        pastoralistId: ctx.pastoralistId,
        wardId: ctx.wardId,
        indicators,
        trustScore: trust.score,
        transcript,
        sourceLanguage: lang,
        channel: "whatsapp",
        reportedLat: recentLocation?.lat,
        reportedLon: recentLocation?.lon,
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
    // Prefer msg.from (already normalized by the provider route's
    // toE164FromJid) over the raw status.recipientId — the raw JID
    // has no "+" and, for groups/LIDs, a different suffix than what
    // message rows use, which was splitting one conversation's status
    // receipts and its actual messages under two different
    // phone_number values (observed for real: a group's ERROR
    // delivery statuses were invisible against its own message thread).
    const phoneNumber = msg.from ?? msg.status?.recipientId ?? "unknown";
    if (msg.status?.status === "ERROR") {
      // Every other status (SERVER_ACK/DELIVERY_ACK/READ) is routine
      // and logged at info-via-DB only. ERROR means the recipient never
      // actually got the message — observed for real against a group
      // chat where every single outbound send failed silently; nothing
      // previously distinguished this from ordinary delivery noise.
      logger.warn(
        { phoneNumber, messageId: msg.status?.id },
        "[WhatsApp] Delivery ERROR — recipient did not receive a sent message",
      );
    }
    void logWhatsappMessage({
      phone_number: phoneNumber,
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
    await handleLocationShare(
      msg.from,
      ctx,
      lang,
      msg.location.lat,
      msg.location.lon,
      tenantId,
    );
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
    } else if (msg.replyId && msg.replyId in GRAZING_SPECIES_BUTTON_IDS) {
      await handleGrazingSpeciesReply(
        msg.from,
        ctx,
        lang,
        GRAZING_SPECIES_BUTTON_IDS[msg.replyId]!,
        tenantId,
      );
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
    await handleFreeText(msg.from, ctx, lang, msg.text, tenantId);
    return;
  }
}
