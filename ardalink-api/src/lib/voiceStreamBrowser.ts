import WebSocket from "ws";
import { logger } from "./logger.js";

const BROWSER_TENANT_ID = process.env.DETERMINISTIC_TENANT_ID ?? "bula-pesa";
import { getLastResult } from "./intelligence.js";
import { formatWaterPointsBlock } from "./data/bulaPesaWaterPoints.js";
import { formatLandmarksBlock } from "./data/bulaPesaLandmarks.js";
import { formatProximityBlock } from "./data/proximity.js";
import {
  formatHerderMemoryBlock,
  formatWardRollupBlock,
  formatWaterPointUsageBlock,
} from "./memory.js";
import { formatSatelliteWaterBodiesBlock } from "./waterBodies.js";
import {
  generateActionTag,
  extractIndicators,
  indicatorCollectionBlock,
} from "./openai/index.js";
import { droughtLabel, maiLabel } from "./climate.js";
import {
  registerPublicSessionOpen,
  registerPublicSessionClosed,
  MAX_CALL_DURATION_MS,
} from "./callTokens.js";
import { settleTokenReservation } from "./callTokens.js";
import { computeTrustScore, logTrustScore } from "./trustScore.js";

type EndReason =
  | "ai_ended"
  | "user_hangup"
  | "max_duration_reached"
  | "no_speech_timeout"
  | "unknown";

/** How long to wait for the caller's first utterance after the AI's opening
 * greeting finishes before assuming the line is dead (someone pocket-dialled,
 * background music, etc.) and tearing the bridge down. Keeps abusers from
 * burning Azure tokens with silent calls. */
const NO_SPEECH_TIMEOUT_MS = 25_000;

const REALTIME_DEPLOYMENT =
  process.env.AZURE_OPENAI_REALTIME_DEPLOYMENT ?? "gpt-4o-realtime-preview";
const REALTIME_API_VERSION =
  process.env.AZURE_OPENAI_REALTIME_API_VERSION ?? "2025-04-01-preview";

