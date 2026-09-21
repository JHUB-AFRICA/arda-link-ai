/**
 * whatsapp_messages — append-only thread/audit log for the WhatsApp
 * channel.
 *
 * Local mirror of Supabase-primary `whatsapp_messages` (migration
 * `0005_add_whatsapp_support`). Two rows per conversational turn — one
 * 'in', one 'out' — unlike lead_interactions' single-row-per-exchange
 * shape, since WhatsApp's message_type/template_name/session_expires_at
 * fields are richer and direction-specific.
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

export type WhatsappMessageDirection = "in" | "out" | "status";
export type WhatsappMessageType =
  | "text"
  | "template"
  | "interactive_list"
  | "interactive_buttons"
  | "list_reply"
  | "button_reply"
  | "location"
  | "audio"
  | "status";

export const whatsappMessagesTable = pgTable(
  "whatsapp_messages",
  {
    messageId: uuid("message_id").primaryKey().defaultRandom(),
    phoneNumber: text("phone_number").notNull(),
    waId: text("wa_id"),
    // `tier`, `direction`, `messageType` are plain text at the drizzle
    // level; the union types above are for callers to narrow their
    // inputs, matching leadInteractions.ts's convention.
    tier: text("tier"),
    direction: text("direction").notNull(),
    messageType: text("message_type").notNull(),
    templateName: text("template_name"),
    bodyText: text("body_text"),
    sessionExpiresAt: timestamp("session_expires_at", { withTimezone: true }),
    wardId: text("ward_id"),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    rawPayload: jsonb("raw_payload"),
    tenantId: text("tenant_id"),
  },
  (t) => ({
    phoneIdx: index("whatsapp_messages_phone_idx").on(
      t.phoneNumber,
      t.occurredAt,
    ),
    wardIdx: index("whatsapp_messages_ward_id_idx").on(t.wardId),
    tenantIdx: index("whatsapp_messages_tenant_id_idx").on(t.tenantId),
  }),
);

export const insertWhatsappMessageSchema = createInsertSchema(
  whatsappMessagesTable,
).omit({
  messageId: true,
  occurredAt: true,
});

export type InsertWhatsappMessage = z.infer<
  typeof insertWhatsappMessageSchema
>;
export type WhatsappMessage = typeof whatsappMessagesTable.$inferSelect;
