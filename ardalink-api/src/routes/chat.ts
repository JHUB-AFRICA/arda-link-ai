import { Router, type IRouter, type Request } from "express";
import { getLastResult } from "../lib/intelligence.js";
import { ChatWithLandBody } from "@workspace/api-zod";
import { logger } from "../lib/logger.js";
import { complete } from "../lib/llm/index.js";
import {
  checkAndRecordTalkChat,
  getTalkChatRemaining,
  TALK_CHAT_MAX_MSGS_PER_IP,
  TALK_CHAT_MAX_MESSAGE_LENGTH,
} from "../lib/chatLimits.js";
import { formatWaterPointsBlock } from "../lib/data/bulaPesaWaterPoints.js";
import { formatLandmarksBlock } from "../lib/data/bulaPesaLandmarks.js";
import { formatProximityBlock } from "../lib/data/proximity.js";
import { formatSatelliteWaterBodiesBlock } from "../lib/waterBodies.js";
import {
  formatHerderMemoryBlock,
  formatWardRollupBlock,
  formatWaterPointUsageBlock,
} from "../lib/memory.js";
import { droughtLabel, maiLabel } from "../lib/climate.js";

const QUAD_TO_PLACE: Record<"NW" | "NE" | "SW" | "SE", string> = {
  NW: "the pastures toward Wabera (northwest)",
  NE: "the highlands toward Ngare Mara (northeast)",
  SW: "around Bulla Pesa town and the southwest water points",
  SE: "the dryland toward Kambi Garba (southeast)",
};

/**
 * Build the rich, water-points + landmarks + memory-aware system prompt used
 * by the public /talk text chat. Mirrors what the voice bridge gets, minus
 * the voice-specific bits (wind-down, end_call tool, indicator collection).
 *
 * Pulls all dynamic blocks in parallel so we don't serialise their DB +
 * Earth Engine lookups on every chat message.
 */
