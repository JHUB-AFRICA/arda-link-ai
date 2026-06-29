import { logger } from "./logger.js";
import { complete, type LlmResponse } from "./llm/index.js";
import type { VegetationDelta } from "./baseline.js";

export interface PixelContext {
  wardStressedPixelPct: number; // % pixels >15% below own history
  medianAnomalyPct: number; // p50 NDVI anomaly
  p5AnomalyPct: number; // worst 5% of pixels
  worstQuadrant: string;
  historicalImageCount: number;
  /** Real-time climate snapshot — if available, woven into the script */
  climate?: {
    tempC: number;
    humidityPct: number;
    totalPrecip30dMm: number;
    rainyDays: number;
    meanSoilMoisture: number; // volumetric m³/m³
    moistureAdequacyIndex: number;
    droughtSeverity: string;
    totalET0Mm: number;
  };
  /** 14-day vegetation forecast — if available, woven into the script */
  forecast?: {
    totalPrecip14dMm: number;
    totalET0_14dMm: number;
    effectiveRainMm: number;
    forecastMAI: number;
    rainyDays: number;
    stressDirection: string;
    riskLevel: string;
    seasonalTrend: string;
    estimatedRecoveryDays: number | null;
    recommendation: string;
  };
}

// ── JSON sanitizer ────────────────────────────────────────────────────────────
/**
 * GPT-4o sometimes emits literal control characters (newline, tab, etc.)
 * inside JSON string values instead of their escape sequences.
 * Walk the raw string character-by-character and escape any bare control
 * characters that appear inside a JSON string value.
 */
function sanitizeJsonString(raw: string): string {
  let out = "";
  let inStr = false;
  let escaped = false;
  for (const ch of raw) {
    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\" && inStr) {
      out += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') {
      out += ch;
      inStr = !inStr;
      continue;
    }
    if (inStr && ch.charCodeAt(0) < 0x20) {
      // Bare control character inside a string — escape it
      if (ch === "\n") out += "\\n";
      else if (ch === "\r") out += "\\r";
      else if (ch === "\t") out += "\\t";
      // other control chars: drop them
      continue;
    }
    out += ch;
  }
  return out;
}

// ── Script / context generation ─────────────────────────────────────────────
//
// These three exports (generateScript / generateActionTag /
// extractIndicators) are the AI-side of the post-call pipeline. They
// used to call Azure OpenAI chat completions directly via a private
// `azureChatPost()` helper. They now go through the provider-agnostic
// LLM registry (`./llm/index.js`), which:
//
//   - Routes to z.ai (GLM-4.5-Flash) by default — fast, free, handles
//     Swahili/English code-switching natively.
//   - Falls back to minimax (M3) if z.ai is down or budget-exceeded.
//   - Caches per (tenant, prompt, lang) for LLM_CACHE_TTL_SECONDS.
//   - Audits every call (provider/model/tokens/latency/cache).
//
// All three functions retain their original signature so the callers
// in `intelligence.ts`, `voiceStream.ts`, `voiceStreamBrowser.ts`, and
// `chatGroundTruth.ts` don't change. If the registry returns nothing
// usable (both providers down, budget exceeded), the function falls
// back to the local template / keyword classifier so the call never
// fails — the cost of an offline LLM is a worse script, not a broken
// call.
//
// Realtime WebSocket audio (voiceStream.ts) is unchanged — that path
// is not text generation, it's bidirectional mulaw streaming that z.ai
// and minimax don't offer. Azure OpenAI Realtime (gpt-4o-realtime) stays
// the only option for that path until Phase 3 (ARCHITECTURE-V2 §5.3).

// ── Exported types ──────────────────────────────────────────────────────────
export interface GeneratedScript {
  script: string;
  question: string;
}

