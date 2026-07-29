/**
 * weather_data — daily observations mirrored from Open-Meteo.
 *
 * Local mirror of Supabase-primary `weather_data` (migration
 * `0003_realign_local_mirror`). Unique on (ward_id, observed_date,
 * source) so multi-source days (open-meteo + supabase-sync) don't
 * collide. Rainfall is rolling 30-day.
 */

import {
  pgTable,
  bigserial,
  text,
  numeric,
  date,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const weatherDataTable = pgTable(
  "weather_data",
  {
    weatherDataId: bigserial("weather_data_id", { mode: "number" }).primaryKey(),
    wardId: text("ward_id").notNull(),
    observedDate: date("observed_date").notNull(),
    rainfallMm30d: numeric("rainfall_mm_30d"),
    humidityPct: numeric("humidity_pct"),
    temperatureC: numeric("temperature_c"),
    evapotranspirationMm: numeric("evapotranspiration_mm"),
    source: text("source"),
    tenantId: text("tenant_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    wardDateIdx: index("weather_data_ward_date_idx").on(t.wardId, t.observedDate),
    tenantIdx: index("weather_data_tenant_id_idx").on(t.tenantId),
    uniqWardDateSource: uniqueIndex("weather_data_ward_date_source_uniq").on(
      t.wardId,
      t.observedDate,
      t.source,
    ),
  }),
);

export const insertWeatherDataSchema = createInsertSchema(weatherDataTable).omit(
  {
    weatherDataId: true,
    createdAt: true,
    updatedAt: true,
  },
);

export type InsertWeatherData = z.infer<typeof insertWeatherDataSchema>;
export type WeatherData = typeof weatherDataTable.$inferSelect;
