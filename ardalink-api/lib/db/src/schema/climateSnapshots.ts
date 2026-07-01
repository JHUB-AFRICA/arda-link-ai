import { pgTable, serial, timestamp, jsonb, text, index } from "drizzle-orm/pg-core";

export const climateSnapshotsTable = pgTable(
  "climate_snapshots",
  {
    id: serial("id").primaryKey(),
    capturedAt: timestamp("captured_at").defaultNow().notNull(),
    climate: jsonb("climate").notNull(),
    forecast: jsonb("forecast"),
    // Phase 12 — added to match the Postgres column from
    // 0000_base_schema.up.sql. Same RLS rationale as satellite_snapshots.
    tenantId: text("tenant_id").notNull().default("isiolo"),
  },
  (t) => ({
    tenantIdx: index("climate_snapshots_tenant_id_idx_drizzle").on(t.tenantId),
  }),
);

export type ClimateSnapshotRow = typeof climateSnapshotsTable.$inferSelect;
