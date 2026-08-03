import { pgTable, text, doublePrecision, timestamp } from "drizzle-orm/pg-core";

/**
 * WhatsApp species-capture state between two webhook turns: a herder
 * shares GPS location, we ask which species they graze (3 buttons), and
 * this table holds the location while we wait for the button reply.
 * One row per phone (overwritten on repeat shares). Local-mirror only —
 * never synced to/from Supabase (see migration 0006's header).
 */
export const grazingRingPendingTable = pgTable("grazing_ring_pending", {
  phoneNumber: text("phone_number").primaryKey(),
  lat: doublePrecision("lat").notNull(),
  lon: doublePrecision("lon").notNull(),
  requestedAt: timestamp("requested_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  tenantId: text("tenant_id"),
});
