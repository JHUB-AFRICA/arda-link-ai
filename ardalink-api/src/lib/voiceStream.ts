import WebSocket from "ws";
import { getCallSession, clearCallSession } from "./voice.js";
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
import { computeTrustScore, logTrustScore } from "./trustScore.js";
import { logger } from "./logger.js";
import type { VegetationDelta } from "./baseline.js";
import { droughtLabel, maiLabel } from "./climate.js";
import { isSpeechConfigured, textToSpeech } from "./speech.js";

// ── Azure OpenAI Realtime endpoint ─────────────────────────────────────────
// Works for both classic Azure OpenAI (*.openai.azure.com) and AI Foundry
// project resources (*.services.ai.azure.com) — both host the /openai/realtime
// path. Set AZURE_OPENAI_ENDPOINT to the RESOURCE ROOT (without /api/projects/*).
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

// ── System prompt builder ───────────────────────────────────────────────────
async function buildSystemPrompt(
  session: ReturnType<typeof getCallSession> & {},
  phone: string,
): Promise<string> {
  if (!session) return "";
  const { delta, month, question, script, climate, forecast } = session;

  // Pull memory + dynamic blocks in parallel — herder-specific, ward-wide,
  // water-point usage stats from ground-truth, and satellite-detected open water.
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

  // ── Climate block ────────────────────────────────────────────────────────
  const climateBlock = climate
    ? `
CURRENT CLIMATE CONDITIONS — last 30 days (Open-Meteo ERA5):
- Temperature now: ${climate.current.temperatureC.toFixed(1)}°C  |  Humidity: ${climate.current.humidityPct.toFixed(0)}%
- 30-day rainfall: ${climate.rolling30Day.totalPrecipMm.toFixed(1)} mm over ${climate.rolling30Day.rainyDays} rainy days
- Reference ET₀: ${climate.rolling30Day.totalET0Mm.toFixed(0)} mm total (${climate.rolling30Day.meanET0Mm.toFixed(1)} mm/day mean)
- Topsoil moisture (0–1 cm): ${(climate.rolling30Day.meanSoilMoisture * 100).toFixed(1)}% volumetric
- Moisture Adequacy Index: ${climate.rolling30Day.moistureAdequacyIndex.toFixed(2)} — ${droughtLabel(climate.rolling30Day.droughtSeverity)} (${maiLabel(climate.rolling30Day.moistureAdequacyIndex)})
Use these numbers naturally if the herder mentions water, heat, or grazing — do NOT recite them all.`
    : "";

  // ── Forecast block ───────────────────────────────────────────────────────
  const forecastBlock = forecast
    ? `
14-DAY VEGETATION FORECAST (risk: ${forecast.outlook.riskLevel.toUpperCase()}, ${forecast.outlook.confidence} confidence):
- Weather outlook: ${forecast.forecast14d.totalPrecipMm.toFixed(0)}mm rain / ${forecast.forecast14d.totalET0Mm.toFixed(0)}mm evaporation expected (${forecast.forecast14d.rainyDays} rainy days)
- Effective rain reaching roots: ${forecast.forecast14d.effectiveRainMm.toFixed(0)}mm
- Forecast MAI: ${forecast.forecast14d.forecastMAI.toFixed(2)} — stress direction: ${forecast.outlook.stressDirection.toUpperCase()}
- Seasonal outlook: ${forecast.seasonal.trend === "improving" ? `NDVI historically rises ${forecast.seasonal.trendPct.toFixed(0)}% in coming weeks — rainy season onset expected` : forecast.seasonal.trend === "declining" ? `NDVI historically falls ${Math.abs(forecast.seasonal.trendPct).toFixed(0)}% — dry season deepening` : "Seasonal pattern stable"}
- Recovery estimate: ${forecast.outlook.estimatedRecoveryDays != null ? `~${forecast.outlook.estimatedRecoveryDays} days to recovery if forecast holds` : "No recovery expected this season without exceptional rain"}
- Recommendation: ${forecast.outlook.recommendation}
You MAY share the recovery estimate and recommendation if the herder asks about the future or what to do next. Keep it hopeful but honest.`
    : "";

  return `You are ArdaLink, a respected veteran range management expert in Isiolo, Kenya. You have 30 years working with Borana pastoralists. Your tone is wise, empathetic, and deeply localized.

LANGUAGE POLICY (critical):
- This is a phone call to a real pastoralist in Bula Pesa. Default to Kiswahili with natural Borana mixed in.
- Always mirror the language of the herder's MOST RECENT utterance. If they answer in English, switch on the very next reply and stay there. Mirror code-switching mid-sentence. Never comment on the language switch — just do it.

GEOGRAPHY (critical):
- Bula Pesa Ward has four named sub-areas. Use the REAL NAMES, never compass codes like "NW/SE":
  • Wabera (northwest pastures)
  • Ngare Mara (northeast highlands)
  • Bulla Pesa town (southwest — town centre, boreholes)
  • Kambi Garba (southeast dryland)
- The satellite numbers above are WARD-LEVEL ONLY (no per-area breakdown on this call). So:
  • Prefer naming a real place when talking about geography, but never invent a number for a specific place — speak about the ward as a whole, or qualitatively about a place ("inaonekana kavu zaidi upande wa Kambi Garba" without quoting a percentage).
  • If the herder names a place outside the four, acknowledge it, say you don't have direct coverage of that exact spot, and steer back to the ward-level numbers you do have.

${formatLandmarksBlock()}

${formatProximityBlock()}

${formatWaterPointsBlock()}

${waterBodies}

EXPECT ANYTHING (critical — this is a live phone line, not a script):
- The caller can say literally anything: personal questions ("are you a real person?", "wewe ni nani hasa?"), tangents (politics, religion, prices, family, jokes, football, weather small-talk), tests, complaints, prayers, silence, or completely unrelated questions (recipes, news, market rates, advice about non-livestock things). You handle ALL of it gracefully. Never refuse, never say "I can only talk about X", never act confused.
- Answer briefly and warmly first (one or two sentences in their language), then — only if it feels natural — bridge back to what you actually know about (their animals, pasture, satellite picture, forecast, water). Do NOT force the bridge if it would feel rude or robotic.
- If asked "are you a person?" or "are you AI?" — be honest in one sentence: "Mimi ni msaidizi wa kidigitali wa ArdaLink — nakusaidia kwa data ya satellite. Lakini tunaongea kama watu." Then continue normally.
- If asked something you genuinely don't know (today's market price, a news event, religious ruling, somebody's number), say so honestly in one line ("hiyo sina hakika nayo leo") and offer what you DO know that's adjacent. Never invent.
- If the caller jokes or teases, laugh with them briefly — warmth beats stiffness. Then continue.

Keep each response under 25 seconds of speech AND ask at most ONE question per turn. After your question, stop and listen — don't stack a second question on top.

CURRENT SATELLITE ALERT — ${month}:
- NDVI (rangeland greenness): ${delta.NDVI.live.toFixed(3)} vs ${delta.NDVI.baseline.toFixed(3)} baseline (${delta.NDVI.delta_pct > 0 ? "+" : ""}${delta.NDVI.delta_pct.toFixed(1)}%)
- NDRE (chlorophyll/leaf health): ${delta.NDRE.live.toFixed(3)} vs ${delta.NDRE.baseline.toFixed(3)} baseline (${delta.NDRE.delta_pct > 0 ? "+" : ""}${delta.NDRE.delta_pct.toFixed(1)}%)
- Red Edge (early stress): ${delta.RED_EDGE.live.toFixed(3)} vs ${delta.RED_EDGE.baseline.toFixed(3)} baseline (${delta.RED_EDGE.delta_pct > 0 ? "+" : ""}${delta.RED_EDGE.delta_pct.toFixed(1)}%)
- Trigger reason: ${delta.trigger_reason}
${climateBlock}
${forecastBlock}

${memoryBlock ? memoryBlock + "\n\n" : ""}${indicatorCollectionBlock()}

YOUR OPENING (adapt naturally, but follow the FLOW order above — do NOT jump to BCS or assume location/species):
${script}

After greeting, FIRST ask where they are today (do not assume a place), THEN ask what species they have (do not assume cows), THEN share the satellite picture for their actual area and ask the BCS question anchored to their actual species. Only AFTER BCS is answered, move on to secondary indicators.

Suggested secondary follow-up (use ONLY after BCS is collected, and only if relevant to what they've said): ${question}

Collect 2–3 secondary indicators total (offtake, mortality, milk, trekking, water point status, supplementary feeding) based on what is most relevant to what they're telling you and the current satellite stress. If they say they didn't visit a water point — accept it, log it as unknown, move on. Thank them genuinely. Whole call ≤ 3–4 minutes.`;
}