// ── Template-based script builder ────────────────────────────────────────────
function buildTemplateScript(
  delta: VegetationDelta,
  monthName: string,
  px?: PixelContext,
): GeneratedScript {
  const ndviPct = delta.NDVI.delta_pct;
  const stressedPct = px?.wardStressedPixelPct ?? 0;
  const medianPct = px?.medianAnomalyPct ?? ndviPct;
  const p5Pct = px?.p5AnomalyPct ?? ndviPct;
  const quadrant = px?.worstQuadrant;
  const cl = px?.climate;

  // Severity — vegetation stress primary, reinforced by climate
  const climateSevere =
    cl &&
    (cl.droughtSeverity === "severe" ||
      cl.droughtSeverity === "extreme" ||
      cl.moistureAdequacyIndex < 0.3);

  const isCritical =
    stressedPct > 40 ||
    p5Pct < -35 ||
    ndviPct < -25 ||
    (!!climateSevere && stressedPct > 25);
  const isModerate =
    !isCritical && (stressedPct > 20 || medianPct < -15 || ndviPct < -20);
  const isEarly = !isCritical && !isModerate;

  // Severity phrases
  const swahiliPhrase = isCritical
    ? "Malisho iko katika hali mbaya sana"
    : isModerate
      ? "Nguvu inaondoka nyikani — majani yanakausha"
      : "Dalili za kwanza zinaonekana";

  // Pixel-level data line
  const pixelLine = px
    ? `Satellite yetu imeangalia kila sehemu ya mita 20 kwa mita 20 katika Ward — ` +
      `${stressedPct.toFixed(0)}% ya maeneo ya malisho imeshuka zaidi ya 15% chini ya wastani wake wa miaka kadhaa. ` +
      (quadrant && quadrant !== "uniform"
        ? `Eneo la ${quadrant} ndilo gumu zaidi. `
        : "Hali ipo kote sawa. ")
    : `NDVI imeshuka ${Math.abs(ndviPct).toFixed(0)}% chini ya wastani wa miaka 11. `;

  // Climate data line — woven in when available
  let climateLine = "";
  if (cl) {
    const precip = cl.totalPrecip30dMm.toFixed(0);
    const temp = cl.tempC.toFixed(1);
    const mai = cl.moistureAdequacyIndex;
    const sm = (cl.meanSoilMoisture * 100).toFixed(1);

    if (cl.droughtSeverity === "extreme" || cl.droughtSeverity === "severe") {
      climateLine =
        `Hali ya hewa pia ni ngumu — mvua ya siku 30 ni ${precip}mm tu, ` +
        `joto la sasa ni ${temp}°C, na unyevu wa udongo ni ${sm}%. ` +
        `Ardhi imepoteza maji zaidi ya ${Math.round((1 - mai) * 100)}% ya mahitaji yake. `;
    } else if (cl.droughtSeverity === "moderate") {
      climateLine =
        `Hali ya mvua pia inachangia — ${precip}mm katika siku 30, ` +
        `joto ${temp}°C, unyevu wa udongo ${sm}%. `;
    } else if (cl.droughtSeverity === "mild") {
      climateLine = `Mvua ya siku 30 ni ${precip}mm — chini kidogo ya mahitaji ya malisho. `;
    }
    // "none" severity — climate is fine, don't add noise
  }

  // Questions are species-neutral ("mifugo" = livestock generally) and
  // location-neutral. The AI must ASK where they are and what species
  // they have BEFORE asking these — never assume cows or a specific place.
  let question: string;
  if (isCritical) {
    question =
      "Je, visima na maeneo ya maji yanafanya kazi — na je, maji yanatosha kwa mifugo yako? Are your water points still functioning and is there enough water for your animals?";
  } else if (isModerate) {
    question =
      "Je, mifugo yako inabadilisha mwelekeo wa malisho, au inabaki sehemu moja? Have your animals started moving toward new grazing areas, or are they staying put?";
  } else {
    question =
      "Je, unaona mabadiliko katika rangi ya majani au tabia ya kula ya mifugo? Are you noticing any changes in grass colour or how your livestock graze?";
  }

  const script =
    `Habari yako. Mimi ni ArdaLink, msimamizi wa malisho Isiolo. ` +
    `${swahiliPhrase} katika Bula Pesa Ward mwezi huu wa ${monthName}. ` +
    pixelLine +
    climateLine +
    `Tunajua hali hii inaweza kuathiri mifugo yako na familia yako. ` +
    `Tunataka kujua hali halisi kutoka kwako — wewe ndiye mtaalamu wa ardhi hii. `;

  logger.info(
    {
      ndviPct,
      stressedPct,
      medianPct,
      isCritical,
      isModerate,
      isEarly,
      droughtSeverity: cl?.droughtSeverity,
      mai: cl?.moistureAdequacyIndex,
    },
    "[AI Script Generation] Climate-aware template script built",
  );
  return { script, question };
}

