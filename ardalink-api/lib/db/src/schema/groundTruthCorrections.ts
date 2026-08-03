import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Local mirror of ground_truth_corrections — see migration 0009's header.
 * Source of truth is Supabase (matching ground_truth_calls itself); this
 * table backs local dev only. One row per corrected field, referencing
 * the original ground_truth_calls.call_id.
 */
export const groundTruthCorrectionsTable = pgTable("ground_truth_corrections", {
  id: serial("id").primaryKey(),
  callId: text("call_id").notNull(),
  correctedBy: text("corrected_by").notNull(),
  correctedAt: timestamp("corrected_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  field: text("field").notNull(),
  originalValue: text("original_value"),
  correctedValue: text("corrected_value").notNull(),
  reason: text("reason").notNull(),
});