// ── Africa's Talking WebSocket message types ────────────────────────────────
interface AtMediaEvent {
  event: "media";
  streamSid?: string;
  media: { track?: string; payload: string; chunk?: string };
}
interface AtStartEvent {
  event: "start";
  start: { streamSid: string; callSid: string };
}
interface AtStopEvent {
  event: "stop";
  stop: { streamSid: string; callSid: string };
}
interface AtMarkEvent {
  event: "mark";
  mark: { name: string };
}
type AtEvent = AtMediaEvent | AtStartEvent | AtStopEvent | AtMarkEvent;

// ── Transcript entry ────────────────────────────────────────────────────────
interface TranscriptEntry {
  role: "user" | "assistant";
  text: string;
}

// ── Main bridge handler ─────────────────────────────────────────────────────
export function handleVoiceStream(atWs: WebSocket, phone: string): void {
  const session = getCallSession(phone);
  const transcript: TranscriptEntry[] = [];
  let streamSid: string | null = null;
  let openaiWs: WebSocket | null = null;
  let callEnded = false;
  let endCallScheduled = false; // latch: only honour the first end_call tool invocation
  let endCallFallbackTimer: NodeJS.Timeout | null = null;
  let waitingForFinalAudioDone = false; // close on next response.audio.done after end_call
  // Server-side gate: reject end_call invocations that fire before the model
  // has actually collected the caller's situation or delivered anchored
  // advice. Below the threshold, we send a function_call_output saying what
  // is missing and force the model to continue the conversation.
  const sessionStartMs = Date.now();
  const MIN_CALL_DURATION_MS = 75_000;
  const MIN_CALLER_TURNS = 3;
  let callerTurnCount = 0;
  let aiAudioInFlight = false;
  let activeAzureResponseId: string | null = null;
  // After a barge-in we send response.cancel to Azure, but audio deltas
  // already in flight can still arrive over the WS for a few hundred ms
  // and would leak back to the caller after they've been "interrupted".
  // Drop deltas until the cancelled response officially terminates.
  let suppressAudioUntilResponseDone = false;

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

  const closeAtSocket = (cause: string): void => {
    if (endCallFallbackTimer) {
      clearTimeout(endCallFallbackTimer);
      endCallFallbackTimer = null;
    }
    if (atWs.readyState === WebSocket.OPEN) {
      logger.info({ phone, cause }, "[Voice] closing AT WS after end_call");
      atWs.close();
    }
  };

  logger.info({ phone, hasSession: !!session }, "Voice stream opened");

  // Tracks whether the Realtime WS ever successfully opened. If it errors
  // out or closes before `open`, we fall back to TTS-only playback so the
  // caller at least hears the pre-generated Swahili opening instead of
  // silence. Fallback path is best-effort; a proper stitched STT+LLM+TTS
  // duplex is a Phase-2 delivery.
  let realtimeOpened = false;
  let fallbackTriggered = false;

  const tryTtsFallback = async (cause: string): Promise<void> => {
    if (fallbackTriggered || callEnded) return;
    fallbackTriggered = true;
    if (!isSpeechConfigured()) {
      logger.warn(
        { phone, cause },
        "[Voice] Realtime failed and Azure Speech not configured — call will be silent",
      );
      closeAtSocket("realtime-failed-no-fallback");
      return;
    }
    // Wait briefly for AT `start` if we don't have streamSid yet — the
    // stream event lands within a few hundred ms of the WS open.
    const waitStart = Date.now();
    while (!streamSid && Date.now() - waitStart < 4000) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!streamSid || atWs.readyState !== WebSocket.OPEN) {
      closeAtSocket("realtime-failed-no-streamsid");
      return;
    }
    const spoken =
      session?.script ??
      "Habari yako. Mimi ni ArdaLink. Samahani, kuna hitilafu ya kiufundi — tutakupigia tena hivi karibuni. Asante.";
    logger.info(
      { phone, cause, chars: spoken.length },
      "[Voice] Playing TTS fallback to caller",
    );
    try {
      const { audio } = await textToSpeech(spoken, {
        lang: "sw",
        format: "raw-8khz-8bit-mono-mulaw",
      });
      // Africa's Talking media frames: 20 ms of 8 kHz mulaw = 160 bytes.
      const FRAME_BYTES = 160;
      for (let i = 0; i < audio.length; i += FRAME_BYTES) {
        if (atWs.readyState !== WebSocket.OPEN) break;
        const frame = audio.subarray(i, i + FRAME_BYTES);
        atWs.send(
          JSON.stringify({
            event: "media",
            streamSid,
            media: { payload: frame.toString("base64") },
          }),
        );
        // 20 ms pacing keeps the mulaw stream real-time on AT's side.
        await new Promise((r) => setTimeout(r, 20));
      }
    } catch (err) {
      logger.error({ err, phone }, "[Voice] TTS fallback failed");
    } finally {
      setTimeout(() => closeAtSocket("tts-fallback-complete"), 400);
    }
  };

  // ── Connect to Azure OpenAI Realtime ──────────────────────────────────────
  openaiWs = new WebSocket(realtimeUrl(), {
    headers: { "api-key": process.env.AZURE_OPENAI_API_KEY! },
  });

  openaiWs.on("open", async () => {
    realtimeOpened = true;
    logger.info({ phone }, "OpenAI Realtime connected");

    const instructions = session
      ? await buildSystemPrompt(session, phone)
      : `You are ArdaLink, a range management expert in Isiolo, Kenya.

LANGUAGE POLICY: Default to Kiswahili with natural Borana. Switch to English instantly if the herder answers in English (the Realtime API supplies a language tag per turn — trust it). Never comment on the switch.

GEOGRAPHY: Bula Pesa Ward sub-areas — Wabera (NW pastures), Ngare Mara (NE highlands), Bulla Pesa town (SW, boreholes), Kambi Garba (SE dryland). Always speak in real place names, never compass codes.

Greet the herder warmly and ask about the current state of their rangeland and livestock — anchor any geography to a real place name.`;

    // Configure the Realtime session
    // g711_ulaw = mulaw — this is what Africa's Talking streams natively.
    // No audio conversion needed — just relay base64 bytes end-to-end.
    openaiWs!.send(
      JSON.stringify({
        type: "session.update",
        session: {
          modalities: ["text", "audio"],
          instructions,
          voice: "alloy",
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          input_audio_transcription: { model: "whisper-1" },
          turn_detection: {
            type: "server_vad",
            // 0.4 = catches soft / near-whisper speech. Whisper-1
            // transcription acts as the second filter — sub-4-char
            // garbage from wind/goats/motorbikes is ignored downstream.
            threshold: 0.4,
            prefix_padding_ms: 300,
            silence_duration_ms: 500,
          },
          tools: [
            {
              type: "function",
              name: "end_call",
              description:
                "Gracefully hang up the line. Invoke this IMMEDIATELY after speaking a natural goodbye (e.g. 'Asante, kwaheri'). Do not invoke before delivering advice. Do not invoke twice.",
              parameters: {
                type: "object",
                properties: {
                  reason: {
                    type: "string",
                    description:
                      "One short sentence on why the call is ending (e.g. 'indicators collected and advice delivered', 'herder needed to go', 'line too noisy').",
                  },
                },
                required: ["reason"],
              },
            },
          ],
          tool_choice: "auto",
        },
      }),
    );
    // NOTE: response.create is sent only after we receive `session.updated`
    // below (see message handler). Sending it eagerly here races the session
    // config and Azure can return a text-only response with zero audio deltas
    // — the AI appears silent on the herder's phone. Same fix as the browser
    // bridge.
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
      // ── Session configured → safe to request the opening greeting ─────────
      case "session.updated": {
        logger.info(
          { phone },
          "Azure Realtime session.updated — requesting opening greeting",
        );
        openaiWs!.send(
          JSON.stringify({
            type: "response.create",
            response: { modalities: ["audio", "text"] },
          }),
        );
        break;
      }

      // ── Audio chunk from OpenAI → send to AT ──────────────────────────────
      case "response.audio.delta": {
        if (suppressAudioUntilResponseDone) break;
        const delta = event["delta"] as string | undefined;
        if (delta && streamSid && atWs.readyState === WebSocket.OPEN) {
          aiAudioInFlight = true;
          atWs.send(
            JSON.stringify({
              event: "media",
              streamSid,
              media: { payload: delta },
            }),
          );
        }
        break;
      }

      // ── AI finished its audio turn → clear the in-flight flag ─────────────
      case "response.audio.done": {
        aiAudioInFlight = false;
        if (waitingForFinalAudioDone) {
          waitingForFinalAudioDone = false;
          // Tiny tail buffer so AT can flush the last mulaw frame.
          setTimeout(() => closeAtSocket("audio-done"), 400);
        }
        break;
      }

      // ── Cancelled or completed response → release suppression + reset ─────
      case "response.done": {
        aiAudioInFlight = false;
        activeAzureResponseId = null;
        suppressAudioUntilResponseDone = false;
        break;
      }

      // ── New response starting → clear any leftover suppression ────────────
      case "response.created": {
        const respId =
          (event["response"] as { id?: string } | undefined)?.id ?? null;
        activeAzureResponseId = respId;
        // Never gag a fresh response with leftover suppression from a
        // previous cancel. Without this, a race where the cancel arrives
        // after Azure has already moved on leaves the AI permanently mute.
        suppressAudioUntilResponseDone = false;
        break;
      }

      // ── Caller started speaking → barge-in: cancel AI response if any ─────
      case "input_audio_buffer.speech_started": {
        if (aiAudioInFlight && openaiWs?.readyState === WebSocket.OPEN) {
          // Only suppress + cancel when Azure actually has a live response.
          // Otherwise response.cancel goes into a void, no response.done
          // ever fires, and suppressAudioUntilResponseDone stays true →
          // AI is mute for the rest of the call.
          if (activeAzureResponseId) {
            logger.info(
              { phone, responseId: activeAzureResponseId },
              "[Voice] barge-in — cancelling AI response",
            );
            openaiWs.send(JSON.stringify({ type: "response.cancel" }));
            suppressAudioUntilResponseDone = true;
          } else {
            logger.info(
              { phone },
              "[Voice] barge-in with no live response — flushing AT buffer only",
            );
          }
          // Tell AT to clear its outbound media buffer so the caller hears
          // their own voice immediately instead of the queued AI tail.
          if (streamSid && atWs.readyState === WebSocket.OPEN) {
            atWs.send(JSON.stringify({ event: "clear", streamSid }));
          }
          aiAudioInFlight = false;
        }
        break;
      }

      // ── Herder speech transcribed ──────────────────────────────────────────
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
              "[Voice] sub-substantive transcript — not counted as caller turn",
            );
          }
          logger.info({ phone, text: trimmed }, "Herder said");
        }
        break;
      }

      // ── AI invoked end_call tool → schedule graceful hangup ────────────────
      case "response.function_call_arguments.done": {
        const name = event["name"] as string | undefined;
        const callId = event["call_id"] as string | undefined;
        const argsRaw = event["arguments"] as string | undefined;
        if (name !== "end_call") break;
        if (endCallScheduled) {
          logger.info(
            { phone },
            "[Voice] end_call invoked again — ignoring (latch)",
          );
          break;
        }
        const elapsedMs = Date.now() - sessionStartMs;
        const gateOpen =
          elapsedMs >= MIN_CALL_DURATION_MS &&
          callerTurnCount >= MIN_CALLER_TURNS;
        if (!gateOpen) {
          logger.warn(
            {
              phone,
              elapsedMs,
              callerTurnCount,
              minMs: MIN_CALL_DURATION_MS,
              minTurns: MIN_CALLER_TURNS,
            },
            "[Voice] end_call rejected — gate not yet open",
          );
          if (callId && openaiWs?.readyState === WebSocket.OPEN) {
            openaiWs.send(
              JSON.stringify({
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
                      " caller turn(s). You have not yet collected enough about the herder's situation OR delivered specific advice anchored to: (1) the satellite reading for the area they named, (2) the species they have today (cattle/goats/sheep/camels), (3) their BCS score. Do NOT call end_call again until you have done all three. Continue now: ask whichever of those three you are missing, then deliver ONE concrete recommendation that uses all three. Only after the herder has heard that advice and you have done the wind-down may you call end_call.",
                  }),
                },
              }),
            );
            openaiWs.send(
              JSON.stringify({
                type: "response.create",
                response: { modalities: ["audio", "text"] },
              }),
            );
          }
          break;
        }
        endCallScheduled = true;
        let reason = "unspecified";
        try {
          const parsed = argsRaw
            ? (JSON.parse(argsRaw) as { reason?: string })
            : {};
          if (parsed.reason) reason = parsed.reason;
        } catch {
          // ignore — reason stays "unspecified"
        }
        logger.info(
          { phone, reason, elapsedMs, callerTurnCount },
          "[Voice] AI invoked end_call",
        );
        if (callId && openaiWs?.readyState === WebSocket.OPEN) {
          openaiWs.send(
            JSON.stringify({
              type: "conversation.item.create",
              item: {
                type: "function_call_output",
                call_id: callId,
                output: JSON.stringify({ ok: true }),
              },
            }),
          );
        }
        // Audio-aware close: wait for the NEXT response.audio.done event
        // (i.e. the goodbye's final audio chunk has been emitted) and close
        // immediately after. If no audio.done arrives in 5s (e.g. model
        // emitted end_call before/without a spoken goodbye), close anyway.
        waitingForFinalAudioDone = true;
        endCallFallbackTimer = setTimeout(
          () => closeAtSocket("fallback-timeout"),
          5000,
        );
        break;
      }

      // ── AI text output (for transcript storage) ────────────────────────────
      case "response.output_item.done": {
        const item = event["item"] as Record<string, unknown> | undefined;
        const content = item?.["content"] as
          | Array<Record<string, unknown>>
          | undefined;
        const textPart = content?.find((c) => c["type"] === "text");
        const text = textPart?.["text"] as string | undefined;
        if (text?.trim()) {
          transcript.push({ role: "assistant", text: text.trim() });
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
          errObj && "message" in errObj ? String(errObj["message"]) : "";
        const isBenignCancel =
          errCode === "response_cancel_not_active" ||
          /cancellation failed.*no active response/i.test(errMsgRaw);
        if (isBenignCancel) {
          logger.info(
            { phone, code: errCode },
            "[Voice] benign cancel race — ignoring",
          );
          break;
        }
        logger.error({ phone, event }, "OpenAI Realtime error");
        break;
      }

      default:
        break;
    }
  });

  openaiWs.on("close", () => {
    logger.info({ phone, realtimeOpened }, "OpenAI Realtime WS closed");
    if (!realtimeOpened) void tryTtsFallback("realtime-closed-before-open");
  });
  openaiWs.on("error", (err) => {
    logger.error({ err, phone, realtimeOpened }, "OpenAI Realtime WS error");
    if (!realtimeOpened) void tryTtsFallback("realtime-error-before-open");
  });

  // ── Handle Africa's Talking WebSocket events ──────────────────────────────
  atWs.on("message", (raw) => {
    let msg: AtEvent;
    try {
      msg = JSON.parse(raw.toString()) as AtEvent;
    } catch {
      return;
    }

    switch (msg.event) {
      case "start":
        streamSid = msg.start.streamSid;
        logger.info({ phone, streamSid }, "AT stream started");
        break;

      case "media":
        // Inbound audio from herder → OpenAI Realtime
        if (msg.media?.payload && openaiWs?.readyState === WebSocket.OPEN) {
          openaiWs.send(
            JSON.stringify({
              type: "input_audio_buffer.append",
              audio: msg.media.payload,
            }),
          );
        }
        break;

      case "stop":
        logger.info({ phone }, "AT stream stopped");
        if (!callEnded) {
          callEnded = true;
          void endCall(phone, session, transcript);
        }
        break;

      default:
        break;
    }
  });

  atWs.on("close", () => {
    logger.info({ phone }, "AT WebSocket closed");
    if (!callEnded) {
      callEnded = true;
      void endCall(phone, session, transcript);
    }
    openaiWs?.close();
  });

  atWs.on("error", (err) => logger.error({ err, phone }, "AT WebSocket error"));
}

