import { pgTable, serial, timestamp, jsonb } from "drizzle-orm/pg-core";

export const climateSnapshotsTable = pgTable("climate_snapshots", {
  id: serial("id").primaryKey(),
  capturedAt: timestamp("captured_at").defaultNow().notNull(),
  climate: jsonb("climate").notNull(),
  forecast: jsonb("forecast"),
});

export type ClimateSnapshotRow = typeof climateSnapshotsTable.$inferSelect;