// ── Public: generate script (AI if available, template fallback) ─────────────
export async function generateScript(
  delta: VegetationDelta,
  monthName: string,
  px?: PixelContext,
): Promise<GeneratedScript> {
  const ndviPct = delta.NDVI.delta_pct;
  const rePct = delta.RED_EDGE.delta_pct;

  const pixelLines = px
    ? `\nPixel-level analysis (each 20×20m cell vs its own 10-year history):
- ${px.wardStressedPixelPct.toFixed(1)}% of vegetated pixels are >15% below their own norm
- Median pixel anomaly: ${px.medianAnomalyPct.toFixed(1)}%
- Worst 5% of pixels: ${px.p5AnomalyPct.toFixed(1)}%
- Most stressed quadrant: ${px.worstQuadrant}`
    : "";

  const cl = px?.climate;
  const fc = px?.forecast;

  const climateLines = cl
    ? `\nCurrent climate (last 30 days, Open-Meteo ERA5):
- Temperature: ${cl.tempC.toFixed(1)}°C  |  Humidity: ${cl.humidityPct.toFixed(0)}%
- Rainfall: ${cl.totalPrecip30dMm.toFixed(0)}mm over ${cl.rainyDays} rainy days
- Evaporation demand (ET₀): ${cl.totalET0Mm.toFixed(0)}mm
- Topsoil moisture: ${(cl.meanSoilMoisture * 100).toFixed(1)}% volumetric
- Moisture Adequacy Index: ${cl.moistureAdequacyIndex.toFixed(2)} (${cl.droughtSeverity} drought)`
    : "";

  const forecastLines = fc
    ? `\n14-day forecast:
- Rain expected: ${fc.totalPrecip14dMm.toFixed(0)}mm over ${fc.rainyDays} days  |  Evaporation demand: ${fc.totalET0_14dMm.toFixed(0)}mm
- Effective rain reaching roots: ${fc.effectiveRainMm.toFixed(0)}mm
- Forecast MAI: ${fc.forecastMAI.toFixed(2)}  |  Stress direction: ${fc.stressDirection}  |  Risk: ${fc.riskLevel}
- Seasonal trend: ${fc.seasonalTrend}
- Recovery estimate: ${fc.estimatedRecoveryDays != null ? `~${fc.estimatedRecoveryDays} days` : "no recovery expected this season"}
- Recommended action: ${fc.recommendation}`
    : "";

  try {
    const response = await complete(
      "voice_script",
      {
        messages: [
          {
            role: "system",
            content: `You are ArdaLink, a respected veteran range management expert in Isiolo, Kenya.
You have 30 years working with Borana pastoralists. Speak in a natural, warm mix of English and Swahili.
Translate satellite data, climate numbers, and the 14-day forecast into physical reality the herder can understand and feel.
Reference specific pixel percentages and the forecast outlook — make the science tangible and the future concrete.
Be honest about severity but never alarming. One sentence of hope or direction at the end.`,
          },
          {
            role: "user",
            content: `Generate a voice call script for a Boran pastoralist in Bula Pesa Ward — ${monthName}.

Ward-mean vs Cosmos DB 11-year baseline:
- NDVI: ${delta.NDVI.live.toFixed(3)} (${ndviPct > 0 ? "+" : ""}${ndviPct.toFixed(1)}%)
- NDRE: ${delta.NDRE.live.toFixed(3)} (${delta.NDRE.delta_pct > 0 ? "+" : ""}${delta.NDRE.delta_pct.toFixed(1)}%)
- Red Edge: ${delta.RED_EDGE.live.toFixed(3)} (${rePct > 0 ? "+" : ""}${rePct.toFixed(1)}%)${pixelLines}${climateLines}${forecastLines}

Return JSON: {"script": "<45-second Swahili/English opening — weave in satellite, climate, and forecast naturally>", "question": "<one specific question calibrated to severity and the worst quadrant>"}`,
          },
        ],
        maxTokens: 700,
        temperature: 0.72,
      },
      { tenantId: undefined },
    );

    const parsed = parseScriptResponse(response);
    if (parsed) {
      logger.info(
        {
          provider: response.provider,
          model: response.model,
          cached: response.cached,
        },
        "[AI Script Generation] LLM script generated via registry",
      );
      return parsed;
    }
  } catch (err) {
    logger.warn(
      { err },
      "LLM script generation failed via registry — using template",
    );
  }

  return buildTemplateScript(delta, monthName, px);
}

function parseScriptResponse(response: LlmResponse): GeneratedScript | null {
  // The schema is fixed — reuse a hand-rolled parser. Avoids the
  // completeJson() round-trip which would re-call the LLM through
  // jsonSchema. The MockClient returns already-structured JSON so we
  // can also try the strict path.
  const text = response.content ?? "";
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const obj = JSON.parse(sanitizeJsonString(match[0])) as Record<
      string,
      unknown
    >;
    const script = typeof obj["script"] === "string" ? obj["script"] : "";
    const question = typeof obj["question"] === "string" ? obj["question"] : "";
    if (!script || !question) return null;
    return { script, question };
  } catch {
    return null;
  }
}

