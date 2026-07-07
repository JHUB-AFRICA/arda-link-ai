/**
 * Small helper — updates `pastoralists.last_contact_at` after any
 * ArdaLink-initiated contact (voice call, USSD dial-in, SMS reply, etc.).
 * Used by the deterministic voice pipeline so the operator dashboard's
 * "last spoken with" column stays fresh.
 *
 * No-ops on browser demo phones (they don't map to a real pastoralist).
 */

import { eq } from "drizzle-orm";
import { db, pastoralistsTable } from "@workspace/db";
import { logger } from "./logger.js";

export async function touchPastoralistLastContact(
  phone: string | null | undefined,
): Promise<void> {
  if (!phone) return;
  if (phone.startsWith("browser-")) return;

  const normalized = phone.replace(/\s+/g, "").trim();
  if (!normalized) return;

  try {
    await db
      .update(pastoralistsTable)
      .set({ lastContactAt: new Date() })
      .where(eq(pastoralistsTable.phone, normalized));
  } catch (err) {
    logger.warn(
      { err, phone: normalized },
      "Failed to update pastoralist last_contact_at",
    );
  }
}
