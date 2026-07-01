/**
 * Intelligence Core — Channel-agnostic AI orchestration.
 *
 * This module provides unified AI interaction logic that works across
 * USSD, SMS, and Voice channels without being coupled to any specific
 * provider (Africa's Talking, etc.).
 *
 * Flow:
 * 1. parseInput() → Normalize channel-specific input to { channel, phone, intent, context }
 * 2. loadIntelligenceContext() → Load satellite + climate + forecast data
 * 3. buildAiPrompt() → Build unified prompt for LLM
 * 4. generateResponse() → Call LLM via registry
 * 5. formatOutput() → Return channel-specific formatted response
 *
 * All channels share the same AI logic and data sources, ensuring
 * consistent herder experience regardless of access method.
 */

import { getLastResult, type IntelligenceResult } from "../intelligence.js";
import { type ClimateSnapshot } from "../climate.js";
import { type VegetationForecast } from "../predict.js";
import { type LiveVegetation } from "../satellite.js";
import { complete, type LlmResponse } from "../llm/index.js";
import { logger } from "../logger.js";

// ── Public Types ─────────────────────────────────────────────────────────────

export type Channel = "ussd" | "sms" | "voice" | "web";

export interface ParsedInput {
  channel: Channel;
  phone: string;
  intent: Intent;
  rawInput: string;
  context?: Record<string, unknown>;
}

export type Intent =
  | "home"
  | "brief"
  | "water_points"
  | "request_call"
  | "call_now"
  | "call_tomorrow"
  | "swahili_brief"
  | "english_brief"
  | "opt_out"
  | "unknown"
  | "conversation_response"; // For voice: herder responding to AI question

export interface IntelligenceContext {
  /** Last intelligence cycle result (satellite + climate + forecast) */
  lastResult: IntelligenceResult | null;
  /** Satellite vegetation data */
  satellite: {
    vci: number | null;
    vciDroughtClass: string | null;
    ndviAnomalyPct: number | null;
    stressedPixelPct: number | null;
    worstQuadrant: string | null;
    imageFreshness: string | null;
  } | null;
  /** Climate snapshot */
  climate: {
    tempC: number | null;
    totalPrecip30dMm: number | null;
    moistureAdequacyIndex: number | null;
    droughtSeverity: string | null;
  } | null;
  /** 14-day forecast */
  forecast: {
    totalPrecip14dMm: number | null;
    riskLevel: string | null;
    stressDirection: string | null;
    recommendation: string | null;
  } | null;
}

export interface AiResponse {
  text: string; // Main response text
  question?: string; // Follow-up question (for voice/conversation)
  data?: Record<string, unknown>; // Structured data for complex responses
  ended: boolean; // true if session should end
  language: "sw" | "en" | "both"; // Response language
}

export interface ChannelFormatter {
  formatBrief(context: IntelligenceContext, lang: "sw" | "en"): string;
  formatWaterPoints(): string;
  formatCallConfirmation(when: "now" | "tomorrow"): string;
  formatOptOut(): string;
  formatUnknown(): string;
}

// ── Input Parsers ───────────────────────────────────────────────────────────────

/**
 * Parse USSD input text.
 * USSD input is accumulated: "" → "1" → "1*2" → "1*2*0"
 */