// ── Public: generate action tag ─────────────────────────────────────────────
export async function generateActionTag(
  transcript: string,
  context: { aiQuestion: string; month: string; delta: VegetationDelta },
): Promise<string> {
  try {
    const response = await complete(
      "extract",
      {
        messages: [
          {
            role: "system",
            content:
              "Classify pastoralist feedback into a 2-4 word action tag. Return only the tag.",
          },
          {
            role: "user",
            content: `Month: ${context.month}
NDVI change: ${context.delta.NDVI.delta_pct.toFixed(1)}%, RED_EDGE change: ${context.delta.RED_EDGE.delta_pct.toFixed(1)}%
Question: ${context.aiQuestion}
Response: ${transcript}

Tags: "Water Crisis", "Movement Started", "Supplementation Needed", "Normal Grazing", "Borehole Depleted", "Seeking New Pasture", "Herd Reduction", "Dry Season Stress", "Early Warning Noted"`,
          },
        ],
        temperature: 0.2,
        maxTokens: 15,
      },
      { tenantId: undefined },
    );
    const tag = response.content.trim();
    if (tag) {
      logger.info(
        { provider: response.provider, cached: response.cached },
        "[AI Action Tag] LLM tag generated via registry",
      );
      return tag;
    }
  } catch (err) {
    logger.warn(
      { err },
      "LLM action tag failed via registry — using keyword classifier",
    );
  }

  // Keyword-based classifier — works without any LLM available
  return keywordActionTag(transcript, context.delta);
}

// ── Keyword classifier fallback ─────────────────────────────────────────────
function keywordActionTag(transcript: string, delta: VegetationDelta): string {
  const t = transcript.toLowerCase();

  const has = (...words: string[]) => words.some((w) => t.includes(w));

  if (
    has(
      "no water",
      "maji hakuna",
      "borehole",
      "kisima",
      "dry",
      "kavu",
      "empty",
      "tupu",
    )
  )
    return delta.NDVI.delta_pct < -20 ? "Water Crisis" : "Borehole Depleted";

  if (
    has(
      "moving",
      "kuhamia",
      "moved",
      "tunaenda",
      "migration",
      "new area",
      "eneo jipya",
    )
  )
    return "Movement Started";

  if (has("supplement", "chakula", "hay", "nyasi", "feed", "kulisha"))
    return "Supplementation Needed";

  if (
    has(
      "reducing",
      "kupunguza",
      "sold",
      "kuuza",
      "less cattle",
      "ng'ombe wachache",
    )
  )
    return "Herd Reduction";

  if (has("ok", "sawa", "normal", "kawaida", "good", "nzuri", "fine"))
    return "Normal Grazing";

  if (has("dry season", "kiangazi", "stress", "shida", "difficult", "ngumu"))
    return "Dry Season Stress";

  // Default based on severity
  return delta.NDVI.delta_pct < -20
    ? "Dry Season Stress"
    : "Early Warning Noted";
}

// Transcription is handled natively by the Azure OpenAI Realtime API
// (input_audio_transcription: { model: "whisper-1" } in session config).
// No separate Whisper deployment needed.

// ── Indicator extraction (post-call) ────────────────────────────────────────
// After a herder conversation ends, run the full transcript through GPT-4o
// to extract globally-validated livestock-stress indicators:
//   - BCS (ILRI/FAO Tropical 1–5)        — primary, every call
//   - Offtake (FEWS NET)                  — secondary
//   - Mortality (LEGS/FAO)                — secondary
//   - Milk production (ILRI EW)           — secondary
//   - Trekking distance (FAO AWG)         — secondary
//   - Water point status                  — secondary
//   - Supplementary feeding (WFP CSI)     — secondary
//
// All fields are nullable — extractor must not hallucinate. Unknown = null.

export type BcsConfidence = "high" | "medium" | "low" | "uncertain";
export type BcsSpecies = "cattle" | "goats" | "sheep" | "camels" | "mixed";
export type OfftakeRate = "early" | "normal" | "not_selling";
export type MortalityRate = "none" | "1-3" | "4-plus";
export type MilkProduction = "normal" | "reduced" | "stopped";
export type WaterTrekkingDistance = "under_5km" | "5-10km" | "over_10km";
export type WaterPointStatus =
  | "operational_good"
  | "operational_poor"
  | "not_operational"
  | "dry"
  | "unknown";
export type SupplementaryFeeding = "yes" | "no" | "planning";
export type ReportedQuadrant = "NW" | "NE" | "SW" | "SE" | "unknown";

export interface ExtractedIndicators {
  bcs_score: number | null;
  bcs_raw_response: string | null;
  bcs_species: BcsSpecies | null;
  bcs_confidence: BcsConfidence | null;
  bcs_flag_followup: boolean;
  offtake_rate: OfftakeRate | null;
  offtake_raw_response: string | null;
  mortality_rate: MortalityRate | null;
  mortality_raw_response: string | null;
  milk_production: MilkProduction | null;
  milk_raw_response: string | null;
  water_trekking_distance: WaterTrekkingDistance | null;
  water_trekking_raw: string | null;
  water_point_name: string | null;
  water_point_status: WaterPointStatus | null;
  water_point_raw_response: string | null;
  supplementary_feeding: SupplementaryFeeding | null;
  supplementary_raw_response: string | null;
  reported_quadrant: ReportedQuadrant | null;
  reported_location: string | null;
  indicators_collected: number;
}

