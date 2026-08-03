/**
 * Audit trail for the operator data-management console — see migration
 * 0008's header for the full rationale. Every write endpoint the console
 * exposes (water-node edits, species-ring-radii tuning, ground-truth
 * corrections, pastoralist edits, lead actions) calls recordAudit()
 * around its own write, no exceptions. This module never throws —
 * a failed audit write must never block or roll back the actual
 * operation it's recording (logged instead, same fail-soft posture as
 * grazingRingPending.ts).
 */

import { db, adminAuditLogTable } from "@workspace/db";
import { logger } from "./logger.js";

export interface AuditEntry {
  actorSub: string;
  tenantId: string;
  resource: string;
  resourceId: string;
  action: "create" | "update" | "delete" | "verify" | "correct";
  before?: unknown;
  after?: unknown;
  reason?: string | null;
}

export async function recordAudit(entry: AuditEntry): Promise<void> {
  try {
    await db.insert(adminAuditLogTable).values({
      actorSub: entry.actorSub,
      tenantId: entry.tenantId,
      resource: entry.resource,
      resourceId: entry.resourceId,
      action: entry.action,
      before: entry.before ?? null,
      after: entry.after ?? null,
      reason: entry.reason ?? null,
    });
  } catch (err) {
    logger.error({ err, entry }, "[AdminAudit] recordAudit failed");
  }
}