export function parseUssdInput(phone: string, text: string): ParsedInput {
  const parts = text.split("*").filter((s) => s.length > 0);
  const level = parts.length;
  const last = parts.length > 0 ? parts[parts.length - 1] : "";

  let intent: Intent = "home";
  let context: Record<string, unknown> | undefined;

  if (level === 0) {
    intent = "home";
  } else if (level === 1) {
    switch (last) {
      case "1":
        intent = "brief";
        break;
      case "2":
        intent = "water_points";
        break;
      case "3":
        intent = "request_call";
        break;
      case "4":
        intent = "opt_out";
        break;
      case "0":
        intent = "home";
        break;
      default:
        intent = "unknown";
    }
  } else if (level === 2) {
    const top = parts[0] ?? "";
    if (top === "1") {
      // Brief submenu
      if (last === "1") intent = "swahili_brief";
      else if (last === "2") intent = "english_brief";
      else if (last === "0") intent = "home";
      else intent = "unknown";
    } else if (top === "3") {
      // Call submenu
      if (last === "1") intent = "call_now";
      else if (last === "2") intent = "call_tomorrow";
      else if (last === "0") intent = "home";
      else intent = "unknown";
    } else if (last === "0") {
      intent = "home";
    } else {
      intent = "unknown";
    }
  } else {
    intent = "unknown";
  }

  return {
    channel: "ussd",
    phone,
    intent,
    rawInput: text,
    context: { level, last, top: parts[0] },
  };
}

/**
 * Parse SMS input text.
 * SMS keywords are case-insensitive first word.
 */
export function parseSmsInput(phone: string, text: string): ParsedInput {
  const keyword = text.trim().toUpperCase().split(/\s+/)[0] ?? "";

  let intent: Intent = "unknown";
  switch (keyword) {
    case "BULA":
      intent = "swahili_brief"; // Default to Swahili for brief
      break;
    case "MALISHO":
      intent = "water_points";
      break;
    case "ONGEA":
    case "AI":
      intent = "call_now";
      break;
    case "STOP":
    case "SITAKI":
    case "UNDO":
      intent = "opt_out";
      break;
    default:
      intent = "unknown";
  }

  return {
    channel: "sms",
    phone,
    intent,
    rawInput: text,
    context: { keyword },
  };
}

/**
 * Parse voice/conversation input.
 * For voice, the input is the herder's transcript response.
 */
export function parseVoiceInput(phone: string, transcript: string): ParsedInput {
  return {
    channel: "voice",
    phone,
    intent: "conversation_response",
    rawInput: transcript,
    context: { transcript },
  };
}

/**
 * Parse web demo input.
 * Web demo can simulate any channel.
 */
export function parseWebInput(
  phone: string,
  data: { channel?: Channel; intent?: Intent; text?: string },
): ParsedInput {
  const channel = data.channel ?? "web";
  const intent = data.intent ?? "home";

  if (channel === "ussd") return parseUssdInput(phone, data.text ?? "");
  if (channel === "sms") return parseSmsInput(phone, data.text ?? "");

  return {
    channel,
    phone,
    intent,
    rawInput: data.text ?? "",
    context: { ...data },
  };
}

// ── Intelligence Context Loader ────────────────────────────────────────────────

/**
 * Load intelligence context from the last intelligence cycle.
 * Transforms the full IntelligenceResult into a compact format
 * suitable for AI prompts and channel formatting.
 */
export function loadIntelligenceContext(): IntelligenceContext {
  const last = getLastResult();

  if (!last) {
    return {
      lastResult: null,
      satellite: null,
      climate: null,
      forecast: null,
    };
  }

  // Extract VCI data if available
  const vci = last.vci;
  const satellite = vci
    ? {
        vci: vci.vci,
        vciDroughtClass: vciToDroughtClass(vci.vci),
        ndviAnomalyPct: last.live?.anomaly?.NDVI?.p50 ?? null,
        stressedPixelPct: last.live?.anomaly?.wardStressedPixelPct ?? null,
        worstQuadrant: last.live?.anomaly?.worstQuadrant ?? null,
        imageFreshness: formatImageFreshness(vci.captured_at),
      }
    : last.live?.anomaly
      ? {
          vci: null,
          vciDroughtClass: null,
          ndviAnomalyPct: last.live.anomaly.NDVI.p50 ?? null,
          stressedPixelPct: last.live.anomaly.wardStressedPixelPct ?? null,
          worstQuadrant: last.live.anomaly.worstQuadrant ?? null,
          imageFreshness: null,
        }
      : null;

  const climate = last.climate
    ? {
        tempC: last.climate.current.temperatureC,
        totalPrecip30dMm: last.climate.rolling30Day.totalPrecipMm,
        moistureAdequacyIndex: last.climate.rolling30Day.moistureAdequacyIndex,
        droughtSeverity: last.climate.rolling30Day.droughtSeverity,
      }
    : null;

  const forecast = last.forecast
    ? {
        totalPrecip14dMm: last.forecast.forecast14d.totalPrecipMm,
        riskLevel: last.forecast.outlook.riskLevel,
        stressDirection: last.forecast.outlook.stressDirection,
        recommendation: last.forecast.outlook.recommendation,
      }
    : null;

  return {
    lastResult: last,
    satellite,
    climate,
    forecast,
  };
}

