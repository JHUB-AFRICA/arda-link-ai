/**
 * LLM-backed content generation barrel — re-exports the full public
 * surface of the domain modules in this directory. External callers
 * should always import from here (`./openai/index.js`), never reach
 * into a leaf module directly.
 *
 * Split out of a single 854-line `openai.ts` into
 * scriptGeneration/actionTag/extractIndicators/indicatorTypes/
 * voicePrompt/jsonUtils, mirroring the `src/lib/llm/` barrel pattern
 * already used in this codebase. `extractIndicators` and
 * `generateActionTag` keep their exact original signatures — both have
 * wide import blast radius (9 and 6 importers respectively).
 */

export {
  type PixelContext,
  type GeneratedScript,
  generateScript,
} from "./scriptGeneration.js";

export { generateActionTag } from "./actionTag.js";

export {
  type BcsConfidence,
  type BcsSpecies,
  type OfftakeRate,
  type MortalityRate,
  type MilkProduction,
  type WaterTrekkingDistance,
  type WaterPointStatus,
  type SupplementaryFeeding,
  type ReportedQuadrant,
  type ExtractedIndicators,
} from "./indicatorTypes.js";

export { extractIndicators } from "./extractIndicators.js";

export { indicatorCollectionBlock } from "./voicePrompt.js";
