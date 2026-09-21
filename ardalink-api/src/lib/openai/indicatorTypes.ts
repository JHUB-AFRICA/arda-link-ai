/**
 * Globally-validated livestock-stress indicator taxonomy, shared by
 * `extractIndicators()` (this package) and downstream ground-truth
 * mapping (`groundTruthMapping.ts`, `trustScore.ts`).
 */

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
