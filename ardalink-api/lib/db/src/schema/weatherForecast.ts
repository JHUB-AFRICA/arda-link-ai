/**
 * weather_forecast — 14-day ensemble mirrored from Open-Meteo.
 *
 * Local mirror of Supabase-primary `weather_forecast` (migration
 * `0003_realign_local_mirror`). One row per (ward, target_date,
 * generated_at). `raw_response` captures the full ensemble payload so
 * downstream percentile / ET0 changes can re-derive without another
 * upstream call.
 */

import {
  pgTable,
  uuid,
  text,
  numeric,
  date,
  smallint,
  jsonb,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const weatherForecastTable = pgTable(
  "weather_forecast",
  {
    forecastId: uuid("forecast_id").primaryKey().defaultRandom(),
    wardId: text("ward_id").notNull(),
    generatedAt: timestamp("generated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    targetDate: date("target_date").notNull(),
    horizonDays: smallint("horizon_days"),
    rainfallMmP5: numeric("rainfall_mm_p5"),
    rainfallMmP50: numeric("rainfall_mm_p50"),
    rainfallMmP95: numeric("rainfall_mm_p95"),
    precipitationProbability: numeric("precipitation_probability"),
    temperatureCMean: numeric("temperature_c_mean"),
    temperatureCMax: numeric("temperature_c_max"),
    et0Mm: numeric("et0_mm"),
    source: text("source"),
    rawResponse: jsonb("raw_response"),
    tenantId: text("tenant_id"),
  },
  (t) => ({
    wardTargetIdx: index("weather_forecast_ward_target_idx").on(
      t.wardId,
      t.targetDate,
    ),
    tenantIdx: index("weather_forecast_tenant_id_idx").on(t.tenantId),
  }),
);

export const insertWeatherForecastSchema = createInsertSchema(
  weatherForecastTable,
).omit({
  forecastId: true,
  generatedAt: true,
});

export type InsertWeatherForecast = z.infer<typeof insertWeatherForecastSchema>;
export type WeatherForecast = typeof weatherForecastTable.$inferSelect;