function vciToDroughtClass(vci: number): string {
  if (vci < 10) return "extreme";
  if (vci < 20) return "severe";
  if (vci < 35) return "moderate";
  if (vci < 50) return "mild";
  return "none";
}

function formatImageFreshness(capturedAt: string): string {
  const captured = new Date(capturedAt);
  const now = new Date();
  const daysAgo = Math.floor((now.getTime() - captured.getTime()) / (1000 * 60 * 60 * 24));
  if (daysAgo === 0) return "today";
  if (daysAgo === 1) return "yesterday";
  if (daysAgo < 7) return `${daysAgo} days ago`;
  return captured.toISOString().split("T")[0] ?? capturedAt;
}

// ── AI Response Generation ─────────────────────────────────────────────────────

/**
 * Generate AI response for a given intent and context.
 * Uses the LLM registry for channel-agnostic text generation.
 */
export async function generateAiResponse(
  input: ParsedInput,
  intelContext: IntelligenceContext,
  previousQuestion?: string,
): Promise<AiResponse> {
  const { intent, channel } = input;

  // Handle simple intents directly (no LLM needed)
  switch (intent) {
    case "water_points": {
      return {
        text: formatWaterPoints(),
        ended: true,
        language: "both",
      };
    }
    case "opt_out": {
      return {
        text: "Umefungiwa. Utapata matangazo zaidi kama ukituma 'ONGEA'. / You've opted out. Send 'ONGEA' to re-enable.",
        ended: true,
        language: "both",
      };
    }
    case "home": {
      return {
        text: formatHomeMenu(channel),
        ended: false,
        language: "both",
      };
    }
    case "brief": {
      // Show language selection menu
      return {
        text: formatBriefMenu(),
        ended: false,
        language: "both",
      };
    }
    case "request_call": {
      return {
        text: formatCallMenu(),
        ended: false,
        language: "both",
      };
    }
  }

  // Handle brief intents
  if (intent === "swahili_brief" || intent === "english_brief") {
    const lang = intent === "swahili_brief" ? "sw" : "en";
    return {
      text: formatBrief(intelContext, lang),
      ended: true,
      language: lang,
    };
  }

  // Handle call intents
  if (intent === "call_now" || intent === "call_tomorrow") {
    const when = intent === "call_now" ? "now" : "tomorrow";
    return {
      text: formatCallConfirmation(when),
      question: "Tutakuwapigia simu hivi karibuni. / We'll call you shortly.",
      ended: true,
      language: "both",
    };
  }

  // Handle conversation response (voice channel)
  if (intent === "conversation_response" && channel === "voice") {
    return await generateConversationResponse(input, intelContext, previousQuestion);
  }

  // Unknown intent
  return {
    text: formatUnknown(channel),
    ended: true,
    language: "both",
  };
}

/**
 * Generate AI response for voice conversation.
 * This is where the full LLM pipeline is used.
 */
