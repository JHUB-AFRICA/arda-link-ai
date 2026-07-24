/**
 * lead_interactions — audit trail for every herder-facing surface hit.
 *
 * Local mirror of Supabase-primary `lead_interactions` (migration
 * `0003_realign_local_mirror`). One row per USSD screen / SMS reply /
 * voice-call stage; the ops CallbackLog panel reads these newest-first.
 * `raw_body` captures the AT webhook payload so we can replay if the
 * downstream extractor changes.
 */

import {
  pgTable,
  uuid,
  text,
  jsonb,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export type LeadInteractionChannel = "ussd" | "sms" | "voice" | "voice_event";
export type LeadInteractionTier = "verified" | "lead" | "unknown";

export const leadInteractionsTable = pgTable(
  "lead_interactions",
  {
    interactionId: uuid("interaction_id").primaryKey().defaultRandom(),
    phoneNumber: text("phone_number").notNull(),
    tier: text("tier").$type<LeadInteractionTier>(),
    channel: text("channel").$type<LeadInteractionChannel>().notNull(),
    sessionId: text("session_id"),
    keyword: text("keyword"),
    inputText: text("input_text"),
    replyText: text("reply_text"),
    wardId: text("ward_id"),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    rawBody: jsonb("raw_body"),
    tenantId: text("tenant_id"),
  },
  (t) => ({
    phoneIdx: index("lead_interactions_phone_idx").on(
      t.phoneNumber,
      t.occurredAt,
    ),
    wardIdx: index("lead_interactions_ward_id_idx").on(t.wardId),
    tenantIdx: index("lead_interactions_tenant_id_idx").on(t.tenantId),
  }),
);

export const insertLeadInteractionSchema = createInsertSchema(
  leadInteractionsTable,
).omit({
  interactionId: true,
  occurredAt: true,
});

export type InsertLeadInteraction = z.infer<typeof insertLeadInteractionSchema>;
export type LeadInteraction = typeof leadInteractionsTable.$inferSelect;