// ── Post-call: generate action tag + save to PostgreSQL ────────────────────
async function endCall(
  phone: string,
  session: ReturnType<typeof getCallSession>,
  transcript: TranscriptEntry[],
): Promise<void> {
  // Grace period: let trailing realtime transcription events flush into the
  // shared transcript array (passed by reference) before we snapshot it.
  await new Promise((resolve) => setTimeout(resolve, 750));

  if (transcript.length === 0) {
    logger.warn({ phone }, "Call ended with no transcript — nothing to save");
    clearCallSession(phone);
    return;
  }

  try {
    const userText = transcript
      .filter((t) => t.role === "user")
      .map((t) => t.text)
      .join(" ");

    const fullTranscript = transcript
      .map((t) => `${t.role === "user" ? "Herder" : "ArdaLink"}: ${t.text}`)
      .join("\n");

    const month =
      session?.month ??
      new Date().toLocaleString("en", { month: "short" }).toUpperCase();

    // Action tag + indicator extraction run in parallel
    const [actionTag, indicators] = await Promise.all([
      session?.delta
        ? generateActionTag(userText, {
            aiQuestion: session.question,
            month,
            delta: session.delta,
          })
        : Promise.resolve("Conversation Complete"),
      extractIndicators(fullTranscript),
    ]);

    // Snapshot satellite + climate at moment of call
    const ndvi = session?.delta?.NDVI.live ?? null;
    const ndviPct = session?.delta?.NDVI.delta_pct ?? null;
    const cl30 = session?.climate?.rolling30Day;
    const rainfall = cl30?.totalPrecipMm ?? null;
    const et0 = cl30?.totalET0Mm ?? null;
    const soilMoisture = cl30?.meanSoilMoisture ?? null;
    const ratio =
      rainfall != null && et0 != null && et0 > 0 ? rainfall / et0 : null;

    const ind = indicators;
    const completenessPct = ind ? (ind.indicators_collected / 7) * 100 : null;

    // Trust score — same algorithm as the browser path. AT call path does not
    // currently track end_reason or speech-onset timing, so it passes null for
    // duration (skips duration-based penalties) and "unknown" end reason.
    const wardAnomalyPct = session?.delta?.NDVI?.delta_pct ?? null;
    const trust = computeTrustScore({
      indicators: ind,
      wardAnomalyPct,
      callDurationSeconds: null,
      endReason: "unknown",
    });

    logTrustScore(phone || null, null, trust);
    logger.info(
      {
        actionTag,
        phone,
        bcs: ind?.bcs_score,
        collected: ind?.indicators_collected,
        trustScore: trust.score,
      },
      "[Ground Truth Processed] Realtime conversation indicators extracted",
    );
  } catch (err) {
    logger.error({ err, phone }, "Failed to save ground truth");
  } finally {
    clearCallSession(phone);
  }
}