async function generateConversationResponse(
  input: ParsedInput,
  intelContext: IntelligenceContext,
  previousQuestion?: string,
): Promise<AiResponse> {
  const transcript = input.context?.transcript as string ?? "";

  if (!transcript.trim()) {
    return {
      text: "Samahani, sikuskilika vizuri. Unaweza kurudia? / Sorry, I didn't catch that. Can you repeat?",
      question: previousQuestion,
      ended: false,
      language: "both",
    };
  }

  // Build the LLM prompt for indicator extraction + response
  try {
    const response = await complete(
      "voice_script",
      {
        messages: [
          {
            role: "system",
            content: `You are ArdaLink, a rangeland expert speaking with a Borana pastoralist.
Respond naturally in Swahili/English mix. Keep responses under 2 short sentences.
Acknowledge what they said, then ask ONE relevant follow-up question about:
- Where they are grazing (location)
- What species they have (cattle, goats, sheep, camels)
- Body condition of their animals
- Water point status
End each response with a single question mark.`,
          },
          {
            role: "user",
            content: `Herder said: "${transcript}"

Previous question: ${previousQuestion ?? "First contact"}

Satellite context: ${formatSatelliteContext(intelContext)}

Respond in JSON: {"response": "<your acknowledgment + next question>", "question": "<specific follow-up question>", "shouldEnd": <boolean if we should wrap up>}`,
          },
        ],
        maxTokens: 300,
        temperature: 0.7,
      },
      { tenantId: undefined },
    );

    const parsed = parseConversationResponse(response.content ?? "");
    if (parsed) {
      logger.info(
        { provider: response.provider, cached: response.cached },
        "[IntelligenceCore] Voice conversation response generated",
      );
      return {
        text: parsed.response,
        question: parsed.question,
        ended: parsed.shouldEnd,
        language: "both",
      };
    }
  } catch (err) {
    logger.warn({ err }, "[IntelligenceCore] LLM conversation failed, using fallback");
  }

  // Fallback response
  return {
    text: "Asante kwa maelezo. / Thank you for the information.",
    question: "Je, unafuga mifugo aina gani? / What animals do you keep?",
    ended: false,
    language: "both",
  };
}

function formatSatelliteContext(ctx: IntelligenceContext): string {
  if (!ctx.satellite) return "No satellite data available";
  return `VCI: ${ctx.satellite.vci ?? "?"}/100 (${ctx.satellite.vciDroughtClass ?? "?"}), ${ctx.satellite.stressedPixelPct ?? "?"}% stressed`;
}

function parseConversationResponse(text: string): {
  response: string;
  question: string;
  shouldEnd: boolean;
} | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const obj = JSON.parse(match[0]) as Record<string, unknown>;
    const response = typeof obj["response"] === "string" ? obj["response"] : "";
    const question = typeof obj["question"] === "string" ? obj["question"] : "";
    const shouldEnd = typeof obj["shouldEnd"] === "boolean" ? obj["shouldEnd"] : false;
    if (!response) return null;
    return { response, question, shouldEnd };
  } catch {
    return null;
  }
}

// ── Channel Formatters ──────────────────────────────────────────────────────────

function formatHomeMenu(channel: Channel): string {
  if (channel === "ussd") {
    return `CON ArdaLink — Bula Pesa
1. Bula Pesa (drought brief)
2. Malisho (water points)
3. Ongea na AI (voice call)
4. Toka`;
  }
  if (channel === "sms") {
    return "ArdaLink: BULA (brief), MALISHO (water), ONGEA (call), STOP (opt-out)";
  }
  return "Welcome to ArdaLink. Choose: brief, water points, or request a call.";
}

function formatBriefMenu(): string {
  return `CON Bula Pesa brief:
1. Kwa Kiswahili (Swahili)
2. In English
0. Rudi / Back`;
}

