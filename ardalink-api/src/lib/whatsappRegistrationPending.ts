/**
 * Local-mirror access for whatsapp_registration_pending — see migration
 * 0014's header for why this table exists (WhatsApp webhook turns carry
 * no accumulated state like USSD's AT payload does, so the in-progress
 * registration draft has to be persisted here between turns). No RLS on
 * this table (phone-keyed ephemeral state, not tenant-scoped operational
 * data), so plain `db` calls — same posture as grazingRingPending.ts.
 */

import { eq } from "drizzle-orm";
import { db, whatsappRegistrationPendingTable } from "@workspace/db";
import { logger } from "./logger.js";

export type RegistrationStep = "ask_name" | "ask_ward" | "ask_language";

export interface RegistrationDraft {
  step: RegistrationStep;
  draftFullName: string | null;
  draftWardId: string | null;
}

/** Start (or restart) a registration flow for this phone at ask_name. */
export async function startRegistration(phoneNumber: string): Promise<void> {
  try {
    await db
      .insert(whatsappRegistrationPendingTable)
      .values({ phoneNumber, step: "ask_name" })
      .onConflictDoUpdate({
        target: whatsappRegistrationPendingTable.phoneNumber,
        set: {
          step: "ask_name",
          draftFullName: null,
          draftWardId: null,
          startedAt: new Date(),
          updatedAt: new Date(),
        },
      });
  } catch (err) {
    logger.error({ err, phoneNumber }, "[WhatsappRegistrationPending] start failed");
  }
}

export async function getRegistrationState(
  phoneNumber: string,
): Promise<RegistrationDraft | null> {
  try {
    const rows = await db
      .select()
      .from(whatsappRegistrationPendingTable)
      .where(eq(whatsappRegistrationPendingTable.phoneNumber, phoneNumber))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      step: row.step as RegistrationStep,
      draftFullName: row.draftFullName,
      draftWardId: row.draftWardId,
    };
  } catch (err) {
    logger.error({ err, phoneNumber }, "[WhatsappRegistrationPending] read failed");
    return null;
  }
}

export async function advanceRegistrationState(
  phoneNumber: string,
  patch: Partial<{
    step: RegistrationStep;
    draftFullName: string | null;
    draftWardId: string | null;
  }>,
): Promise<void> {
  try {
    await db
      .update(whatsappRegistrationPendingTable)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(whatsappRegistrationPendingTable.phoneNumber, phoneNumber));
  } catch (err) {
    logger.error(
      { err, phoneNumber },
      "[WhatsappRegistrationPending] advance failed",
    );
  }
}

export async function clearRegistrationState(phoneNumber: string): Promise<void> {
  try {
    await db
      .delete(whatsappRegistrationPendingTable)
      .where(eq(whatsappRegistrationPendingTable.phoneNumber, phoneNumber));
  } catch (err) {
    logger.error(
      { err, phoneNumber },
      "[WhatsappRegistrationPending] clear failed",
    );
  }
}
