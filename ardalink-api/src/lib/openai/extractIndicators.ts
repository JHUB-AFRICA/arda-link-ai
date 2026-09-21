/**
 * Post-call indicator extraction. After a herder conversation ends,
 * run the full transcript through the LLM registry to extract
 * globally-validated livestock-stress indicators:
 *   - BCS (ILRI/FAO Tropical 1–5)        — primary, every call
 *   - Offtake (FEWS NET)                  — secondary
 *   - Mortality (LEGS/FAO)                — secondary
 *   - Milk production (ILRI EW)           — secondary
 *   - Trekking distance (FAO AWG)         — secondary
 *   - Water point status                  — secondary
 *   - Supplementary feeding (WFP CSI)     — secondary
 *
 * All fields are nullable — extractor must not hallucinate. Unknown = null.
 */

import { logger } from "../logger.js";
import { complete } from "../llm/index.js";
import { sanitizeJsonString } from "./jsonUtils.js";
import type { ExtractedIndicators } from "./indicatorTypes.js";

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
