/**
 * pastoralist_leads — self-enrolled herders awaiting ops verification.
 *
 * Local mirror of the Supabase-primary `pastoralist_leads` table
 * created in migration `0003_realign_local_mirror`. Columns match the
 * Supabase source of truth; the PostGIS `location` point column is
 * stored as JSONB (GeoJSON Point) locally so the mirror table doesn't
 * require the postgis extension.
 */

import {
  pgTable,
  uuid,
  text,
  jsonb,
  integer,
  boolean,
  timestamp,
  index,
  doublePrecision,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export interface GeoJsonPoint {
  type: "Point";
  coordinates: [number, number];
}

export const pastoralistLeadsTable = pgTable(
  "pastoralist_leads",
  {
    leadId: uuid("lead_id").primaryKey().defaultRandom(),
    phoneNumber: text("phone_number").notNull(),
    fullName: text("full_name"),
    preferredLanguage: text("preferred_language"),
    wardId: text("ward_id"),
    // JSON GeoPoint at runtime; callers narrow to GeoJsonPoint themselves.
    // Unused for writes (see migration 0012's header) — lat/lon below are
    // the actual current-location pointer this codebase writes to,
    // following the same plain-columns precedent as
    // ground_truth_calls.reported_lat/reported_lon (migration 0007).
    location: jsonb("location"),
    lat: doublePrecision("lat"),
    lon: doublePrecision("lon"),
    locationSource: text("location_source"),
    locationUpdatedAt: timestamp("location_updated_at", { withTimezone: true }),
    herdSize: integer("herd_size"),
    enrollmentSource: text("enrollment_source"),
    status: text("status").notNull().default("lead"),
    alertsEnabled: boolean("alerts_enabled").notNull().default(true),
    firstContactAt: timestamp("first_contact_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastContactAt: timestamp("last_contact_at", { withTimezone: true }),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    verifiedBy: text("verified_by"),
    promotedPastoralistId: uuid("promoted_pastoralist_id"),
    notes: text("notes"),
    tenantId: text("tenant_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    phoneIdx: index("pastoralist_leads_phone_idx").on(t.phoneNumber),
    wardIdx: index("pastoralist_leads_ward_id_idx").on(t.wardId),
    tenantIdx: index("pastoralist_leads_tenant_id_idx").on(t.tenantId),
  }),
);

export const insertPastoralistLeadSchema = createInsertSchema(
  pastoralistLeadsTable,
).omit({
  leadId: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertPastoralistLead = z.infer<typeof insertPastoralistLeadSchema>;
export type PastoralistLead = typeof pastoralistLeadsTable.$inferSelect;