function realtimeUrl(): string {
  const base = process.env
    .AZURE_OPENAI_ENDPOINT!.replace(/^https:\/\//, "wss://")
    .replace(/\/$/, "");
  return `${base}/openai/realtime?api-version=${REALTIME_API_VERSION}&deployment=${REALTIME_DEPLOYMENT}`;
}

async function buildBrowserSystemPrompt(phone: string | null): Promise<string> {
  const last = getLastResult();
  // Pull every dynamic block in parallel so we don't serialise their
  // 800 ms DB timeouts + Earth Engine cache fetch on call setup.
  const [herderMemory, wardRollup, waterUsage, waterBodies] = await Promise.all(
    [
      formatHerderMemoryBlock(phone),
      formatWardRollupBlock(),
      formatWaterPointUsageBlock(),
      formatSatelliteWaterBodiesBlock(),
    ],
  );
  const memoryBlock = [herderMemory, wardRollup, waterUsage]
    .filter(Boolean)
    .join("\n\n");
  if (!last) {
    return `You are ArdaLink, a respected range management expert in Isiolo, Kenya, with 30 years of experience working with Borana pastoralists.

LANGUAGE POLICY (critical):
- Default to clear, friendly English. This caller is most likely an English speaker.
- Open with a brief bilingual hello — for example: "Hello — habari." — then continue in English.
- If the caller replies in Swahili, Borana, or Kiswahili, immediately switch to that language and stay there for the rest of the call.
- Never lecture the caller about language. Just mirror them.

Keep each reply under 20 seconds of speech. Be warm, concrete, and curious — never preachy.

No satellite data is loaded yet. Greet briefly and invite them to ask a general question about pastoralism, drought, or rangeland management — or tell them to run a satellite check first.`;
  }

  const climateBlock = last.climate
    ? `
CURRENT CLIMATE (30-day ERA5):
- Temperature: ${last.climate.rolling30Day.meanTempC.toFixed(1)}°C  |  Humidity: ${last.climate.current.humidityPct.toFixed(0)}%
- 30-day rainfall: ${last.climate.rolling30Day.totalPrecipMm.toFixed(1)}mm over ${last.climate.rolling30Day.rainyDays} rainy days
- ET₀ demand: ${last.climate.rolling30Day.totalET0Mm.toFixed(0)}mm
- Soil moisture: ${(last.climate.rolling30Day.meanSoilMoisture * 100).toFixed(1)}%
- Moisture Adequacy: ${last.climate.rolling30Day.moistureAdequacyIndex.toFixed(2)} — ${droughtLabel(last.climate.rolling30Day.droughtSeverity)} (${maiLabel(last.climate.rolling30Day.moistureAdequacyIndex)})`
    : "";

  const forecastBlock = last.forecast
    ? `
14-DAY VEGETATION FORECAST (${last.forecast.outlook.riskLevel.toUpperCase()} risk):
- ${last.forecast.forecast14d.totalPrecipMm.toFixed(0)}mm rain expected, ${last.forecast.forecast14d.totalET0Mm.toFixed(0)}mm evaporation
- Effective rain reaching roots: ${last.forecast.forecast14d.effectiveRainMm.toFixed(0)}mm
- Stress direction: ${last.forecast.outlook.stressDirection.toUpperCase()}
- Recovery estimate: ${last.forecast.outlook.estimatedRecoveryDays != null ? `~${last.forecast.outlook.estimatedRecoveryDays} days if forecast holds` : "no recovery expected this season without exceptional rain"}
- Recommendation: ${last.forecast.outlook.recommendation}`
    : "";

  // Real sub-areas of Bula Pesa Ward, keyed by satellite quadrant.
  // The model must speak in place names a herder recognises, never "NW/SE".
  const QUAD_TO_PLACE: Record<"NW" | "NE" | "SW" | "SE", string> = {
    NW: "the pastures toward Wabera (northwest)",
    NE: "the highlands toward Ngare Mara (northeast)",
    SW: "around Bulla Pesa town and the southwest water points",
    SE: "the dryland toward Kambi Garba (southeast)",
  };

  const anomaly = last.live?.anomaly;
  const worstPlace = anomaly
    ? (QUAD_TO_PLACE[anomaly.worstQuadrant as keyof typeof QUAD_TO_PLACE] ??
      anomaly.worstQuadrant)
    : "";
  const quadBreakdown = anomaly
    ? (["NW", "NE", "SW", "SE"] as const)
        .map(
          (q) =>
            `  • ${QUAD_TO_PLACE[q]}: ${anomaly.quadrantMeanAnomalyPct[q]?.toFixed(1)}% vs baseline`,
        )
        .join("\n")
    : "";

  const satBlock = anomaly
    ? `
SATELLITE SNAPSHOT — ${last.month_name ?? new Date().toLocaleString("en", { month: "short" }).toUpperCase()} (Sentinel-2):
- ${anomaly.wardStressedPixelPct.toFixed(1)}% of Bula Pesa Ward is vegetation-stressed vs. the 11-year baseline
- Worst area: ${worstPlace} — ${anomaly.quadrantMeanAnomalyPct[anomaly.worstQuadrant as keyof typeof anomaly.quadrantMeanAnomalyPct]?.toFixed(1)}% below normal
- NDVI (greenness) median: ${anomaly.NDVI.p50.toFixed(1)}% vs baseline
- RED_EDGE (early stress): ${anomaly.RED_EDGE.p50.toFixed(1)}% vs baseline
- Full breakdown by area:
${quadBreakdown}`
    : "";

  return `You are ArdaLink, a respected veteran range management expert in Isiolo, Kenya. You have 30 years of working with Borana pastoralists. Your tone is wise, empathetic, and deeply localized.

LANGUAGE POLICY (critical):
- Default to clear, natural English — this caller is most likely an English speaker.
- Open with a brief bilingual hello (e.g. "Hello — habari."), then continue in English.
- Always mirror the language of the caller's MOST RECENT utterance. If they speak Swahili or Borana, switch on the very next reply and stay there. If they switch back to English, switch back. Mirror code-switching mid-sentence ("water for the cows" → answer in kind).
- If a single utterance is ambiguous, hold the previous language and gently invite either: "Tuendelee kwa Kiswahili au English?" Don't lecture about the switch — just do it.

ACCENTS & DIALECTS (critical — this is northern Kenya, not Nairobi):
- Callers speak many varieties: Borana-accented Swahili (heavy "r" rolls, "h" often dropped), upcountry Swahili (Kikuyu/Meru-flavoured, "l"↔"r" swaps, mixed tense), Coastal Kiswahili Sanifu, Sheng, and broken English mixed with Swahili. ALL of these are correct Swahili to you. NEVER correct grammar, pronunciation, or word choice. NEVER repeat their phrase back "correctly" — that is patronising.
- If a word sounds non-standard but you can infer the meaning from context (livestock, water, place names, weather), proceed as if you understood. Borana herders often say "ng'ombe" with a heavy nasal, "mvua" with a long vowel, place names like "Kambi Garba" with a glottal stop — these are not mistakes.
- Use simple, common words. Avoid Kiswahili Sanifu textbook vocabulary that an Isiolo herder would not use day-to-day. Prefer "ng'ombe" over "fahali", "maji" over "kimiminika", "kondoo na mbuzi" over compound terms.

NOISY ENVIRONMENT (critical — the caller is outdoors):
- Expect background noise constantly: wind, goats bleating, cattle, motorbikes, market chatter, generators, radio. Treat partial words as normal — do NOT assume silence means they finished; herders pause to think or to manage animals.
- If you genuinely could not catch what they said (not just heard something unexpected), ask ONCE, briefly and warmly: "Samahani, mtandao ulikatika kidogo — uliposema X, ulimaanisha nini?" or "Sorry, the wind cut you off — could you say that part again?" Frame it as your hearing / the network, never their fault.
- If you caught most of it but missed one detail, ask for THAT detail only — don't ask them to repeat the whole sentence.
- NEVER pretend to have understood and fabricate a response. If you only caught "ng'ombe ... maji ... shida", say so: "I heard cattle, water, and a problem — tell me more about the water issue."
- Do NOT ask the caller to move somewhere quieter, lower their voice, or stop their animals. They are working. Adapt to them.

GEOGRAPHY (critical):
- Bula Pesa Ward has four sub-areas, each with a real name. ALWAYS use the names, never compass codes like "NW/SE":
  • Wabera (northwest pastures)
  • Ngare Mara (northeast highlands)
  • Bulla Pesa town (southwest — town centre, water points, two boreholes)
  • Kambi Garba (southeast dryland)
- When guiding the herder, anchor to a specific named place — e.g. "the pastures toward Wabera look healthier today; the area near Kambi Garba is critically stressed." Use the per-area numbers in the satellite block, not made-up ones.
- If the herder names a place that IS one of the four, anchor your reply to it with the matching number.
- If the herder names a place that is NOT one of the four (e.g. Burat, Kinna, a manyatta), acknowledge it warmly, briefly say you don't have direct satellite coverage for that exact spot, and offer the nearest covered area's reading. Never fabricate a number for an unmapped place.

${formatLandmarksBlock()}

${formatWaterPointsBlock()}

${waterBodies}

${formatProximityBlock()}

EXPECT ANYTHING (critical — this is a live phone line, not a script):
- The caller can say literally anything: personal questions ("how old are you?", "are you a real person?"), tangents (politics, religion, prices, family, jokes, football, weather small-talk), tests ("what is 2+2?", "sing me a song"), complaints, prayers, silence, or completely unrelated questions (recipes, news, market rates, what's the capital of X, advice about non-livestock things). You handle ALL of it gracefully. Never refuse, never say "I can only talk about X", never act confused.
- Answer briefly and warmly first (one or two sentences in their language), then — only if it feels natural — bridge back to what you actually know about (their animals, their pasture, the satellite picture, the forecast, water). Do NOT force the bridge if it would feel rude or robotic. Sometimes the right move is just to answer their question and let them lead.
- If asked "are you a person?" or "are you AI?" — be honest in one sentence: "Mimi ni msaidizi wa kidigitali wa ArdaLink — nakusaidia kwa data ya satellite na ushauri wa mifugo. Lakini tunaongea kama watu." Then continue normally.
- If asked something you genuinely don't know (specific market price today, news event, somebody's phone number, religious ruling), say so honestly in one line ("Hiyo sina hakika nayo leo") and offer what you DO know that's adjacent. Never invent.
- If the caller jokes or teases, laugh with them briefly ("ehe, umenicheka!") — warmth beats stiffness. Then continue.

Keep each response under 20 seconds AND under ONE question per turn. Be warm, concrete, curious — never preachy. Pair every question with a useful piece of information so the caller never feels interrogated.
${satBlock}
${climateBlock}
${forecastBlock}

${memoryBlock ? memoryBlock + "\n\n" : ""}${indicatorCollectionBlock()}

CALL FLOW (follow in order, but be conversational — do NOT read this as a script):
  1. Greet briefly with a bilingual hello and say you have today's satellite reading for Bula Pesa Ward.
  2. Ask ONE opening question: where they are grazing today. (Don't assume any place.)
  3. As soon as they answer (even partially), SHARE the satellite reading for that area — the % below baseline, the worst-stressed neighbouring area, and one concrete implication. This is the value they came for; do not delay it behind more questions.
  4. Ask what species they have with them today (cattle / goats / sheep / camels) — anchor your advice to the actual species. Do NOT assume cows.
  5. Ask the BCS question using their actual species.
  6. Collect AT MOST 2 secondary indicators — only the ones most relevant given what they've already told you. Skip any that are obviously irrelevant. If they say they didn't visit a water point, log it as unknown and move on — never infer "not operational" from "I didn't go there".
  7. DELIVER ADVICE (mandatory — see ADVICE BEFORE HANG-UP below). Then close warmly.

ADVICE BEFORE HANG-UP (mandatory):
- You MUST give at least ONE concrete, actionable recommendation the herder can act on this week BEFORE invoking end_call. Collecting indicators is NOT advice.
- Anchor the advice to: (a) the satellite reading for their area, (b) their species, (c) their BCS. Examples of acceptable advice:
    • "Move the goats from Kambi Garba toward the Wabera pastures by Friday — that's where the greenness is holding."
    • "With BCS 2 on the cattle, start supplementary feeding this week — even 1 kg/day of hay per animal will slow the decline before the next rains."
    • "Skip the southwest boreholes for two days; the rain forecast shows 8mm reaching the soil — water will be cheaper after Tuesday."
- If you genuinely cannot give specific advice (e.g. caller refused to share location AND species), tell them honestly and offer to call back — do NOT end the call claiming "advice delivered" when it wasn't.

WIND-DOWN (mandatory — natural, not robotic):
Talk like a human on a phone call, not a script reader. Wind down in ONE fluid turn, then listen, then say goodbye.
  Turn 1 (single flowing sentence — do NOT pause mid-way): Briefly signal you're wrapping up, recap the 1–2 most important actions in plain words, and invite a last question — all in one breath. Example: "Sawa, basi kabla hatujamaliza — kumbuka: ng'ombe waende upande wa Wabera ifikapo Ijumaa, na anza kuwapa kilo moja ya nyasi kila siku. Kuna swali lingine?"
  Then PAUSE and listen for their reply.
  Turn 2: Address whatever they said briefly (or if they said "no", just acknowledge warmly), then say a warm bilingual goodbye in the same turn: "Sawa. Asante sana kwa muda wako, Mungu akubariki. Kwaheri." → invoke end_call immediately after this goodbye finishes.
If the caller asks a substantive new question during the wind-down, answer it fully and restart the wind-down — do not rush to hang up.
NEVER produce a turn that is only a transition phrase like "let me leave you with the key things" without the actual content right after — that creates dead air. Always pack the signal + the content together.

Whole call ≤ 4 minutes. Quality of advice matters more than completeness of indicators.`;
}

interface TranscriptEntry {
  role: "user" | "assistant";
  text: string;
}

export function handleBrowserVoiceStream(
  browserWs: WebSocket,
  phone: string | null = null,
  token: string | null = null,
): void {
  const transcript: TranscriptEntry[] = [];
  let callEnded = false;
  let endCallScheduled = false;
  let endCallFallbackTimer: NodeJS.Timeout | null = null;
  let waitingForFinalAudioDone = false;
  // After the model invokes end_call we must NOT close the socket until the
  // browser has actually finished playing the buffered tail of the goodbye/
  // advice. response.audio.done only means Azure stopped *generating* — the
  // browser still has several seconds of scheduled audio. Closing before
  // playback_ended cuts the advice off mid-sentence.
  let endingCallAwaitingPlayback = false;
  let endReason: EndReason = "unknown";
  let userHasSpoken = false;
  let noSpeechTimer: NodeJS.Timeout | null = null;
  // Server-side gate: the model frequently tries to invoke end_call on its
  // wind-down turn before it has actually collected the caller's situation
  // or delivered anchored advice. Below these thresholds, we reject the
  // tool call and tell the model what is still missing so it loops back
  // and finishes properly instead of cutting the line dead.
  const MIN_CALL_DURATION_MS = 75_000;
  const MIN_CALLER_TURNS = 3;
  let callerTurnCount = 0;
  let endCallRejectedOnce = false;
  // Track whether AI is currently producing audio so we know when an
  // input_audio_buffer.speech_started event means "caller is interrupting".
  let aiAudioInFlight = false;
  let activeAzureResponseId: string | null = null;
  // After barge-in we send response.cancel to Azure, but audio deltas
  // already in flight can still arrive over the WS for a few hundred ms
  // and would leak back to the browser after the caller "interrupted".
  // Drop deltas until the cancelled response officially terminates.
  let suppressAudioUntilResponseDone = false;
  // Safety timer: if the browser stops reporting playback_ended (lost
  // message, tab backgrounded), force-clear aiAudioInFlight after a grace
  // period so barge-in eventually re-arms.
  let aiPlaybackFallbackTimer: ReturnType<typeof setTimeout> | null = null;

  // Short Swahili/English affirmations/negations that are real caller
  // turns despite being <4 chars. Without this, "la", "ndio", "poa",
  // "yes" wouldn't open the end_call gate and the model would loop.
  const SHORT_AFFIRM_WORDS = new Set([
    "yes",
    "no",
    "ok",
    "okay",
    "yeah",
    "yep",
    "sure",
    "la",
    "ndio",
    "ndiyo",
    "sawa",
    "poa",
    "haya",
    "eh",
    "ee",
    "eee",
  ]);
  const isSubstantiveTurn = (text: string): boolean => {
    if (text.length >= 4) return true;
    const norm = text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
    return SHORT_AFFIRM_WORDS.has(norm);
  };

  const isPublicSession = phone != null;
  if (isPublicSession) registerPublicSessionOpen();
  const sessionStartMs = Date.now();

  const clearNoSpeechTimer = (): void => {
    if (noSpeechTimer) {
      clearTimeout(noSpeechTimer);
      noSpeechTimer = null;
    }
  };
  // Arm only after the AI's opening greeting has finished playing — otherwise
  // we'd tear down legitimate calls where the caller is just listening.
  const armNoSpeechTimer = (): void => {
    if (userHasSpoken || noSpeechTimer || callEnded) return;
    noSpeechTimer = setTimeout(() => {
      if (userHasSpoken || callEnded) return;
      logger.warn(
        { phone, timeoutMs: NO_SPEECH_TIMEOUT_MS },
        "[Browser Voice] no-speech timeout — closing dead line",
      );
      endReason = "no_speech_timeout";
      try {
        send(browserWs, { type: "end_call", reason: "no_speech_timeout" });
      } catch {
        // ignore
      }
      if (browserWs.readyState === WebSocket.OPEN) browserWs.close();
    }, NO_SPEECH_TIMEOUT_MS);
  };

  // Server-side hard cap. Even if the model never invokes end_call, even if
  // the user closes their laptop with the tab open, the bridge is forcibly
  // torn down after MAX_CALL_DURATION_MS — bounding worst-case Azure spend
  // per session.
  const hardCapTimer = setTimeout(() => {
    if (browserWs.readyState === WebSocket.OPEN) {
      logger.warn(
        { phone, capMs: MAX_CALL_DURATION_MS },
        "[Browser Voice] hard cap reached — closing",
      );
      endReason = "max_duration_reached";
      try {
        send(browserWs, { type: "end_call", reason: "max_duration_reached" });
      } catch {
        // ignore
      }
      browserWs.close();
    }
  }, MAX_CALL_DURATION_MS);

  // Soft wrap-up nudge — fires 60s before the hard cap. We inject a system
  // message telling the model to deliver final advice + goodbye + end_call
  // NOW so the hard cap never chops it mid-sentence. The model picks this
  // up on its next response turn (after the caller's next utterance, or
  // immediately if it's already mid-monologue). This is the fix for
  // "the call cut me without advice".
  const softWrapTimer = setTimeout(
    () => {
      if (callEnded) return;
      if (!openaiWs || openaiWs.readyState !== WebSocket.OPEN) return;
      try {
        openaiWs.send(
          JSON.stringify({
            type: "conversation.item.create",
            item: {
              type: "message",
              role: "system",
              content: [
                {
                  type: "input_text",
                  text: "TIME CHECK — About 60 seconds of call time remain. On your VERY NEXT turn: (1) deliver your single most important piece of practical, anchored advice based on what this caller has told you, 1–3 short sentences, in the language they're speaking; (2) say a warm bilingual goodbye (Asante sana, kwaheri / Goodbye); (3) invoke the end_call tool. Do NOT start a new topic, do NOT ask another question, do NOT collect more indicators.",
                },
              ],
            },
          }),
        );
        logger.info(
          { phone },
          "[Browser Voice] soft wrap-up nudge sent at T-60s",
        );
      } catch (err) {
        logger.warn(
          { err, phone },
          "[Browser Voice] failed to send soft wrap-up nudge",
        );
      }
    },
    Math.max(30_000, MAX_CALL_DURATION_MS - 60_000),
  );

  logger.info({ phone, isPublicSession }, "Browser voice stream opened");

  const openaiWs = new WebSocket(realtimeUrl(), {
    headers: { "api-key": process.env.AZURE_OPENAI_API_KEY! },
  });

  const send = (ws: WebSocket, obj: unknown): void => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  };

  openaiWs.on("open", async () => {
    logger.info("Azure Realtime connected (browser bridge)");

    const instructions = await buildBrowserSystemPrompt(phone);
    send(openaiWs, {
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        instructions,
        voice: "alloy",
        input_audio_format: "pcm16",
        output_audio_format: "pcm16",
        input_audio_transcription: { model: "whisper-1" },
        turn_detection: {
          type: "server_vad",
          // 0.4 = sensitive enough to catch soft / quiet speech (incl. a
          // near-whisper) while still rejecting most non-speech noise.
          // Whisper-1 transcription acts as the second filter — empty /
          // sub-4-char transcripts are ignored downstream.
          threshold: 0.4,
          prefix_padding_ms: 300,
          silence_duration_ms: 450,
        },
        tools: [
          {
            type: "function",
            name: "end_call",
            description:
              "Gracefully hang up the line. TWO preconditions, both required: (1) you have already spoken at least one specific, actionable recommendation anchored to the caller's area, species, and BCS (indicators alone do NOT count); AND (2) you have done the wind-down — recapped the key actions, invited a final question, listened to their reply, and spoken the bilingual goodbye. Invoke this IMMEDIATELY after the goodbye line finishes, in the same turn as the goodbye. Never invoke twice.",
            parameters: {
              type: "object",
              properties: {
                reason: {
                  type: "string",
                  description:
                    "One short sentence on why the call is ending (e.g. 'indicators collected and advice delivered', 'caller needed to go').",
                },
              },
              required: ["reason"],
            },
          },
        ],
        tool_choice: "auto",
      },
    });
    // NOTE: response.create is sent after we receive `session.updated` below.
    // Sending it eagerly here races the session config and Azure can return
    // a text-only response with zero audio deltas — the AI appears silent.
  });

  openaiWs.on("message", (raw) => {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(raw.toString()) as Record<string, unknown>;
    } catch {
      return;
    }

    const type = event["type"] as string;

    switch (type) {
      case "session.updated": {
        // Now safe to ask Azure for an opening greeting with audio modality
        // explicitly attached so it cannot default to text-only.
        logger.info(
          "Azure Realtime session.updated — requesting opening greeting",
        );
        send(openaiWs, {
          type: "response.create",
          response: { modalities: ["audio", "text"] },
        });
        break;
      }
      case "response.created": {
        const respId =
          (event["response"] as { id?: string } | undefined)?.id ?? null;
        activeAzureResponseId = respId;
        // A fresh response is starting — never gag it with leftover
        // suppression from a previous cancelled response.
        suppressAudioUntilResponseDone = false;
        logger.info({ responseId: respId }, "Azure Realtime response.created");
        break;
      }
      case "input_audio_buffer.speech_started": {
        // Caller actually spoke — cancel the dead-line teardown.
        if (!userHasSpoken) {
          userHasSpoken = true;
          clearNoSpeechTimer();
          logger.info(
            { phone },
            "[Browser Voice] first caller speech detected",
          );
        }
        // Barge-in: if AI is mid-utterance, cancel the in-flight Azure
        // response and tell the browser to flush its queued AI audio so
        // the caller can interrupt mid-sentence like a real phone call.
        if (aiAudioInFlight) {
          // Only suppress + cancel when Azure actually has a live response.
          // If activeAzureResponseId is null we're just draining the browser's
          // buffered tail — sending response.cancel into a void leaves
          // suppressAudioUntilResponseDone stuck true (no response.done ever
          // arrives) and the AI goes permanently mute for the rest of the call.
          if (activeAzureResponseId) {
            logger.info(
              { phone, responseId: activeAzureResponseId },
              "[Browser Voice] barge-in — cancelling AI response",
            );
            send(openaiWs, { type: "response.cancel" });
            suppressAudioUntilResponseDone = true;
          } else {
            logger.info(
              { phone },
              "[Browser Voice] barge-in during tail playback — flushing browser only",
            );
          }
          send(browserWs, { type: "interrupt" });
          aiAudioInFlight = false;
        }
        break;
      }
      case "response.audio.delta": {
        if (suppressAudioUntilResponseDone) break;
        const delta = event["delta"] as string | undefined;
        if (delta) {
          aiAudioInFlight = true;
          send(browserWs, { type: "audio", data: delta });
        }
        break;
      }
      case "response.audio.done": {
        // Do NOT clear aiAudioInFlight here — Azure has only stopped
        // *generating*; the browser is still *playing* the buffered tail
        // (often 3–8 seconds). Clearing the flag now would defeat barge-in
        // during that window. The client reports {type:"playback_ended"}
        // when its scheduled audio queue actually drains.
        send(browserWs, { type: "audio_done" });
        // First AI turn just finished — start watching for caller speech.
        // Idempotent; later audio.done events are no-ops here.
        if (!userHasSpoken) armNoSpeechTimer();
        if (waitingForFinalAudioDone) {
          // Azure stopped generating the goodbye audio, but the browser is
          // still PLAYING the buffered tail (3–8s of scheduled chunks).
          // Don't close here — wait for the browser to send playback_ended.
          waitingForFinalAudioDone = false;
          endingCallAwaitingPlayback = true;
          logger.info(
            "[Browser Voice] final audio.done — waiting for browser playback_ended before close",
          );
        }
        break;
      }
      case "response.done": {
        const resp = event["response"] as
          | { status?: string; status_details?: unknown }
          | undefined;
        if (resp?.status && resp.status !== "completed") {
          logger.warn(
            { status: resp.status, details: resp.status_details },
            "Azure Realtime response.done non-completed",
          );
        }
        activeAzureResponseId = null;
        suppressAudioUntilResponseDone = false;
        // Safety net: if for any reason the browser never sends
        // playback_ended (lost message, tab closed, etc.) force the flag
        // false after a generous timeout so barge-in stays meaningful.
        if (aiPlaybackFallbackTimer) clearTimeout(aiPlaybackFallbackTimer);
        aiPlaybackFallbackTimer = setTimeout(() => {
          aiAudioInFlight = false;
          aiPlaybackFallbackTimer = null;
        }, 20_000);
        break;
      }
      case "conversation.item.input_audio_transcription.completed": {
        const text = event["transcript"] as string | undefined;
        const trimmed = text?.trim() ?? "";
        if (trimmed) {
          transcript.push({ role: "user", text: trimmed });
          if (isSubstantiveTurn(trimmed)) {
            callerTurnCount += 1;
          } else {
            logger.info(
              { phone, text: trimmed },
              "[Browser Voice] sub-substantive transcript — not counted as caller turn",
            );
          }
          send(browserWs, { type: "transcript", role: "user", text: trimmed });
        }
        break;
      }
      case "response.function_call_arguments.done": {
        const name = event["name"] as string | undefined;
        const callId = event["call_id"] as string | undefined;
        const argsRaw = event["arguments"] as string | undefined;
        if (name !== "end_call") break;
        if (endCallScheduled) {
          logger.info(
            "[Browser Voice] end_call invoked again — ignoring (latch)",
          );
          break;
        }
        const elapsedMs = Date.now() - sessionStartMs;
        const gateOpen =
          elapsedMs >= MIN_CALL_DURATION_MS &&
          callerTurnCount >= MIN_CALLER_TURNS;
        if (!gateOpen) {
          // Premature hangup — reject the tool call and tell the model
          // exactly what's missing so it loops back to deliver real advice.
          logger.warn(
            {
              elapsedMs,
              callerTurnCount,
              minMs: MIN_CALL_DURATION_MS,
              minTurns: MIN_CALLER_TURNS,
            },
            "[Browser Voice] end_call rejected — gate not yet open",
          );
          endCallRejectedOnce = true;
          if (callId) {
            send(openaiWs, {
              type: "conversation.item.create",
              item: {
                type: "function_call_output",
                call_id: callId,
                output: JSON.stringify({
                  ok: false,
                  reason:
                    "NOT READY TO END. You have only spoken for " +
                    Math.round(elapsedMs / 1000) +
                    "s across " +
                    callerTurnCount +
                    " caller turn(s). You have not yet collected enough about this caller's situation OR delivered specific, actionable advice anchored to: (1) the satellite reading for the area they named, (2) the species they have with them today, (3) their BCS score. Do NOT call end_call again until you have done all three. Continue the conversation now: ask whichever of those three you are missing, then deliver one concrete recommendation that uses all three (e.g. 'Move the goats from Kambi Garba toward Wabera by Friday — that area is 34% below normal and your BCS 2 goats need the better grass'). Only after the caller has heard that advice and you have done the wind-down may you call end_call.",
                }),
              },
            });
            // Prompt the model to continue talking with proper anchored advice.
            send(openaiWs, {
              type: "response.create",
              response: { modalities: ["audio", "text"] },
            });
          }
          break;
        }
        endCallScheduled = true;
        endReason = "ai_ended";
        let reason = "unspecified";
        try {
          const parsed = argsRaw
            ? (JSON.parse(argsRaw) as { reason?: string })
            : {};
          if (parsed.reason) reason = parsed.reason;
        } catch {
          // ignore
        }
        logger.info(
          {
            reason,
            elapsedMs,
            callerTurnCount,
            rejectedOnce: endCallRejectedOnce,
          },
          "[Browser Voice] AI invoked end_call",
        );
        if (callId) {
          send(openaiWs, {
            type: "conversation.item.create",
            item: {
              type: "function_call_output",
              call_id: callId,
              output: JSON.stringify({ ok: true }),
            },
          });
        }
        send(browserWs, { type: "end_call", reason });
        waitingForFinalAudioDone = true;
        // Ultimate safety net: if neither audio.done nor playback_ended ever
        // arrives (lost message, browser tab closed mid-goodbye, network
        // hiccup), force-close after 15s. Generous because a normal goodbye
        // is ~6s of audio + 2–3s of browser-buffered tail = ~10s total.
        endCallFallbackTimer = setTimeout(() => {
          if (browserWs.readyState === WebSocket.OPEN) {
            logger.info(
              "[Browser Voice] closing after end_call fallback timeout",
            );
            browserWs.close();
          }
        }, 15_000);
        break;
      }
      case "response.audio_transcript.done": {
        const text = event["transcript"] as string | undefined;
        if (text?.trim()) {
          transcript.push({ role: "assistant", text: text.trim() });
          send(browserWs, {
            type: "transcript",
            role: "assistant",
            text: text.trim(),
          });
        }
        break;
      }
      case "error": {
        const errVal = event["error"];
        const errObj =
          errVal && typeof errVal === "object"
            ? (errVal as Record<string, unknown>)
            : null;
        const errCode =
          errObj && typeof errObj["code"] === "string"
            ? (errObj["code"] as string)
            : "";
        const errMsgRaw =
          typeof errVal === "string"
            ? errVal
            : errObj && "message" in errObj
              ? String(errObj["message"])
              : errVal != null
                ? JSON.stringify(errVal)
                : "Realtime error";
        // Cancellation races are benign — they happen when a response
        // completes a hair before our barge-in cancel reaches Azure.
        // Don't surface them as errors to the caller.
        const isBenignCancel =
          errCode === "response_cancel_not_active" ||
          /cancellation failed.*no active response/i.test(errMsgRaw);
        if (isBenignCancel) {
          logger.info(
            { phone, code: errCode },
            "[Browser Voice] benign cancel race — ignoring",
          );
          break;
        }
        logger.error({ event }, "Azure Realtime error (browser)");
        send(browserWs, { type: "error", message: errMsgRaw });
        break;
      }
      default:
        break;
    }
  });

  openaiWs.on("close", () => {
    logger.info("Azure Realtime closed (browser bridge)");
    if (browserWs.readyState === WebSocket.OPEN) browserWs.close();
  });

  openaiWs.on("error", (err) => {
    logger.error({ err }, "Azure Realtime WS error (browser)");
    send(browserWs, { type: "error", message: "Realtime connection error" });
    if (browserWs.readyState === WebSocket.OPEN) browserWs.close();
  });

  browserWs.on("message", (raw) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw.toString()) as Record<string, unknown>;
    } catch {
      return;
    }

    if (msg.type === "audio" && typeof msg.data === "string") {
      send(openaiWs, { type: "input_audio_buffer.append", audio: msg.data });
    } else if (msg.type === "playback_ended") {
      // Browser has drained its scheduled AI audio queue — only now is
      // the caller truly hearing silence. Clear the in-flight flag so
      // the next speech_started can trigger barge-in if appropriate.
      aiAudioInFlight = false;
      if (aiPlaybackFallbackTimer) {
        clearTimeout(aiPlaybackFallbackTimer);
        aiPlaybackFallbackTimer = null;
      }
      // If we're waiting to close the call after the goodbye finished
      // playing, NOW is the safe moment — the caller has actually heard
      // the full advice + farewell, not a chopped-off version.
      if (endingCallAwaitingPlayback) {
        endingCallAwaitingPlayback = false;
        if (endCallFallbackTimer) {
          clearTimeout(endCallFallbackTimer);
          endCallFallbackTimer = null;
        }
        setTimeout(() => {
          if (browserWs.readyState === WebSocket.OPEN) {
            logger.info(
              "[Browser Voice] closing after browser playback_ended (graceful)",
            );
            browserWs.close();
          }
        }, 600);
      }
    } else if (msg.type === "stop") {
      if (endReason === "unknown") endReason = "user_hangup";
      if (!callEnded) {
        callEnded = true;
        const durationSec = Math.round((Date.now() - sessionStartMs) / 1000);
        void endBrowserCall(transcript, phone, durationSec, endReason);
      }
      openaiWs.close();
    }
  });

  browserWs.on("close", () => {
    logger.info({ phone, endReason }, "Browser WS closed");
    clearTimeout(hardCapTimer);
    clearTimeout(softWrapTimer);
    clearNoSpeechTimer();
    if (endCallFallbackTimer) {
      clearTimeout(endCallFallbackTimer);
      endCallFallbackTimer = null;
    }
    if (aiPlaybackFallbackTimer) {
      clearTimeout(aiPlaybackFallbackTimer);
      aiPlaybackFallbackTimer = null;
    }
    if (isPublicSession) {
      registerPublicSessionClosed();
      const minutes = (Date.now() - sessionStartMs) / 60_000;
      // Settle the daily-budget reservation made at mint with the actual
      // call duration (freeing the unused portion back to the budget).
      // Idempotent — safe even if the close handler fires twice.
      settleTokenReservation(token, minutes, phone);
    }
    if (!callEnded) {
      callEnded = true;
      const durationSec = Math.round((Date.now() - sessionStartMs) / 1000);
      void endBrowserCall(transcript, phone, durationSec, endReason);
    }
    if (openaiWs.readyState !== WebSocket.CLOSED) openaiWs.close();
  });

  browserWs.on("error", (err) => logger.error({ err }, "Browser WS error"));
}

