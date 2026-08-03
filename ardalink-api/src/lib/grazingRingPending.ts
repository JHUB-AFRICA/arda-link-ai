/**
 * Local-mirror access for grazing_ring_pending — see migration 0006's
 * header for why this table exists (bridging a herder's location share
 * and their species-button reply across two separate WhatsApp webhook
 * turns). No RLS on this table (it's phone-keyed ephemeral state, not
 * tenant-scoped operational data), so plain `db` calls, no
 * withTenantContext wrapper.
 */

import { eq } from "drizzle-orm";
import { db, grazingRingPendingTable } from "@workspace/db";
import { logger } from "./logger.js";

const STALE_AFTER_MS = 15 * 60 * 1000;

export interface PendingLocation {
  lat: number;
  lon: number;
}

export async function upsertPendingLocation(
  phoneNumber: string,
  lat: number,
  lon: number,
  tenantId: string | null,
): Promise<void> {
  try {
    await db
      .insert(grazingRingPendingTable)
      .values({ phoneNumber, lat, lon, tenantId })
      .onConflictDoUpdate({
        target: grazingRingPendingTable.phoneNumber,
        set: { lat, lon, tenantId, requestedAt: new Date() },
      });
  } catch (err) {
    logger.error({ err, phoneNumber }, "[GrazingRingPending] upsert failed");
  }
}

/**
 * Returns the pending location if one exists and isn't stale (>15 min
 * old — covers a herder who shared location but never tapped a species
 * button). Does NOT clear it — call clearPendingLocation() separately
 * once the advisory has actually been sent.
 */
export async function getPendingLocation(
  phoneNumber: string,
): Promise<PendingLocation | null> {
  try {
    const rows = await db
      .select()
      .from(grazingRingPendingTable)
      .where(eq(grazingRingPendingTable.phoneNumber, phoneNumber))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    const ageMs = Date.now() - row.requestedAt.getTime();
    if (ageMs > STALE_AFTER_MS) return null;
    return { lat: row.lat, lon: row.lon };
  } catch (err) {
    logger.error({ err, phoneNumber }, "[GrazingRingPending] read failed");
    return null;
  }
}

export async function clearPendingLocation(phoneNumber: string): Promise<void> {
  try {
    await db
      .delete(grazingRingPendingTable)
      .where(eq(grazingRingPendingTable.phoneNumber, phoneNumber));
  } catch (err) {
    logger.error({ err, phoneNumber }, "[GrazingRingPending] clear failed");
  }
}
