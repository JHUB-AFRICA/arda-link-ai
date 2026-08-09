/**
 * Local-mirror access for water_point_followup_pending — see migration
 * 0017's header for why this table exists (remembering which unsurveyed
 * water point we last recommended to a herder, so a LATER turn can ask
 * naturally whether it panned out, instead of surveying them in the
 * same breath as the recommendation). No RLS (phone-keyed ephemeral
 * state, not tenant-scoped operational data), so plain `db` calls, same
 * convention as grazingRingPending.ts.
 */

import { eq } from "drizzle-orm";
import { db, waterPointFollowupPendingTable } from "@workspace/db";
import { logger } from "./logger.js";

// A herder needs real time to travel and check before a "did you find
// water?" question means anything — asking immediately would just be
// the same same-turn survey this mechanism exists to avoid.
const MIN_AGE_MS = 20 * 60 * 1000;
// Beyond this, the recommendation is stale enough that asking about it
// reads as random/confusing rather than a natural check-in.
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface PendingWaterPointFollowup {
  waterPointName: string;
}

/**
 * Record that we just recommended `waterPointName` to this herder.
 * Fire-and-forget — overwrites any earlier pending recommendation for
 * the same phone (matches grazingRingPending's "one row per phone,
 * latest wins" convention).
 */
export async function upsertWaterPointFollowup(
  phoneNumber: string,
  waterPointName: string,
): Promise<void> {
  try {
    await db
      .insert(waterPointFollowupPendingTable)
      .values({ phoneNumber, waterPointName })
      .onConflictDoUpdate({
        target: waterPointFollowupPendingTable.phoneNumber,
        set: { waterPointName, recommendedAt: new Date() },
      });
  } catch (err) {
    logger.error({ err, phoneNumber }, "[WaterPointFollowup] upsert failed");
  }
}

/**
 * Returns the pending recommendation if one exists and is old enough to
 * plausibly ask about (>= 20 min) but not so old it's no longer
 * relevant (< 24h) — null in every other case, including "no row at
 * all". Does NOT clear it — call clearWaterPointFollowup() once the
 * check-in has actually been surfaced this turn.
 */
export async function getWaterPointFollowup(
  phoneNumber: string,
): Promise<PendingWaterPointFollowup | null> {
  try {
    const rows = await db
      .select()
      .from(waterPointFollowupPendingTable)
      .where(eq(waterPointFollowupPendingTable.phoneNumber, phoneNumber))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    const ageMs = Date.now() - row.recommendedAt.getTime();
    if (ageMs < MIN_AGE_MS || ageMs > MAX_AGE_MS) return null;
    return { waterPointName: row.waterPointName };
  } catch (err) {
    logger.error({ err, phoneNumber }, "[WaterPointFollowup] read failed");
    return null;
  }
}

export async function clearWaterPointFollowup(phoneNumber: string): Promise<void> {
  try {
    await db
      .delete(waterPointFollowupPendingTable)
      .where(eq(waterPointFollowupPendingTable.phoneNumber, phoneNumber));
  } catch (err) {
    logger.error({ err, phoneNumber }, "[WaterPointFollowup] clear failed");
  }
}
