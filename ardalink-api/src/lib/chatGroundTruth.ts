import { eq } from "drizzle-orm";
import { db, groundTruthReportsTable } from "@workspace/db";
import { extractIndicators } from "./openai.js";
import { getLastResult } from "./intelligence.js";
import { computeTrustScore } from "./trustScore.js";
import { logger } from "./logger.js";

/**
 * Chat ground-truth capture.
 *
 * After each /api/talk-chat exchange, we run the same indicator extractor
 * the voice bridge uses against the full chat transcript, then upsert one
 * row per chat session into ground_truth_reports.
 *
 * "Upsert" here is a SELECT-by-session_id + UPDATE-or-INSERT. There is no
 * unique constraint on session_id (the column existed before this feature),
 * so two concurrent messages in the same session could race and produce
 * two rows. Acceptable for a demo — the analytics layer dedupes by
 * (sessionId, max(created_at)) anyway.
 *
 * This runs as fire-and-forget from the route handler: never awaited, never
 * surfaced to the user. Failures are logged but don't fail the chat reply.
 */

interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export async function captureChatGroundTruth(opts: {
  sessionId: string;
  phone: string | null;
  turns: ChatTurn[];
}): Promise<void> {
  const { sessionId, phone, turns } = opts;
  if (!sessionId || turns.length === 0) return;

  try {
    const transcript = turns
      .map((t) => `${t.role === "user" ? "User" : "ArdaLink"}: ${t.content}`)
      .join("\n");

    const last = getLastResult();
    const month =
      last?.month_name ??
      new Date().toLocaleString("en", { month: "short" }).toUpperCase();

    const indicators = await extractIndicators(transcript);
    const ind = indicators;
    const completenessPct = ind ? (ind.indicators_collected / 7) * 100 : null;

    // Satellite + climate snapshot at moment of last message
    const ndvi = last?.delta?.NDVI.live ?? null;
    const ndviPct = last?.delta?.NDVI.delta_pct ?? null;
    const cl30 = last?.climate?.rolling30Day;
    const rainfall = cl30?.totalPrecipMm ?? null;
    const et0 = cl30?.totalET0Mm ?? null;
    const soilMoisture = cl30?.meanSoilMoisture ?? null;
    const ratio =
      rainfall != null && et0 != null && et0 > 0 ? rainfall / et0 : null;

    // Trust score — chat sessions don't have a meaningful "duration" the
    // way voice does, so pass 0. The trust model already penalises low
    // indicator counts and BCS uncertainty; reports below ~60 are flagged
    // for review regardless of channel.
    const wardAnomalyPct = last?.live?.anomaly?.NDVI?.p50 ?? null;
    const trust = computeTrustScore({
      indicators: ind,
      wardAnomalyPct,
      callDurationSeconds: 0,
      endReason: "unknown",
    });

    // Cheap action tag — first user line, truncated. Avoids a second LLM
    // call per chat turn just to label the row.
    const firstUserLine =
      turns.find((t) => t.role === "user")?.content?.trim() ?? "";
    const actionTag =
      firstUserLine.length > 0
        ? `Chat — ${firstUserLine.slice(0, 80)}`
        : "Chat session";

    const values = {
      sessionId,
      phone: phone ?? "browser-chat",
      month,
      timestamp: new Date(),
      satelliteMetrics: last?.delta ?? null,
      aiQuestion: "(Public /talk chat session)",
      userFeedback: transcript,
      actionTag,
      recordingUrl: null,
      durationSeconds: null,
      bcsScore: ind?.bcs_score ?? null,
      bcsRawResponse: ind?.bcs_raw_response ?? null,
      bcsSpecies: ind?.bcs_species ?? null,
      bcsConfidence: ind?.bcs_confidence ?? null,
      bcsFlagFollowup: ind?.bcs_flag_followup ?? null,
      offtakeRate: ind?.offtake_rate ?? null,
      offtakeRawResponse: ind?.offtake_raw_response ?? null,
      mortalityRate: ind?.mortality_rate ?? null,
      mortalityRawResponse: ind?.mortality_raw_response ?? null,
      milkProduction: ind?.milk_production ?? null,
      milkRawResponse: ind?.milk_raw_response ?? null,
      waterTrekkingDistance: ind?.water_trekking_distance ?? null,
      waterTrekkingRaw: ind?.water_trekking_raw ?? null,
      waterPointName: ind?.water_point_name ?? null,
      waterPointStatus: ind?.water_point_status ?? null,
      waterPointRawResponse: ind?.water_point_raw_response ?? null,
      supplementaryFeeding: ind?.supplementary_feeding ?? null,
      supplementaryRawResponse: ind?.supplementary_raw_response ?? null,
      reportedQuadrant: ind?.reported_quadrant ?? null,
      reportedLocation: ind?.reported_location ?? null,
      ndviScore: ndvi,
      ndviVsBaselinePercent: ndviPct,
      rainfall30dayMm: rainfall,
      soilMoistureIndex: soilMoisture,
      evaporationRate: et0,
      rainfallEvapRatio: ratio,
      indicatorsCollected: ind?.indicators_collected ?? null,
      dataCompletenessPercent: completenessPct,
      callDurationSeconds: null,
      trustScore: trust.score,
      trustFlags: trust.flags,
    };

    const existing = await db
      .select({ id: groundTruthReportsTable.id })
      .from(groundTruthReportsTable)
      .where(eq(groundTruthReportsTable.sessionId, sessionId))
      .limit(1);

    if (existing.length > 0) {
      await db
        .update(groundTruthReportsTable)
        .set(values)
        .where(eq(groundTruthReportsTable.id, existing[0].id));
      logger.info(
        {
          sessionId,
          phone: phone ?? "(anon)",
          rowId: existing[0].id,
          indicatorsCollected: ind?.indicators_collected ?? 0,
          trustScore: trust.score,
        },
        "[ChatGroundTruth] updated existing session report",
      );
    } else {
      const [row] = await db
        .insert(groundTruthReportsTable)
        .values(values)
        .returning({ id: groundTruthReportsTable.id });
      logger.info(
        {
          sessionId,
          phone: phone ?? "(anon)",
          rowId: row?.id,
          indicatorsCollected: ind?.indicators_collected ?? 0,
          trustScore: trust.score,
        },
        "[ChatGroundTruth] inserted new session report",
      );
    }
  } catch (err) {
    logger.warn(
      { err, sessionId, phone: phone ?? "(anon)" },
      "[ChatGroundTruth] capture failed (chat reply unaffected)",
    );
  }
}