const EXTRACTOR_SYSTEM = `You are a livestock data extraction system for East African pastoralist communities.
Your job: read a Swahili/English/Borana voice-call transcript between an AI rangeland expert and a herder, then extract globally-standardized livestock-stress indicators as STRICT JSON.

Indicator standards:
- BCS: ILRI/FAO Tropical Body Condition Scale (integer-or-half 1.0–5.0)
  1 = emaciated, bones visible, very weak
  2 = thin, ribs and spine clearly visible
  3 = moderate, ribs feelable with some muscle
  4 = good muscle cover, active
  5 = excellent, strong and healthy
- Offtake: FEWS NET livestock indicators (early/normal/not_selling)
- Mortality: LEGS / FAO emergency guidelines (none / 1-3 / 4-plus animals lost in last 2 weeks)
- Milk: ILRI early warning (normal / reduced / stopped)
- Trekking: FAO Animal Welfare (under_5km / 5-10km / over_10km)
- Water point status: operational_good / operational_poor / not_operational / dry / unknown
- Supplementary feeding: WFP Coping Strategy Index (yes / no / planning)

Bula Pesa Ward sub-areas (for reported_quadrant classification):
- NW = Wabera area
- NE = Ngare Mara highlands
- SW = Bulla Pesa town centre and southwest boreholes
- SE = Kambi Garba dryland

RULES (absolutely critical):
- NEVER invent. If the transcript does not contain enough information for an indicator, set that field to null.
- ABSENCE OF INFORMATION IS NOT A NEGATIVE STATUS. If the herder says "I didn't go there", "I haven't checked", "I don't know", "sijaenda", "sijui", or similar — that is NULL or "unknown", NEVER "not_operational" / "dry" / "stopped" / "4-plus" / etc. Negative statuses require an explicit negative observation by the herder.
  • water_point_status: only "not_operational" / "dry" if the herder explicitly said it is broken / has no water. If they didn't visit, set "unknown".
  • mortality_rate: only "1-3" / "4-plus" if they explicitly named animal losses. If they didn't say, set null.
  • milk_production: only "reduced" / "stopped" if they explicitly described it. If they didn't say, set null.
  • offtake_rate: only "early" if they explicitly said they sold earlier than usual. Otherwise null.
- bcs_score must be classified from the herder's actual words. If the herder is vague or did not answer, set bcs_score to null and bcs_confidence to "uncertain" and bcs_flag_followup to true.
- bcs_species must match the species the herder ACTUALLY mentioned (goats / sheep / camels / cattle / mixed). Do NOT default to "cattle" just because the AI asked about cows — if the herder corrected ("I have goats, not cows"), record goats. If species was never confirmed, leave null.
- bcs_raw_response and other *_raw_response fields must be a short quote (≤ 150 chars) of what the herder actually said about that topic, in their own language. Null if they did not speak to it.
- reported_quadrant must be derived ONLY from a place the herder actually named that maps to one of the four areas above. If the AI guessed/assumed a place and the herder did not confirm it, set null. Never infer location from a default opening greeting.
- reported_location: ONLY the place name the herder themselves stated. Never the place the AI assumed.
- indicators_collected = count of non-null primary+secondary indicators (BCS, offtake, mortality, milk, trekking, water point status, supplementary feeding). 0–7. Values of "unknown" do NOT count.
- Return ONLY a single JSON object. No preamble, no markdown fences, no commentary.`;

