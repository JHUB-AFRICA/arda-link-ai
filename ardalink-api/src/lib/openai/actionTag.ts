/**
 * Post-call action tagging — a 2-4 word classification of what the
 * herder reported, via the LLM registry with a keyword-classifier
 * fallback so tagging never fails even without an LLM available.
 */

import { logger } from "../logger.js";
import { complete } from "../llm/index.js";
import type { VegetationDelta } from "../baseline.js";

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
