import { pgTable, serial, text, jsonb, timestamp } from "drizzle-orm/pg-core";

/**
 * Audit trail for the operator data-management console. Every write
 * endpoint (water-node edits, species-ring-radii tuning, ground-truth
 * corrections, pastoralist edits, lead actions) records one row here.
 * Pure audit trail — nothing reads this back to reconstruct a resource's
 * current state, only to answer "who changed what, when, why."
 */
export const adminAuditLogTable = pgTable("admin_audit_log", {
  id: serial("id").primaryKey(),
  actorSub: text("actor_sub").notNull(),
  tenantId: text("tenant_id").notNull(),
  resource: text("resource").notNull(),
  resourceId: text("resource_id").notNull(),
  action: text("action").notNull(),
  before: jsonb("before"),
  after: jsonb("after"),
  reason: text("reason"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});
