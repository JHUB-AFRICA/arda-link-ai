import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * SMS's mandatory-registration gate state (2026-08-11) — one row per
 * phone, marking that this number has been sent the ward picker and is
 * awaiting a reply. Deliberately minimal compared to WhatsApp/USSD's
 * full name+ward+language flow: SMS costs money per leg for both sides,
 * so the gate asks for ward only (the field that actually unlocks
 * personalized ward-level replies) rather than a 3-step round-trip.
 * Local-mirror only, same posture as water_point_followup_pending /
 * whatsapp_registration_pending — never synced to/from Supabase.
 */
export const smsRegistrationPendingTable = pgTable("sms_registration_pending", {
  phoneNumber: text("phone_number").primaryKey(),
  promptedAt: timestamp("prompted_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});
