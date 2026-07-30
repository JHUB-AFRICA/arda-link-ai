import {
  pgTable,
  serial,
  text,
  timestamp,
  integer,
  boolean,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export type PastoralistChannelTier = "whatsapp" | "voice" | "ussd" | "sms";

export const pastoralistsTable = pgTable("pastoralists", {
  id: serial("id").primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  tenantId: text("tenant_id").notNull(),
  name: text("name").notNull(),
  phone: text("phone").notNull(),
  location: text("location").notNull().default(""),
  cattle: integer("cattle").notNull().default(0),
  goats: integer("goats").notNull().default(0),
  camels: integer("camels").notNull().default(0),
  waterSource: text("water_source").notNull().default("Unknown"),
  alertsEnabled: boolean("alerts_enabled").notNull().default(true),
  alertsSent: integer("alerts_sent").notNull().default(0),
  lastContactAt: timestamp("last_contact_at", { withTimezone: true }),
  waId: text("wa_id"),
  channelTier: text("channel_tier").notNull().default("sms"),
  lastTierCheckAt: timestamp("last_tier_check_at", { withTimezone: true }),
});

export const insertPastoralistSchema = createInsertSchema(
  pastoralistsTable,
).omit({
  id: true,
  createdAt: true,
  tenantId: true,
});

export type InsertPastoralist = z.infer<typeof insertPastoralistSchema>;
export type Pastoralist = typeof pastoralistsTable.$inferSelect;
