import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Implicit ground-truth check-in state between two WhatsApp webhook
 * turns: we recommend an unsurveyed water point to a herder, and this
 * table remembers which one and when so a LATER turn can ask naturally
 * ("did you find water there?") instead of surveying them the moment
 * we recommend it. One row per phone (overwritten on repeat
 * recommendations). Local-mirror only — never synced to/from Supabase
 * (see migration 0017's header).
 */
export const waterPointFollowupPendingTable = pgTable("water_point_followup_pending", {
  phoneNumber: text("phone_number").primaryKey(),
  waterPointName: text("water_point_name").notNull(),
  recommendedAt: timestamp("recommended_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});
