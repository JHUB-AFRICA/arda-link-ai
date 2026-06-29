-- =============================================================================
-- Base schema — Drizzle-equivalent for the local demo.
-- This is the minimal schema required to apply the multi-tenant migration
-- and to seed demo data. The full Drizzle-generated schema lives in
-- ardalink-api/lib/db/src/schema/ and is applied automatically by the
-- engine on first boot; this file is a portable subset for the local
-- Tuesday verification.
-- =============================================================================

BEGIN;

-- ground_truth_reports
CREATE TABLE IF NOT EXISTS public.ground_truth_reports (
    id SERIAL PRIMARY KEY,
    created_at TIMESTAMP NOT NULL DEFAULT now(),
    session_id TEXT,
    phone TEXT,
    month TEXT NOT NULL,
    timestamp TIMESTAMP NOT NULL DEFAULT now(),
    satellite_metrics JSONB,
    ai_question TEXT,
    user_feedback TEXT NOT NULL,
    action_tag TEXT NOT NULL,
    recording_url TEXT,
    duration_seconds INTEGER,
    bcs_score REAL,
    bcs_raw_response TEXT,
    bcs_species TEXT,
    bcs_confidence TEXT,
    bcs_flag_followup BOOLEAN,
    offtake_rate TEXT,
    offtake_raw_response TEXT,
    mortality_rate TEXT,
    mortality_raw_response TEXT,
    milk_production TEXT,
    milk_raw_response TEXT,
    water_trekking_distance TEXT,
    water_trekking_raw TEXT,
    water_point_name TEXT,
    water_point_status TEXT,
    water_point_raw_response TEXT,
    supplementary_feeding TEXT,
    supplementary_raw_response TEXT,
    reported_quadrant TEXT,
    reported_location TEXT,
    ndvi_score REAL,
    ndvi_vs_baseline_percent REAL,
    rainfall_30day_mm REAL,
    soil_moisture_index REAL,
    evaporation_rate REAL,
    rainfall_evap_ratio REAL,
    data_methodology_version TEXT DEFAULT 'v1.0',
    standards_applied TEXT DEFAULT 'ILRI/FAO BCS, FEWS NET, LEGS, WFP CSI, FAO AWG',
    call_duration_seconds INTEGER,
    indicators_collected INTEGER,
    data_completeness_percent REAL,
    trust_score INTEGER,
    trust_flags JSONB
);

-- pastoralists (with tenant_id added here to support the unique index)
CREATE TABLE IF NOT EXISTS public.pastoralists (
    id SERIAL PRIMARY KEY,
    created_at TIMESTAMP NOT NULL DEFAULT now(),
    name TEXT NOT NULL,
    phone TEXT NOT NULL,
    location TEXT NOT NULL DEFAULT '',
    cattle INTEGER NOT NULL DEFAULT 0,
    goats INTEGER NOT NULL DEFAULT 0,
    camels INTEGER NOT NULL DEFAULT 0,
    water_source TEXT NOT NULL DEFAULT 'Unknown',
    alerts_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    alerts_sent INTEGER NOT NULL DEFAULT 0,
    last_contact_at TIMESTAMP,
    tenant_id TEXT
);

-- Make (tenant_id, phone) unique on pastoralists
CREATE UNIQUE INDEX IF NOT EXISTS pastoralists_tenant_phone_idx
    ON public.pastoralists (tenant_id, phone);

-- satellite_snapshots (cache for Earth Engine results)
CREATE TABLE IF NOT EXISTS public.satellite_snapshots (
    id                  SERIAL PRIMARY KEY,
    captured_at         TIMESTAMP NOT NULL DEFAULT now(),
    newest_image_date    TEXT NOT NULL,
    result              JSONB NOT NULL
);

-- climate_snapshots (cache for climate + forecast)
CREATE TABLE IF NOT EXISTS public.climate_snapshots (
    id          SERIAL PRIMARY KEY,
    captured_at TIMESTAMP NOT NULL DEFAULT now(),
    climate     JSONB NOT NULL,
    forecast    JSONB
);

COMMIT;