async function buildTalkChatSystemPrompt(
  phone: string | null,
): Promise<string> {
  const last = getLastResult();
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

  const now = new Date();
  const dateStr = now.toISOString().split("T")[0];

  if (!last) {
    return `You are ArdaLink — a satellite-powered land companion for pastoralists in Bula Pesa Ward, Isiolo County, Kenya. The user is messaging you over TEXT CHAT.

LANGUAGE: Mirror the user. Swahili → Swahili, English → English, mixed → mixed. Never lecture about language.

You don't have a fresh satellite reading right now — a check has not run today. Be honest about that. You CAN still help with general questions about pasture, water points, landmarks, and drought management using the reference data below.

Keep replies SHORT (under 120 words). One practical, anchored answer beats a long lecture. Never invent satellite numbers.

Current date: ${dateStr}
Ward: Bula Pesa Ward, Isiolo, Kenya (0.355°N, 37.583°E)

${formatLandmarksBlock()}

${formatWaterPointsBlock()}

${waterBodies}

${formatProximityBlock()}

${memoryBlock ? memoryBlock + "\n\n" : ""}If the user asks about a specific area or water point, anchor your answer to the named place — never compass codes like "NW/SE". If they ask about something the data doesn't cover, say so honestly and offer the nearest covered insight.`;
  }

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
SATELLITE SNAPSHOT — ${last.month_name ?? now.toLocaleString("en", { month: "short" }).toUpperCase()} (Sentinel-2, image: ${last.live.imageDates[0] ?? "recent"}):
- ${anomaly.wardStressedPixelPct.toFixed(1)}% of Bula Pesa Ward is vegetation-stressed vs. the 11-year baseline
- Worst area: ${worstPlace} — ${anomaly.quadrantMeanAnomalyPct[anomaly.worstQuadrant as keyof typeof anomaly.quadrantMeanAnomalyPct]?.toFixed(1)}% below normal
- NDVI (greenness) median: ${anomaly.NDVI.p50.toFixed(1)}% vs baseline (worst 5%: ${anomaly.NDVI.p5.toFixed(1)}%)
- RED_EDGE (early stress): ${anomaly.RED_EDGE.p50.toFixed(1)}% vs baseline
- Full breakdown by area:
${quadBreakdown}`
    : "";

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

  return `You are ArdaLink — a respected veteran range management companion for pastoralists in Bula Pesa Ward, Isiolo, Kenya. You're chatting over TEXT (not voice) with someone who lives and grazes here. Be warm, plain-spoken, and concrete. 30 years of working with Borana pastoralists shapes your voice.

LANGUAGE POLICY (critical):
- Mirror the user's most recent message. Swahili → Swahili, English → English, Borana-flavoured Swahili → match it. Mixed/code-switched → answer in the same mix.
- Never correct grammar, pronunciation, or word choice. Never repeat their phrase back "correctly".
- Use simple, everyday words (ng'ombe, maji, kondoo na mbuzi) — not textbook Kiswahili Sanifu.

GEOGRAPHY (critical — anchor every recommendation to a real place):
- Bula Pesa Ward has four sub-areas. ALWAYS use the real names, never compass codes:
  • Wabera (northwest pastures)
  • Ngare Mara (northeast highlands)
  • Bulla Pesa town (southwest — town centre, water points, two boreholes)
  • Kambi Garba (southeast dryland)
- When you give an area-specific reading, use the exact % from the SATELLITE SNAPSHOT below. Do NOT invent numbers.
- If the user names a place that IS one of the four, anchor your reply to it with the matching number.
- If the user names a place that is NOT one of the four (Burat, Kinna, a manyatta, etc.), acknowledge it warmly, say you don't have direct satellite coverage for that exact spot, and offer the nearest covered area's reading instead. Never fabricate.

WATER POINTS & LANDMARKS (use these — they make your advice trustworthy):
- The blocks below list real boreholes, dams, springs, schools, dispensaries, mosques, markets, and dukas in and around Bula Pesa, with quadrants and rough distances.
- When the user asks "where can I find water?", "wapi nipate maji?", or names a specific borehole, look it up in the WATER POINTS block and answer with the actual name, quadrant, and (if known) distance.
- If they mention a landmark (school, mosque, market, dispensary), reference it from the LANDMARKS block — don't pretend ignorance.
- Some OSM-derived names are unverified — when in doubt, anchor to a confirmed landmark nearby rather than guessing.

GROUND TRUTH (use this — it's other herders' recent reports):
- The memory blocks below include what nearby herders have reported recently (pasture condition, water point status, livestock health). When relevant, mention "another herder near you reported X recently" — that's powerful for trust.
- If the user themselves has previously reported something (their phone is linked to past reports), reference it gently: "Last time you mentioned your goats were thin — how are they now?"

EXPECT ANYTHING:
- The user may ask about anything — weather, prices, family, politics, recipes, religion, jokes, tests. Answer briefly and warmly in their language. Then, only if it feels natural, bridge back to pasture/water/livestock. Don't force the bridge.
- If asked "are you AI?" — be honest in one line, then continue.
- If you genuinely don't know something (today's market price, a news event), say so honestly. Never invent.

RESPONSE STYLE:
- SHORT — under 120 words. Three or four sentences is usually plenty for chat. If the user asks a complex multi-part question, you can go longer but stay focused.
- CONCRETE — every recommendation should name (a) a specific place, (b) a species or BCS context if known, (c) a timeframe (today / this week / before Friday).
- Pair every question with a useful fact so the user never feels interrogated.
- It's fine to use light bilingual scaffolding ("Mvua / rain", "Malisho / pasture") to bridge — chat tolerates this better than voice does.

Current date: ${dateStr}
Ward: Bula Pesa Ward, Isiolo, Kenya (0.355°N, 37.583°E)

${formatLandmarksBlock()}

${formatWaterPointsBlock()}

${waterBodies}

${formatProximityBlock()}
${satBlock}
${climateBlock}
${forecastBlock}

${memoryBlock ? memoryBlock + "\n\n" : ""}Give the user your single most practical, anchored answer based on what they asked and the data above. Quality over quantity.`;
}

const router: IRouter = Router();

function clientIp(req: Request): string | null {
  // app.set("trust proxy", true) is set in server bootstrap, so req.ip is
  // the left-most X-Forwarded-For when behind the Replit proxy.
  return req.ip ?? null;
}

/**
 * POST /api/chat
 *
 * Ask the AI assistant about current land / vegetation conditions.
 * Uses the last intelligence cycle result as context.
 */
router.post("/chat", async (req, res): Promise<void> => {
  const parsed = ChatWithLandBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { message, history = [] } = parsed.data;
  const last = getLastResult();

  // Build context block for the system prompt
  const now = new Date();
  const monthName = now.toLocaleString("en-US", { month: "long" });

  const satBlock = last
    ? `
Satellite data (Sentinel-2, ${last.live.imageDates[0] ?? "recent"}):
- Ward stressed pixels: ${last.live.anomaly.wardStressedPixelPct.toFixed(1)}% (>15% below 11-yr baseline)
- Median NDVI anomaly: ${last.live.anomaly.NDVI.p50.toFixed(1)}%
- Worst 5% NDVI anomaly: ${last.live.anomaly.NDVI.p5.toFixed(1)}%
- Worst quadrant: ${last.live.anomaly.worstQuadrant}
- Quadrant mean NDVI anomaly (%):
  NW: ${last.live.anomaly.quadrantMeanAnomalyPct["NW"]?.toFixed(1) ?? "N/A"}%
  NE: ${last.live.anomaly.quadrantMeanAnomalyPct["NE"]?.toFixed(1) ?? "N/A"}%
  SW: ${last.live.anomaly.quadrantMeanAnomalyPct["SW"]?.toFixed(1) ?? "N/A"}%
  SE: ${last.live.anomaly.quadrantMeanAnomalyPct["SE"]?.toFixed(1) ?? "N/A"}%`
    : "No satellite data available yet — run a satellite check first.";

  const climateBlock = last?.climate
    ? `
Climate (30-day ERA5 snapshot):
- Temperature: ${last.climate.rolling30Day.meanTempC.toFixed(1)}°C
- Humidity: ${last.climate.current.humidityPct.toFixed(0)}%
- 30-day rainfall: ${last.climate.rolling30Day.totalPrecipMm.toFixed(1)}mm (${last.climate.rolling30Day.rainyDays} rainy days)
- ET₀ demand: ${last.climate.rolling30Day.totalET0Mm.toFixed(1)}mm
- Soil moisture: ${(last.climate.rolling30Day.meanSoilMoisture * 100).toFixed(1)}%
- Moisture Adequacy Index: ${last.climate.rolling30Day.moistureAdequacyIndex.toFixed(3)}
- Drought severity: ${last.climate.rolling30Day.droughtSeverity}`
    : "";

  const forecastBlock = last?.forecast
    ? `
14-day vegetation forecast:
- Risk level: ${last.forecast.outlook.riskLevel.toUpperCase()}
- Stress direction: ${last.forecast.outlook.stressDirection}
- Rain expected: ${last.forecast.forecast14d.totalPrecipMm.toFixed(1)}mm
- ET₀ demand: ${last.forecast.forecast14d.totalET0Mm.toFixed(1)}mm
- Effective rain reaching roots: ${last.forecast.forecast14d.effectiveRainMm.toFixed(1)}mm
- Forecast MAI: ${last.forecast.forecast14d.forecastMAI.toFixed(3)}
- Estimated recovery: ${last.forecast.outlook.estimatedRecoveryDays != null ? `${last.forecast.outlook.estimatedRecoveryDays} days` : "Not expected soon"}
- Recommendation: ${last.forecast.outlook.recommendation}`
    : "";

  const systemPrompt = `You are ArdaLink AI, a satellite-powered land intelligence assistant for Bula Pesa Ward, Isiolo County, Kenya.

Your role: Help pastoralists and agricultural officers understand the current vegetation health, climate stress, and grazing conditions in Bula Pesa Ward. Respond in English or Swahili depending on the language the user writes in. Be concise, practical, and data-driven. Always ground your answers in the actual satellite and climate data provided.

Current date: ${now.toISOString().split("T")[0]} (${monthName})
Ward: Bula Pesa Ward, Isiolo, Kenya (0.355°N, 37.583°E)
${satBlock}
${climateBlock}
${forecastBlock}

When the user asks in Swahili, respond in Swahili. When they ask in English, respond in English. Keep responses under 150 words unless detailed analysis is needed. Focus on actionable grazing and livestock management advice.`;

  try {
    const response = await complete(
      "multilingual",
      {
        messages: [
          { role: "system", content: systemPrompt },
          ...history.map((h) => ({ role: h.role, content: h.content })),
          { role: "user", content: message },
        ],
        temperature: 0.7,
        maxTokens: 400,
      },
      { tenantId: req.tenant?.tenant_id },
    );

    const reply = response.content ?? "";

    req.log.info(
      {
        messageLength: message.length,
        replyLength: reply.length,
        provider: response.provider,
        model: response.model,
        cached: response.cached,
        hasLastRun: !!last,
      },
      "Chat with land response generated",
    );

    res.json({
      reply,
      provider: response.provider,
      model: response.model,
      cached: response.cached,
      tokens: response.usage.totalTokens,
      latency_ms: response.latencyMs,
      context: {
        stressedPixelPct: last?.live.anomaly.wardStressedPixelPct ?? null,
        worstQuadrant: last?.live.anomaly.worstQuadrant ?? null,
        riskLevel: last?.forecast?.outlook.riskLevel ?? null,
        dataDate: last?.live.imageDates[0] ?? null,
      },
    });
  } catch (err: unknown) {
    req.log.error({ err }, "Chat request failed");
    res.status(500).json({ error: "Chat request failed" });
  }
});

/**
 * POST /api/talk-chat
 *
 * Public text-chat endpoint used by the /talk artifact. Same prompt + model
 * as POST /api/chat, but adds IP-based abuse limits (cooldown + daily cap)
 * and a hard message-length cap. Admin dashboard keeps using /api/chat
 * unlimited.
 */
router.post("/talk-chat", async (req, res): Promise<void> => {
  const parsed = ChatWithLandBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { message, history = [] } = parsed.data;

  const ip = clientIp(req);
  const gate = checkAndRecordTalkChat(ip, message);
  if (!gate.ok) {
    if (gate.reason === "cooldown") {
      res.status(429).json({
        error: "cooldown",
        retryAfterSeconds: gate.retryAfterSeconds,
        message: `Please wait ${gate.retryAfterSeconds}s before sending another message.`,
      });
      return;
    }
    if (gate.reason === "daily_cap") {
      res.status(429).json({
        error: "daily_cap",
        limit: gate.limit,
        resetsAt: gate.resetsAt,
        message: `Daily chat limit reached (${gate.limit} messages). Try again tomorrow.`,
      });
      return;
    }
    if (gate.reason === "message_too_long") {
      res.status(400).json({
        error: "message_too_long",
        maxLength: gate.maxLength,
        message: `Message too long (max ${gate.maxLength} characters).`,
      });
      return;
    }
    res
      .status(400)
      .json({ error: "message_empty", message: "Message is empty." });
    return;
  }

  // Trim history to the most recent 10 turns to bound prompt size — public
  // users may have very long histories piling up in localStorage.
  const trimmedHistory = history.slice(-10);

  // Phone is optional — when present we can wire in per-caller herder memory
  // (the same data the voice bridge uses). We accept it loosely from
  // req.body since ChatWithLandBody is shared with the admin route.
  const rawPhone =
    typeof req.body?.phone === "string" ? req.body.phone.trim() : "";
  const phone = /^\+\d{6,15}$/.test(rawPhone) ? rawPhone : null;

  // sessionId — client-generated UUID, one per tab. Used to upsert a single
  // ground_truth_reports row per chat session instead of creating a new row
  // on every message. Validate loosely (must be short alphanum-ish).
  const rawSessionId =
    typeof req.body?.sessionId === "string" ? req.body.sessionId.trim() : "";
  const sessionId = /^[A-Za-z0-9_-]{8,64}$/.test(rawSessionId)
    ? rawSessionId
    : null;

  const systemPrompt = await buildTalkChatSystemPrompt(phone);
  const last = getLastResult();

  try {
    const response = await complete(
      "multilingual",
      {
        messages: [
          { role: "system", content: systemPrompt },
          ...trimmedHistory.map((h) => ({ role: h.role, content: h.content })),
          { role: "user", content: message },
        ],
        temperature: 0.7,
        maxTokens: 350,
      },
      { tenantId: undefined },
    );

    const reply = response.content ?? "";

    req.log.info(
      {
        ip,
        phone: phone ?? "(anon)",
        sessionId: sessionId ?? "(none)",
        msgLen: message.length,
        replyLen: reply.length,
        provider: response.provider,
        model: response.model,
        cached: response.cached,
        remaining: getTalkChatRemaining(ip),
      },
      "[TalkChat] reply generated",
    );

    res.json({
      reply,
      provider: response.provider,
      model: response.model,
      cached: response.cached,
      remaining: getTalkChatRemaining(ip),
      limit: TALK_CHAT_MAX_MSGS_PER_IP,
      maxMessageLength: TALK_CHAT_MAX_MESSAGE_LENGTH,
      context: {
        stressedPixelPct: last?.live.anomaly.wardStressedPixelPct ?? null,
        worstQuadrant: last?.live.anomaly.worstQuadrant ?? null,
        riskLevel: last?.forecast?.outlook.riskLevel ?? null,
        dataDate: last?.live.imageDates[0] ?? null,
      },
    });
  } catch (err: unknown) {
    req.log.error({ err }, "Talk-chat request failed");
    res.status(500).json({ error: "internal", message: "Chat request failed" });
  }
});

export default router;
