import { logger } from "./logger.js";

/**
 * Trust scoring v1 for ground-truth reports.
 *
 * Each report starts at 100 and is debited for signals that make the data
 * less reliable. Floor at 0, cap at 100. Reports below ~60 should be
 * human-reviewed before being rolled into headline metrics.
 *
 * Penalties capture three classes of risk:
 *   1. Call-quality risk — call too short, no real indicators extracted,
 *      caller never spoke (timeout).
 *   2. Internal-consistency risk — the caller's answers contradict each
 *      other (e.g. "animals are fat" + "4+ died this week").
 *   3. Satellite-consistency risk — the caller's answers contradict the
 *      remote-sensing reading by a wide margin. We do NOT discard these
 *      reports (the whole point of ground truth is to catch satellite
 *      errors), but they get flagged for review.
 */

export interface TrustScoreInput {
  indicators: ExtractedIndicatorsShape | null;
  /** Whole-ward NDVI vs baseline %, signed. Negative = stressed. */
  wardAnomalyPct: number | null;
  /** Null when the transport doesn't track duration (e.g. AT path). */
  callDurationSeconds: number | null;
  /** How the call ended — affects trust. */
  endReason:
    | "ai_ended"
    | "user_hangup"
    | "max_duration_reached"
    | "no_speech_timeout"
    | "unknown";
}

/** Loosened mirror of openai.ts ExtractedIndicators (avoid import cycle). */
interface ExtractedIndicatorsShape {
  bcs_score: number | null;
  bcs_species: string | null;
  bcs_confidence: string | null;
  offtake_rate: string | null;
  mortality_rate: string | null;
  milk_production: string | null;
  water_trekking_distance: string | null;
  water_point_status: string | null;
  supplementary_feeding: string | null;
  reported_quadrant: string | null;
  indicators_collected: number;
}

export interface TrustScoreResult {
  score: number;
  flags: string[];
}

export function computeTrustScore(input: TrustScoreInput): TrustScoreResult {
  const flags: string[] = [];
  let score = 100;

  const deduct = (n: number, flag: string): void => {
    score -= n;
    flags.push(flag);
  };

  // ── Hard short-circuit: caller never spoke ────────────────────────────────
  if (input.endReason === "no_speech_timeout") {
    return { score: 0, flags: ["no_speech_detected"] };
  }

  // ── Call quality ──────────────────────────────────────────────────────────
  // Only apply duration-based penalties when we actually know the duration.
  // The AT path doesn't measure it yet, so passing null skips this section
  // rather than auto-flagging every AT report as "too short".
  if (input.callDurationSeconds != null) {
    if (input.callDurationSeconds < 45) {
      deduct(30, "call_too_short");
    } else if (input.callDurationSeconds < 90) {
      deduct(10, "call_brief");
    }
  }

  if (input.endReason === "max_duration_reached") {
    deduct(5, "max_duration_hit");
  }

  // ── Indicator quality ─────────────────────────────────────────────────────
  const ind = input.indicators;
  if (!ind) {
    // No structured indicators extracted at all — extractor failed or
    // transcript was unusable. Heavy penalty but not zero (the raw
    // transcript may still have signal a human can review).
    deduct(50, "no_indicators_extracted");
    return { score: Math.max(0, score), flags };
  }

  if (ind.indicators_collected === 0) {
    deduct(40, "zero_indicators_collected");
  } else if (ind.indicators_collected < 2) {
    deduct(20, "low_indicator_count");
  }

  if (ind.bcs_confidence === "uncertain" || ind.bcs_confidence == null) {
    if (ind.bcs_score == null) deduct(15, "no_bcs");
    else deduct(10, "bcs_uncertain");
  } else if (ind.bcs_confidence === "low") {
    deduct(10, "bcs_low_confidence");
  }

  if (!ind.reported_quadrant || ind.reported_quadrant === "unknown") {
    deduct(10, "no_location");
  }

  if (!ind.bcs_species && ind.bcs_score != null) {
    deduct(5, "no_species");
  }

  // ── Internal contradiction ────────────────────────────────────────────────
  // Animals reported in good condition but dying or milk stopped — one of
  // those reports is wrong.
  if (
    ind.bcs_score != null &&
    ind.bcs_score >= 4 &&
    (ind.mortality_rate === "4-plus" || ind.milk_production === "stopped")
  ) {
    deduct(25, "contradicts_self");
  }

  // Animals visibly stressed (BCS ≤ 2) but herder taking no action and
  // not selling — possible exaggeration or comprehension gap on coping.
  if (
    ind.bcs_score != null &&
    ind.bcs_score <= 2 &&
    ind.offtake_rate === "not_selling" &&
    ind.supplementary_feeding === "no"
  ) {
    deduct(10, "stress_without_coping_action");
  }

  // ── Satellite consistency ─────────────────────────────────────────────────
  if (input.wardAnomalyPct != null) {
    // Ward is severely stressed (≤ -25%) but herder reports robust animals,
    // no supplementary feeding, no mortality — flag for review.
    if (
      input.wardAnomalyPct <= -25 &&
      ind.bcs_score != null &&
      ind.bcs_score >= 4 &&
      (ind.supplementary_feeding === "no" ||
        ind.supplementary_feeding == null) &&
      (ind.mortality_rate === "none" || ind.mortality_rate == null)
    ) {
      deduct(20, "contradicts_satellite_optimistic");
    }
    // Ward looks healthy (≥ 0%) but herder reports emaciated animals —
    // could be a hyperlocal problem the satellite is missing, OR a
    // misreport. Lighter penalty since the ground truth might be the
    // more accurate signal.
    if (
      input.wardAnomalyPct >= 0 &&
      ind.bcs_score != null &&
      ind.bcs_score <= 2
    ) {
      deduct(10, "worse_than_satellite_suggests");
    }
  }

  const finalScore = Math.max(0, Math.min(100, score));
  return { score: finalScore, flags };
}

export function logTrustScore(
  phone: string | null,
  reportId: number | null,
  result: TrustScoreResult,
): void {
  logger.info(
    { phone, reportId, trustScore: result.score, trustFlags: result.flags },
    "[Trust Score] Computed",
  );
}
