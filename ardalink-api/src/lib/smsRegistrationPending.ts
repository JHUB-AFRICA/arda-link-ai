/**
 * Local-mirror access for sms_registration_pending — see migration
 * 0018's header for why this exists. Deliberately minimal compared to
 * whatsappRegistrationPending.ts: SMS's mandatory-registration gate
 * asks for ward only (one round-trip, numbered picker), not a full
 * name+ward+language flow, so the only state worth tracking is "have
 * we already sent this phone the ward picker." No RLS (phone-keyed
 * ephemeral state, not tenant-scoped operational data), same posture
 * as waterPointFollowupPending.ts.
 */

import { eq } from "drizzle-orm";
import { db, smsRegistrationPendingTable } from "@workspace/db";
import { logger } from "./logger.js";

// An unanswered prompt older than this is stale enough that a bare
// digit arriving later is more likely an unrelated message than a
// ward answer — don't misinterpret it. Generous window since SMS
// round-trips can lag (herder reads it later, poor signal, etc.).
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

export async function markWardPromptSent(phoneNumber: string): Promise<void> {
  try {
    await db
      .insert(smsRegistrationPendingTable)
      .values({ phoneNumber })
      .onConflictDoUpdate({
        target: smsRegistrationPendingTable.phoneNumber,
        set: { promptedAt: new Date() },
      });
  } catch (err) {
    logger.error({ err, phoneNumber }, "[SmsRegistrationPending] mark failed");
  }
}

/** True only if we prompted this phone for its ward AND that prompt is
 * still fresh enough to plausibly be what a bare-digit reply answers. */
export async function isWardPromptPending(phoneNumber: string): Promise<boolean> {
  try {
    const rows = await db
      .select()
      .from(smsRegistrationPendingTable)
      .where(eq(smsRegistrationPendingTable.phoneNumber, phoneNumber))
      .limit(1);
    const row = rows[0];
    if (!row) return false;
    return Date.now() - row.promptedAt.getTime() <= MAX_AGE_MS;
  } catch (err) {
    logger.error({ err, phoneNumber }, "[SmsRegistrationPending] read failed");
    return false;
  }
}

export async function clearWardPrompt(phoneNumber: string): Promise<void> {
  try {
    await db
      .delete(smsRegistrationPendingTable)
      .where(eq(smsRegistrationPendingTable.phoneNumber, phoneNumber));
  } catch (err) {
    logger.error({ err, phoneNumber }, "[SmsRegistrationPending] clear failed");
  }
}