export async function extractIndicators(
  transcript: string,
): Promise<ExtractedIndicators | null> {
  if (!transcript.trim()) return null;

  // Loose shape — we always run the server-side normalisation below to
  // defend against hallucinated values. The LLM is asked to return
  // strict JSON; we still tolerate loose output (markdown fences,
  // trailing prose) by extracting the first {...} block before parsing.
  const LooseShape = (
    obj: unknown,
  ): {
    bcs_score?: unknown;
    bcs_raw_response?: unknown;
    bcs_species?: unknown;
    bcs_confidence?: unknown;
    offtake_rate?: unknown;
    offtake_raw_response?: unknown;
    mortality_rate?: unknown;
    mortality_raw_response?: unknown;
    milk_production?: unknown;
    milk_raw_response?: unknown;
    water_trekking_distance?: unknown;
    water_trekking_raw?: unknown;
    water_point_name?: unknown;
    water_point_status?: unknown;
    water_point_raw_response?: unknown;
    supplementary_feeding?: unknown;
    supplementary_raw_response?: unknown;
    reported_quadrant?: unknown;
    reported_location?: unknown;
    indicators_collected?: unknown;
  } => (typeof obj === "object" && obj !== null ? (obj as never) : {});

  // The registry's completeJson() expects a Zod schema. We keep the
  // loose normalisation here so we can ALSO fall back to lenient
  // parsing if the registry returns non-strict JSON (e.g. M3 without
  // response_format). We do a single-shot via complete() and parse
  // ourselves, preserving the historical behaviour exactly.
  try {
    const response = await complete(
      "extract",
      {
        messages: [
          { role: "system", content: EXTRACTOR_SYSTEM },
          { role: "user", content: `Transcript:\n${transcript}` },
        ],
        temperature: 0.1,
        maxTokens: 900,
      },
      { tenantId: undefined },
    );

    const text = response.content ?? "";
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) {
      logger.warn(
        { provider: response.provider, text: text.slice(0, 200) },
        "Indicator extractor returned no JSON object",
      );
      return null;
    }
    const parsed = LooseShape(
      JSON.parse(sanitizeJsonString(match[0])),
    ) as Partial<ExtractedIndicators>;

    // Normalise & defend against hallucination
    const normEnum = <T extends string>(
      v: unknown,
      allowed: readonly T[],
    ): T | null =>
      typeof v === "string" && (allowed as readonly string[]).includes(v)
        ? (v as T)
        : null;
    const normNum = (v: unknown, min: number, max: number): number | null =>
      typeof v === "number" && Number.isFinite(v) && v >= min && v <= max
        ? v
        : null;
    const normStr = (v: unknown, max = 500): string | null =>
      typeof v === "string" && v.trim().length > 0
        ? v.trim().slice(0, max)
        : null;

    // Enforce ILRI/FAO half-step granularity (1.0, 1.5, …, 5.0)
    const rawBcs = normNum(parsed.bcs_score, 1, 5);
    const bcsScore = rawBcs == null ? null : Math.round(rawBcs * 2) / 2;
    const bcsConfidence = normEnum(parsed.bcs_confidence, [
      "high",
      "medium",
      "low",
      "uncertain",
    ] as const);

    const indicators: ExtractedIndicators = {
      bcs_score: bcsScore,
      bcs_raw_response: normStr(parsed.bcs_raw_response, 250),
      bcs_species: normEnum(parsed.bcs_species, [
        "cattle",
        "goats",
        "sheep",
        "camels",
        "mixed",
      ] as const),
      bcs_confidence: bcsConfidence,
      // Always server-derived — never trust the model's self-report. If we
      // don't have a numeric BCS, or confidence is low/uncertain, flag it.
      bcs_flag_followup:
        bcsScore == null ||
        bcsConfidence === "uncertain" ||
        bcsConfidence === "low" ||
        bcsConfidence == null,
      offtake_rate: normEnum(parsed.offtake_rate, [
        "early",
        "normal",
        "not_selling",
      ] as const),
      offtake_raw_response: normStr(parsed.offtake_raw_response, 250),
      mortality_rate: normEnum(parsed.mortality_rate, [
        "none",
        "1-3",
        "4-plus",
      ] as const),
      mortality_raw_response: normStr(parsed.mortality_raw_response, 250),
      milk_production: normEnum(parsed.milk_production, [
        "normal",
        "reduced",
        "stopped",
      ] as const),
      milk_raw_response: normStr(parsed.milk_raw_response, 250),
      water_trekking_distance: normEnum(parsed.water_trekking_distance, [
        "under_5km",
        "5-10km",
        "over_10km",
      ] as const),
      water_trekking_raw: normStr(parsed.water_trekking_raw, 250),
      water_point_name: normStr(parsed.water_point_name, 100),
      water_point_status: normEnum(parsed.water_point_status, [
        "operational_good",
        "operational_poor",
        "not_operational",
        "dry",
        "unknown",
      ] as const),
      water_point_raw_response: normStr(parsed.water_point_raw_response, 250),
      supplementary_feeding: normEnum(parsed.supplementary_feeding, [
        "yes",
        "no",
        "planning",
      ] as const),
      supplementary_raw_response: normStr(
        parsed.supplementary_raw_response,
        250,
      ),
      reported_quadrant: normEnum(parsed.reported_quadrant, [
        "NW",
        "NE",
        "SW",
        "SE",
        "unknown",
      ] as const),
      reported_location: normStr(parsed.reported_location, 100),
      indicators_collected: 0,
    };

    // Recompute indicators_collected ourselves — never trust the model's count.
    // Semantic-unknown values (water_point_status === "unknown") don't count as
    // collected, even though they're non-null.
    const wpsCollected =
      indicators.water_point_status != null &&
      indicators.water_point_status !== "unknown";
    const primaryAndSecondary: Array<boolean> = [
      indicators.bcs_score != null,
      indicators.offtake_rate != null,
      indicators.mortality_rate != null,
      indicators.milk_production != null,
      indicators.water_trekking_distance != null,
      wpsCollected,
      indicators.supplementary_feeding != null,
    ];
    indicators.indicators_collected =
      primaryAndSecondary.filter(Boolean).length;

    logger.info(
      {
        provider: response.provider,
        cached: response.cached,
        bcs: indicators.bcs_score,
        bcsConf: indicators.bcs_confidence,
        collected: indicators.indicators_collected,
        quadrant: indicators.reported_quadrant,
      },
      "[Indicators Extracted] Structured indicators saved via registry",
    );
    return indicators;
  } catch (err) {
    logger.warn({ err }, "Indicator extraction failed");
    return null;
  }
}