async function endBrowserCall(
  transcript: TranscriptEntry[],
  phone: string | null = null,
  callDurationSeconds: number = 0,
  endReason: EndReason = "unknown",
): Promise<void> {
  // Grace period: let trailing realtime transcription events flush into the
  // shared transcript array (passed by reference) before we snapshot it.
  await new Promise((resolve) => setTimeout(resolve, 750));

  if (transcript.length === 0) {
    logger.warn("Browser call ended with no transcript");
    return;
  }
  try {
    const last = getLastResult();
    const userText = transcript
      .filter((t) => t.role === "user")
      .map((t) => t.text)
      .join(" ");
    const fullTranscript = transcript
      .map((t) => `${t.role === "user" ? "User" : "ArdaLink"}: ${t.text}`)
      .join("\n");
    const month =
      last?.month_name ??
      new Date().toLocaleString("en", { month: "short" }).toUpperCase();

    // Action tag + indicator extraction run in parallel — both depend only on transcript
    const [actionTag, indicators] = await Promise.all([
      last?.delta
        ? generateActionTag(userText, {
            aiQuestion: "(Browser WebRTC demo session)",
            month,
            delta: last.delta,
          })
        : Promise.resolve("Browser Demo"),
      extractIndicators(fullTranscript),
    ]);

    // Snapshot satellite + climate at moment of call
    const ndvi = last?.delta?.NDVI.live ?? null;
    const ndviPct = last?.delta?.NDVI.delta_pct ?? null;
    const cl30 = last?.climate?.rolling30Day;
    const rainfall = cl30?.totalPrecipMm ?? null;
    const et0 = cl30?.totalET0Mm ?? null;
    const soilMoisture = cl30?.meanSoilMoisture ?? null;
    const ratio =
      rainfall != null && et0 != null && et0 > 0 ? rainfall / et0 : null;

    const ind = indicators;
    const completenessPct = ind ? (ind.indicators_collected / 7) * 100 : null;

    // Trust score — server-derived, never trusted from the model.
    const wardAnomalyPct = last?.live?.anomaly?.NDVI?.p50 ?? null;
    const trust = computeTrustScore({
      indicators: ind,
      wardAnomalyPct,
      callDurationSeconds,
      endReason,
    });

    logTrustScore(phone, null, trust);
    logger.info(
      {
        actionTag,
        bcs: ind?.bcs_score,
        collected: ind?.indicators_collected,
        trustScore: trust.score,
        endReason,
      },
      "[Ground Truth Processed] Browser session indicators extracted",
    );
  } catch (err) {
    logger.error({ err }, "Failed to save browser ground truth");
  }
}
