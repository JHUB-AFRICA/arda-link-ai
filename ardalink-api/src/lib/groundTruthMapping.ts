/**
 * Shared mapping from `ExtractedIndicators` (the LLM extractor's
 * categorical-bucket output) to a `ground_truth_calls` insert row.
 *
 * Factored out of `voiceDeterministicPipeline.ts`'s `writeSupabaseMirror()`
 * so the WhatsApp channel (and any future text channel) can write the
 * same shape without duplicating the bucket→proportion conversions —
 * Supabase's `mortality_rate`/`offtake_rate` columns are proportions in
 * [0,1] and `water_trek_distance_km` is a plain km figure, while the
 * extractor only ever returns categorical buckets ("1-3", "under_5km",
 * etc). The representative-value mapping below is the single source of
 * truth for that conversion.
 */

import type { ExtractedIndicators } from "./openai.js";
import type { SbGroundTruthCallInsert } from "./supabase.js";

export interface GroundTruthMappingInput {
  pastoralistId: string;
  wardId: string;
  indicators: ExtractedIndicators | null;
  /** 0-100 scale, as produced by computeTrustScore(). */
  trustScore: number | null;
  transcript: string;
  sourceLanguage: string;
  channel: "voice" | "sms" | "ussd" | "whatsapp";
}

export function mapExtractedIndicatorsToGroundTruthRow(
  input: GroundTruthMappingInput,
): SbGroundTruthCallInsert {
  const { indicators } = input;

  const trekDistanceKm =
    indicators?.water_trekking_distance === "under_5km"
      ? 2.5
      : indicators?.water_trekking_distance === "5-10km"
        ? 7.5
        : indicators?.water_trekking_distance === "over_10km"
          ? 12
          : null;

  // Supabase mortality_rate + offtake_rate are proportions (0-1). Our
  // extractor returns categorical buckets; map them to representative
  // rates within [0,1] so the CHECK constraints pass.
  const mortalityRate =
    indicators?.mortality_rate === "4-plus"
      ? 0.15
      : indicators?.mortality_rate === "1-3"
        ? 0.05
        : indicators?.mortality_rate === "none"
          ? 0
          : null;

  const offtakeRate =
    indicators?.offtake_rate === "early"
      ? 0.6
      : indicators?.offtake_rate === "normal"
        ? 0.3
        : indicators?.offtake_rate === "not_selling"
          ? 0
          : null;

  // Supabase trust_score is a proportion [0,1]; our local score is 0-100.
  const trustScoreNorm =
    input.trustScore != null
      ? Math.max(0, Math.min(1, input.trustScore / 100))
      : null;

  return {
    pastoralist_id: input.pastoralistId,
    ward_id: input.wardId,
    call_timestamp: new Date().toISOString(),
    bcs_score: indicators?.bcs_score ?? null,
    mortality_rate: mortalityRate,
    offtake_rate: offtakeRate,
    water_point_status: indicators?.water_point_status ?? null,
    water_trek_distance_km: trekDistanceKm,
    supplementary_feeding:
      indicators?.supplementary_feeding === "yes"
        ? true
        : indicators?.supplementary_feeding === "no"
          ? false
          : null,
    trust_score: trustScoreNorm,
    source_language: input.sourceLanguage,
    transcript: input.transcript,
    channel: input.channel,
  };
}
