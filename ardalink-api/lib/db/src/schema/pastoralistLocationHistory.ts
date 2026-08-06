import { pgTable, serial, text, doublePrecision, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * Local mirror of pastoralist_location_history — see migration 0011's
 * header. Source of truth is Supabase; this table backs local dev only.
 * One row per location CHANGE (never updated/deleted), for a lead or a
 * verified pastoralist, keyed by phone_number so history reads as one
 * continuous timeline across a lead's promotion to verified status.
 */
export const pastoralistLocationHistoryTable = pgTable("pastoralist_location_history", {
  id: serial("id").primaryKey(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull(),
  phoneNumber: text("phone_number").notNull(),
  wardId: text("ward_id"),
  locationText: text("location_text"),
  lat: doublePrecision("lat"),
  lon: doublePrecision("lon"),
  source: text("source").notNull(),
  confidence: text("confidence"),
  previousWardId: text("previous_ward_id"),
  previousLocationText: text("previous_location_text"),
  previousLat: doublePrecision("previous_lat"),
  previousLon: doublePrecision("previous_lon"),
  rawMessageText: text("raw_message_text"),
  changedBy: text("changed_by"),
  recordedAt: timestamp("recorded_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const insertPastoralistLocationHistorySchema = createInsertSchema(
  pastoralistLocationHistoryTable,
).omit({
  id: true,
  recordedAt: true,
});

export type InsertPastoralistLocationHistory = z.infer<
  typeof insertPastoralistLocationHistorySchema
>;
export type PastoralistLocationHistory =
  typeof pastoralistLocationHistoryTable.$inferSelect;
