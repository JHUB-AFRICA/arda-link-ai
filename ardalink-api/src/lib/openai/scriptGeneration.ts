/**
 * Voice-call opening script generation — AI via the LLM registry, with
 * a deterministic template fallback so the call never fails even if
 * every provider is down/budget-exceeded.
 */

import { logger } from "../logger.js";
import { complete, type LlmResponse } from "../llm/index.js";
import type { VegetationDelta } from "../baseline.js";
import { sanitizeJsonString } from "./jsonUtils.js";

export interface PixelContext {
  wardStressedPixelPct: number; // % pixels >15% below own history
  medianAnomalyPct: number; // p50 NDVI anomaly
  p5AnomalyPct: number; // worst 5% of pixels
  worstQuadrant: string;
  historicalImageCount: number;
  /** Satellite GEE VCI data — if available from engine */
  satellite?: {
    vci: number; // Vegetation Condition Index (0-100)
    droughtClass: string; // "no_drought" | "mild" | "moderate" | "severe" | "extreme"
    ndviVsBaseline: number; // % change from historical baseline
    imageFreshness: string; // "X days ago" or date
    urbanMasked: boolean; // whether urban areas were masked
    prosopisFactor: number; // invasive shrub correction factor
  };
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

  // VCI data line — from GEE engine (when available)
  let vciLine = "";
  if (px?.satellite) {
    const sat = px.satellite;
    const vci = sat.vci.toFixed(1);
    const ndviDelta = sat.ndviVsBaseline.toFixed(0);
    const vciSwahili =
      sat.droughtClass === "extreme"
        ? "bukoa kali sana"
        : sat.droughtClass === "severe"
          ? "bukoa kali"
          : sat.droughtClass === "moderate"
            ? "bukoa ya kati"
            : sat.droughtClass === "mild"
              ? "bukoa ndogo"
              : "hali ya wastani";

    vciLine =
      `Kwa mujibu wa data ya Google Earth Engine, ` +
      `VCI (Vegetation Condition Index) ni ${vci}/100. ` +
      `Hali ya ukame wa majani ni ${vciSwahili}. ` +
      (sat.ndviVsBaseline < 0
        ? `NDVI imeshuka ${ndviDelta}% chini ya kipindi kile hicho. `
        : `NDVI ni juu ya kipindi kile hicho kwa ${ndviDelta}%. `) +
      (sat.imageFreshness ? `Picha hii ya satellite ni ya ${sat.imageFreshness}. ` : "");
  }

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
    vciLine +
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
  const sat = px?.satellite;

  const satelliteLines = sat
    ? `\nGoogle Earth Engine VCI data:
- VCI (Vegetation Condition Index): ${sat.vci.toFixed(1)}/100 (${sat.droughtClass} drought)
- NDVI vs baseline: ${sat.ndviVsBaseline.toFixed(1)}% ${sat.ndviVsBaseline < 0 ? "below" : "above"} historical max
- Image freshness: ${sat.imageFreshness}
- Urban areas masked: ${sat.urbanMasked ? "yes" : "no"} | Prosopis factor: ${sat.prosopisFactor.toFixed(2)}`
    : "";

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

Ward-mean vs the engine's aggregate baseline:
- NDVI: ${delta.NDVI.live.toFixed(3)} (${ndviPct > 0 ? "+" : ""}${ndviPct.toFixed(1)}%)
- NDRE: ${delta.NDRE.live.toFixed(3)} (${delta.NDRE.delta_pct > 0 ? "+" : ""}${delta.NDRE.delta_pct.toFixed(1)}%)
- Red Edge: ${delta.RED_EDGE.live.toFixed(3)} (${rePct > 0 ? "+" : ""}${rePct.toFixed(1)}%)${pixelLines}${satelliteLines}${climateLines}${forecastLines}

Return JSON: {"script": "<45-second Swahili/English opening — weave in satellite VCI, climate, and forecast naturally>", "question": "<one specific question calibrated to severity and the worst quadrant>"}`,
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