function formatBrief(ctx: IntelligenceContext, lang: "sw" | "en"): string {
  const sat = ctx.satellite;
  const forecast = ctx.forecast;

  if (!sat) {
    return lang === "sw"
      ? "END Samahani, hatuna ripoti ya satellite leo. Tafadhali jaribu tena baadaye."
      : "END Sorry, no satellite reading available today. Please try again later.";
  }

  if (lang === "sw") {
    return `END Bula Pesa leo: VCI ${sat.vci?.toFixed(1) ?? "?"}/100 (${sat.vciDroughtClass ?? "?"}). ${sat.stressedPixelPct?.toFixed(0) ?? "?"}% ya eneo limeathirika. Hatari: ${forecast?.riskLevel ?? "?"}. Pata ripoti kamili: omba simu.`;
  }
  return `END Bula Pesa today: VCI ${sat.vci?.toFixed(1) ?? "?"}/100 (${sat.vciDroughtClass ?? "?"}). ${sat.stressedPixelPct?.toFixed(0) ?? "?"}% of ward is stressed. Risk: ${forecast?.riskLevel ?? "?"}. Call for full brief.`;
}

function formatWaterPoints(): string {
  const points = [
    { name: "Bulla Pesa Borehole", quadrant: "SW", distanceKm: 2 },
    { name: "Wabera Shallow Well", quadrant: "NW", distanceKm: 7 },
    { name: "Ngare Mara Spring", quadrant: "NE", distanceKm: 9 },
    { name: "Kambi Garba Dam", quadrant: "SE", distanceKm: 14 },
    { name: "Burat Pan", quadrant: "NW", distanceKm: 12 },
  ];
  const lines = points
    .slice(0, 5)
    .map((w, i) => `${i + 1}. ${w.name} (${w.quadrant}, ~${w.distanceKm}km)`)
    .join("\n");
  return `END Malisho / Water points:\n${lines}`;
}

function formatCallMenu(): string {
  return `CON Ongea na AI:
1. Sasa / Now
2. Kesho / Tomorrow
0. Rudi / Back`;
}

function formatCallConfirmation(when: "now" | "tomorrow"): string {
  if (when === "now") {
    return "END ArdaLink atapiga simu hivi karibuni. / ArdaLink will call you shortly.";
  }
  return "END ArdaLink atapiga simu kesho. / ArdaLink will call you tomorrow.";
}

function formatUnknown(channel: Channel): string {
  if (channel === "ussd") {
    return `END Chaguo batili. / Invalid choice.

${formatHomeMenu(channel)}`;
  }
  if (channel === "sms") {
    return "ArdaLink: jibu BULA (brief), MALISHO (water), ONGEA (call), au STOP (opt-out).";
  }
  return "Sorry, I didn't understand. Please try again.";
}

// ── Session Management ──────────────────────────────────────────────────────────

/**
 * In-memory session store for ongoing conversations.
 * Keyed by phone number, stores conversation state.
 */
interface ConversationSession {
  phone: string;
  channel: Channel;
  startedAt: Date;
  lastInteraction: Date;
  lastQuestion?: string;
  indicatorState: {
    bcsCollected: boolean;
    locationCollected: boolean;
    speciesCollected: boolean;
    waterCollected: boolean;
  };
}

const sessions = new Map<string, ConversationSession>();

export function getSession(phone: string): ConversationSession | undefined {
  return sessions.get(phone);
}

export function createSession(phone: string, channel: Channel): ConversationSession {
  const session: ConversationSession = {
    phone,
    channel,
    startedAt: new Date(),
    lastInteraction: new Date(),
    indicatorState: {
      bcsCollected: false,
      locationCollected: false,
      speciesCollected: false,
      waterCollected: false,
    },
  };
  sessions.set(phone, session);
  return session;
}

export function updateSession(
  phone: string,
  updates: Partial<ConversationSession>,
): void {
  const session = sessions.get(phone);
  if (session) {
    sessions.set(phone, { ...session, ...updates, lastInteraction: new Date() });
  }
}

export function endSession(phone: string): void {
  sessions.delete(phone);
}
