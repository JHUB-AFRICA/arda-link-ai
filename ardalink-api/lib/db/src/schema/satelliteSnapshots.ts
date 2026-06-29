import { pgTable, serial, timestamp, jsonb, text } from "drizzle-orm/pg-core";

export const satelliteSnapshotsTable = pgTable("satellite_snapshots", {
  id: serial("id").primaryKey(),
  capturedAt: timestamp("captured_at").defaultNow().notNull(),
  newestImageDate: text("newest_image_date").notNull(),
  result: jsonb("result").notNull(),
});

export type SatelliteSnapshot = typeof satelliteSnapshotsTable.$inferSelect;
