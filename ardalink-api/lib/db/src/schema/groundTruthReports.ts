import {
  pgTable,
  serial,
  text,
  timestamp,
  real,
  integer,
  boolean,
  jsonb,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * ground_truth_reports — every herder voice conversation, plus the
 * structured livestock-stress indicators GPT-4o extracts from each transcript.
 *
 * Indicators follow global standards:
 *   - BCS:         ILRI / FAO Tropical Body Condition Scale (1–5)
 *   - Offtake:     FEWS NET Livestock Indicators
 *   - Mortality:   LEGS / FAO Emergency Guidelines
 *   - Milk:        ILRI Early Warning Indicators
 *   - Trekking:    FAO Animal Welfare Guidelines
 *   - Feeding:     WFP Coping Strategy Index
 *
 * All indicator columns are nullable — old reports remain valid and
 * incomplete new conversations don't break inserts.
 */
export const groundTruthReportsTable = pgTable("ground_truth_reports", {
  id: serial("id").primaryKey(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  sessionId: text("session_id"),
  phone: text("phone"),
  month: text("month").notNull(),
  timestamp: timestamp("timestamp").notNull(),

  // Satellite delta JSON captured at the moment of the call
  satelliteMetrics: jsonb("satellite_metrics"),

  // The AI-generated question asked during the call
  aiQuestion: text("ai_question"),

  // Full transcript ("Herder: …\nArdaLink: …")
  userFeedback: text("user_feedback").notNull(),

  // GPT-4o action tag — short summary classification
  actionTag: text("action_tag").notNull(),

  // Africa's Talking recording (if available)
  recordingUrl: text("recording_url"),
  durationSeconds: integer("duration_seconds"),

  // ── PRIMARY INDICATOR: Body Condition Score ──────────────────────────────
  bcsScore: real("bcs_score"), // 1.0 – 5.0
  bcsRawResponse: text("bcs_raw_response"), // herder's exact words
  bcsSpecies: text("bcs_species"), // cattle|goats|sheep|camels|mixed
  bcsConfidence: text("bcs_confidence"), // high|medium|low|uncertain
  bcsFlagFollowup: boolean("bcs_flag_followup"), // true if uncertain

  // ── SECONDARY INDICATORS ─────────────────────────────────────────────────
  offtakeRate: text("offtake_rate"), // early|normal|not_selling
  offtakeRawResponse: text("offtake_raw_response"),

  mortalityRate: text("mortality_rate"), // none|1-3|4-plus
  mortalityRawResponse: text("mortality_raw_response"),

  milkProduction: text("milk_production"), // normal|reduced|stopped
  milkRawResponse: text("milk_raw_response"),

  waterTrekkingDistance: text("water_trekking_distance"), // under_5km|5-10km|over_10km
  waterTrekkingRaw: text("water_trekking_raw"),

  waterPointName: text("water_point_name"), // matched OSM water point
  waterPointStatus: text("water_point_status"), // operational_good|operational_poor|not_operational|dry|unknown
  waterPointRawResponse: text("water_point_raw_response"),

  supplementaryFeeding: text("supplementary_feeding"), // yes|no|planning
  supplementaryRawResponse: text("supplementary_raw_response"),

  // ── Quadrant the herder is reporting from (derived from landmark / water point) ─
  reportedQuadrant: text("reported_quadrant"), // NW|NE|SW|SE|unknown
  reportedLocation: text("reported_location"), // landmark / place name they mentioned

  // ── Correlated satellite + climate snapshot at time of call ──────────────
  ndviScore: real("ndvi_score"),
  ndviVsBaselinePercent: real("ndvi_vs_baseline_percent"),
  rainfall30dayMm: real("rainfall_30day_mm"),
  soilMoistureIndex: real("soil_moisture_index"),
  evaporationRate: real("evaporation_rate"),
  rainfallEvapRatio: real("rainfall_evap_ratio"),

  // ── Provenance ───────────────────────────────────────────────────────────
  dataMethodologyVersion: text("data_methodology_version").default("v1.0"),
  standardsApplied: text("standards_applied").default(
    "ILRI/FAO BCS, FEWS NET, LEGS, WFP CSI, FAO AWG",
  ),

  // ── Data quality ─────────────────────────────────────────────────────────
  callDurationSeconds: integer("call_duration_seconds"),
  indicatorsCollected: integer("indicators_collected"),
  dataCompletenessPercent: real("data_completeness_percent"),

  // ── Trust score (server-computed at extraction time) ─────────────────────
  // 0–100. Penalties for short calls, low indicator count, BCS uncertainty,
  // internal contradictions, and satellite-ground mismatch. Reports below
  // ~60 should be human-reviewed before rolling into headline metrics.
  trustScore: integer("trust_score"),
  // Array of short string codes explaining the deductions, e.g.
  // ["call_too_short", "bcs_uncertain", "contradicts_satellite_optimistic"].
  trustFlags: jsonb("trust_flags"),
});

export const insertGroundTruthReportSchema = createInsertSchema(
  groundTruthReportsTable,
).omit({ id: true, createdAt: true });

export type InsertGroundTruthReport = z.infer<
  typeof insertGroundTruthReportSchema
>;
export type GroundTruthReport = typeof groundTruthReportsTable.$inferSelect;
