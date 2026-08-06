import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * WhatsApp self-registration state between separate stateless webhook
 * turns — mirrors USSD's Jisajili flow (name -> ward -> language ->
 * save). One row per phone (overwritten on repeat attempts).
 * Local-mirror only — never synced to/from Supabase, same as
 * grazing_ring_pending (migration 0006). See migration 0014's header.
 */
export const whatsappRegistrationPendingTable = pgTable(
  "whatsapp_registration_pending",
  {
    phoneNumber: text("phone_number").primaryKey(),
    step: text("step").notNull(),
    draftFullName: text("draft_full_name"),
    draftWardId: text("draft_ward_id"),
    startedAt: timestamp("started_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
);
