import { pgTable, serial, timestamp, jsonb, text, index } from "drizzle-orm/pg-core";

export const satelliteSnapshotsTable = pgTable(
  "satellite_snapshots",
  {
    id: serial("id").primaryKey(),
    capturedAt: timestamp("captured_at").defaultNow().notNull(),
    newestImageDate: text("newest_image_date").notNull(),
    result: jsonb("result").notNull(),
    // Phase 12 — added to match the Postgres column from
    // 0000_base_schema.up.sql. Without this, the api's insert() call
    // omits the column and the row's tenant_id defaults to NULL,
    // failing the RLS `tenant_isolation` policy on every write.
    tenantId: text("tenant_id").notNull().default("isiolo"),
  },
  (t) => ({
    tenantIdx: index("satellite_snapshots_tenant_id_idx_drizzle").on(t.tenantId),
  }),
);

export type SatelliteSnapshot = typeof satelliteSnapshotsTable.$inferSelect;