/**
 * Build the indicator-collection block injected into both voice system prompts.
 * Mirror-language stays intact — the AI weaves these questions in naturally.
 */
export function indicatorCollectionBlock(): string {
  return `
─── INDICATOR COLLECTION (the operational purpose of every call) ───
You are not chatting — you are quietly gathering globally-validated livestock-stress data while sounding like a friend. Weave these questions in naturally, in whatever language the herder is speaking. Never make them feel like a survey respondent.

PRIMARY — collect on EVERY call without exception:
• Body Condition Score (ILRI/FAO Tropical Scale 1–5)
  Ask once naturally, e.g. in Swahili: "Mifugo yako inaonekana vipi wiki hii — mbavu zinaonekana, wamepoteza uzito, au wanaonekana wazima na wenye nguvu?"
  Or in English: "How are your animals looking this week — are ribs showing, have they lost weight, or are they strong and healthy?"
  If the herder is vague, probe ONCE more with a simpler version, then move on — the extractor will flag low confidence for follow-up. Never invent a score.

SECONDARY — collect 2–3 of these if the conversation allows, prioritising the most relevant to current satellite/climate stress:
• Herd offtake (FEWS NET): "Have you started selling animals earlier than usual this year?" / "Je, umeanza kuuza mifugo mapema mwaka huu kuliko kawaida?"
• Mortality (LEGS): "Have you lost any animals in the past two weeks?" / "Je, umepoteza mifugo yoyote wiki hizi mbili zilizopita?"
• Milk production (ILRI): use the SPECIES they confirmed. Cows → "Ng'ombe wako wanaendelea kutoa maziwa kama kawaida?" / "Are your cows still giving milk as normal?". Goats → "Mbuzi wako wanatoa maziwa kama kawaida?" / "Are your goats still producing milk normally?". Camels → "Ngamia wako wanatoa maziwa kama kawaida?". Sheep don't produce milk for sale here — skip this question if they only have sheep. NEVER ask about cows if they said goats/sheep/camels.
• Water trekking distance (FAO AWG): DO NOT ask the herder for kilometres — they don't think in km. Use the PROXIMITY CHEAT-SHEET above: when they name a landmark, look up the nearest water point and quote the distance yourself in confirmation form: "so you're near <water point>, about <X> km from <landmark> — is that the one you walk to?" / "uko karibu na <water point>, ni karibu km <X> kutoka <landmark> — ndio unayoenda?". If they confirm and that distance is under 5 km, classify as under_5km; 5–10 km → 5-10km; over 10 km → over_10km. If they say they walk to a DIFFERENT water point, ask which one and re-quote that distance from the cheat-sheet.
• Water point status: refer to the nearest OSM water point above by name and ask: "Is it working today? Is the water good, or is there a problem?" / "Je, kinafanya kazi leo? Maji yako vipi — mazuri au kuna tatizo?"
• Supplementary feeding (WFP CSI): "Are you buying extra feed for your herd right now?" / "Je, unanunua chakula cha ziada kwa mifugo yako sasa hivi?"

FLOW (this order is non-negotiable — do not skip steps 2 and 3):
1. Greet warmly and briefly say you're calling from ArdaLink with the satellite update for the ward (not a specific place yet).
2. ASK WHERE THEY ARE TODAY — never assume. "Uko wapi leo na mifugo yako?" / "Where are you grazing your animals today?" Wait for their answer and anchor everything afterwards to that place. If the place they name is one of the four sub-areas, use the matching satellite number. If not, acknowledge it and offer the nearest covered area's reading. The PROXIMITY CHEAT-SHEET above lets you compute distance to the nearest water point from whatever landmark they name.
3. ASK WHAT SPECIES THEY HAVE — never assume cows. "Una mifugo gani leo — ng'ombe, mbuzi, kondoo, au ngamia?" / "What kind of animals are you with today — cattle, goats, sheep, or camels?" From this point on, USE THEIR SPECIES in every question. If they said goats, say "mbuzi"; if camels, "ngamia"; if mixed herd, use "mifugo" (livestock) as the catch-all. NEVER say "ng'ombe" / "cows" again unless they confirmed cattle.
4. NOW share the satellite picture for THEIR area + ask the BCS question, anchored to their species and place.
5. Probe naturally based on their answer, then collect 2–3 more secondary indicators.
6. Ask water point status ONLY about a water point they have actually visited recently. If they say "I didn't go there" / "sijaenda" — accept that, do not push, and move on. Absence of a visit is NOT a problem report.
7. Thank them genuinely — they are protecting their own community by sharing this.
8. Whole call: 3–4 minutes maximum.

ONE QUESTION AT A TIME — non-negotiable:
- Every turn must end with AT MOST ONE question mark. Never stack two questions in the same breath ("How are your animals, and have you sold any?" is forbidden).
- After you ask, STOP TALKING and wait for the herder's answer before moving to the next indicator. Silence is fine — let them think.
- If you have an observation to share (satellite context, empathy, acknowledgement), say it as a statement, then ask your single question.
- Keep each turn under 2 short sentences + 1 question. If you catch yourself listing options or chaining clauses with "and… and…", cut it down.
- Indicators are collected ACROSS turns, not in one big survey. One question, one answer, then the next question on the next turn.

CRITICAL:
- Never invent a water point or landmark not in the OSM lists above.
- Never assume a default location (no "you're in Kiwanjani" / "you're near the borehole") — ASK every time and let them tell you.
- Never assume a default species (no "your cows…") — ASK and mirror.
- Never guess a BCS score — classify from the herder's actual words; if unclear, the post-call extractor will mark it uncertain for follow-up.
- If the herder says they haven't visited a water point / haven't checked something, accept it. "I don't know" is a valid answer; don't pressure them and don't extrapolate a negative status from silence.
- If the herder names an unknown place, ask one clarifying question anchored to the nearest known landmark from the LANDMARKS block.

─── GIVE BACK BEFORE YOU GO (the herder is doing US a favour — they deserve value in return) ───
After you have BCS + 2–3 secondary indicators, do NOT just thank and hang up. Spend ONE turn (≤ 3 sentences) delivering concrete, situation-specific advice the herder can act on TODAY. Choose ONE or TWO of the most relevant from the lists below, anchored to what THEY actually told you and what the satellite + climate + forecast blocks above show. Use plain Swahili/English in their preferred tongue. NEVER lecture, NEVER list more than two tips, NEVER advise on anything you don't have data for.

WHEN SATELLITE STRESS IS CRITICAL OR SEVERE DROUGHT FORECAST:
• "Hifadhi maji ya ziada wiki hii — mvua inategemewa kupungua." / "Store extra water this week — rain is expected to drop."
• If they reported BCS ≤ 2: "Mifugo wenye mbavu zinaonekana wahamishe karibu na maji ili kupunguza safari." / "Move the thin animals closer to water to shorten the trek."
• If they reported early offtake or are considering: "Kuuza mapema wakati wa ukame ni hekima — bei iko bora kabla ya wengine kuuza." / "Selling early in drought makes sense — prices are better before everyone else sells."

WHEN A WATER POINT THEY USE IS NOT_OPERATIONAL OR DRY:
• Point them to the NEXT NEAREST water point from the PROXIMITY CHEAT-SHEET by name and approximate km, and say it specifically.

WHEN THEY REPORTED MORTALITY OR REDUCED MILK:
• "Tafadhali angalia chumvi-madini na chanjo kwa wiki hii — udhaifu hupelekea magonjwa haraka." / "Watch mineral salt and vaccinations this week — weakness invites disease fast."

WHEN WARD ROLLUP SHOWS OTHER HERDERS REPORTING THE SAME ISSUE:
• Mention it briefly to validate them — "wachungaji wengine karibu nawe wameripoti hali kama hii" / "other herders near you have reported the same."

WHEN STRESS IS MILD / NONE:
• Confirm the good news: "Hali bado ni nzuri katika eneo lako — endelea kufuatilia." / "Conditions are still good in your area — keep watching."

THEN, AND ONLY THEN — WRAP UP AND END THE CALL:
- Say a warm, natural goodbye in their language ("Asante sana, kwaheri" / "Thank you, take care").
- DO NOT keep talking after the goodbye. DO NOT ask "anything else?".
- IMMEDIATELY after speaking the goodbye, INVOKE the \`end_call\` tool with a one-sentence \`reason\`. The tool will hang up the line gracefully — this saves the herder's time and our airtime.
- If the herder is clearly unable or unwilling to continue (refuses, says they must go, line is too noisy, dead silence after two prompts), give whatever advice you can in one sentence, say a brief goodbye, then invoke \`end_call\` with the appropriate reason. Never linger.
`;
}
