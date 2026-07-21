-- =============================================================================
-- 0003 — Realign local Postgres to be a real mirror of Supabase.
--
-- Two-part cleanup:
--
--   1) SEED PURGE — the earlier seed left three tenants (bula-pesa,
--      garbatulla, merti) and never added the four wards that later
--      became canonical. This migration drops the retired-tenant rows
--      across pastoralists / ground_truth_reports / tenant_feature_flags,
--      hard-deletes the retired tenants themselves, and inserts the
--      four missing canonical wards so `public.tenants` matches the
--      five-ward set enforced in `ardalink-api/src/lib/wardMapping.ts`.
--
--   2) MIRROR TABLES — Supabase is the source of truth for a growing
--      set of operational tables (pastoralist_leads, lead_interactions,
--      ward_cells, satellite_indices, weather_data, ground_truth_calls,
--      weather_forecast). Adding matching (non-PostGIS) shells locally
--      is a prerequisite for the Supabase → local sync job (Phase 2.4)
--      so the API can degrade to local reads when Supabase is down.
--
-- Also purges orphan rows stamped with the pseudo-tenant `isiolo`
-- (or a NULL tenant) that were being silently inserted by
-- snapshotCache.ts pre-`fix/engine-default-tenant-slug`.
--
-- IDEMPOTENT. Safe to re-run. Uses `IF EXISTS` / `IF NOT EXISTS`
-- everywhere; deletes are filtered by the retired-slug set so a
-- second pass is a no-op.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Purge retired-tenant data rows.
-- ---------------------------------------------------------------------------
--
-- `pastoralists`, `ground_truth_reports`, `tenant_feature_flags`, and
-- `admin_users` all reference tenant_id. Delete every row still
-- pointing at a retired tenant before we drop the tenants themselves.

DELETE FROM public.pastoralists
 WHERE tenant_id IN ('garbatulla', 'merti');

DELETE FROM public.ground_truth_reports
 WHERE tenant_id IN ('garbatulla', 'merti');

DELETE FROM public.tenant_feature_flags
 WHERE tenant_id IN ('garbatulla', 'merti');

-- admin_users has ON DELETE CASCADE against tenants, but do it
-- explicitly so the row count shows up in this migration's log.
DELETE FROM public.admin_users
 WHERE tenant_id IN ('garbatulla', 'merti');

-- ---------------------------------------------------------------------------
-- 2. Purge orphan tenant_id='isiolo' / NULL rows in cache tables.
-- ---------------------------------------------------------------------------
--
-- These were inserted by snapshotCache.ts when the intelligence result
-- had no tenant_id attached; they're invisible to every operator query
-- (no operator's tenant_id is 'isiolo'). fix/engine-default-tenant-slug
-- landed the source-side fix — this migration clears the historical
-- pollution.

DELETE FROM public.satellite_snapshots
 WHERE tenant_id = 'isiolo' OR tenant_id IS NULL;

DELETE FROM public.climate_snapshots
 WHERE tenant_id = 'isiolo' OR tenant_id IS NULL;

-- ---------------------------------------------------------------------------
-- 3. Retire the tenants themselves + add the four missing canonical wards.
-- ---------------------------------------------------------------------------

DELETE FROM public.tenants
 WHERE tenant_id IN ('garbatulla', 'merti');

INSERT INTO public.tenants (tenant_id, display_name, region) VALUES
    ('wabera',     'Wabera Ward',      'Isiolo County'),
    ('ngare-mara', 'Ngare Mara Ward',  'Isiolo County'),
    ('burat',      'Burat Ward',       'Isiolo County'),
    ('oldonyiro',  'Oldonyiro Ward',   'Isiolo County')
ON CONFLICT (tenant_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 4. Mirror tables — Supabase-primary, local-backup.
-- ---------------------------------------------------------------------------
--
-- Column shapes mirror the Supabase source of truth. PostGIS-typed
-- columns (geometry, point) are stored as JSONB (GeoJSON) locally so
-- this migration doesn't require the postgis extension — the API's
-- Drizzle schema already handles both shapes.
--
-- ward_id is the canonical join key everywhere; local tables store it
-- as TEXT (matching Supabase's "241"/"242"/… string ids).

-- pastoralist_leads — self-enrolled herders awaiting ops verification.
CREATE TABLE IF NOT EXISTS public.pastoralist_leads (
    lead_id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    phone_number             TEXT        NOT NULL,
    full_name                TEXT,
    preferred_language       TEXT,
    ward_id                  TEXT,
    location                 JSONB,           -- GeoJSON Point (mirrors PostGIS point)
    herd_size                INTEGER,
    enrollment_source        TEXT,            -- 'ussd_self' | 'sms_keyword' | 'inbound_call' | …
    status                   TEXT        NOT NULL DEFAULT 'lead',
    alerts_enabled           BOOLEAN     NOT NULL DEFAULT TRUE,
    first_contact_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_contact_at          TIMESTAMPTZ,
    verified_at              TIMESTAMPTZ,
    verified_by              TEXT,
    promoted_pastoralist_id  UUID,
    notes                    TEXT,
    tenant_id                TEXT,            -- optional attribution, matches Supabase
    created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pastoralist_leads_phone_idx
    ON public.pastoralist_leads (phone_number);
CREATE INDEX IF NOT EXISTS pastoralist_leads_ward_id_idx
    ON public.pastoralist_leads (ward_id);
CREATE INDEX IF NOT EXISTS pastoralist_leads_tenant_id_idx
    ON public.pastoralist_leads (tenant_id);

-- lead_interactions — audit trail for every herder-facing surface hit.
CREATE TABLE IF NOT EXISTS public.lead_interactions (
    interaction_id  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    phone_number    TEXT        NOT NULL,
    tier            TEXT,                          -- 'verified' | 'lead' | 'unknown'
    channel         TEXT        NOT NULL,         -- 'ussd' | 'sms' | 'voice'
    session_id      TEXT,
    keyword         TEXT,
    input_text      TEXT,
    reply_text      TEXT,
    ward_id         TEXT,
    occurred_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    raw_body        JSONB,
    tenant_id       TEXT
);
CREATE INDEX IF NOT EXISTS lead_interactions_phone_idx
    ON public.lead_interactions (phone_number, occurred_at DESC);
CREATE INDEX IF NOT EXISTS lead_interactions_ward_id_idx
    ON public.lead_interactions (ward_id);
CREATE INDEX IF NOT EXISTS lead_interactions_tenant_id_idx
    ON public.lead_interactions (tenant_id);

-- ward_cells — 1 km grid used by the choropleth heatmap.
CREATE TABLE IF NOT EXISTS public.ward_cells (
    ward_cell_id  TEXT   PRIMARY KEY,
    ward_id       TEXT   NOT NULL,
    cell_i        INTEGER,
    cell_j        INTEGER,
    cell_size_m   INTEGER,
    geometry      JSONB,                     -- GeoJSON MultiPolygon
    tenant_id     TEXT
);
CREATE INDEX IF NOT EXISTS ward_cells_ward_id_idx
    ON public.ward_cells (ward_id);
CREATE INDEX IF NOT EXISTS ward_cells_tenant_id_idx
    ON public.ward_cells (tenant_id);

-- satellite_indices — monthly ward-mean vegetation indices + VCI.
CREATE TABLE IF NOT EXISTS public.satellite_indices (
    satellite_index_id  BIGSERIAL   PRIMARY KEY,
    ward_id             TEXT        NOT NULL,
    period_start        DATE        NOT NULL,
    period_end          DATE        NOT NULL,
    calendar_month      SMALLINT,
    calendar_year       SMALLINT,
    ndvi_mean           NUMERIC,
    ndre_mean           NUMERIC,
    ndwi_mean           NUMERIC,
    ndmi_mean           NUMERIC,
    evi_mean            NUMERIC,
    savi_mean           NUMERIC,
    bsi_mean            NUMERIC,
    vci_value           NUMERIC,
    prosopis_corrected  BOOLEAN,
    prosopis_share      NUMERIC,
    source_collection   TEXT,
    run_id              TEXT,
    tenant_id           TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (ward_id, period_start, period_end, source_collection)
);
CREATE INDEX IF NOT EXISTS satellite_indices_ward_month_idx
    ON public.satellite_indices (ward_id, calendar_year DESC, calendar_month DESC);
CREATE INDEX IF NOT EXISTS satellite_indices_tenant_id_idx
    ON public.satellite_indices (tenant_id);

-- weather_data — daily observations from Open-Meteo.
CREATE TABLE IF NOT EXISTS public.weather_data (
    weather_data_id           BIGSERIAL   PRIMARY KEY,
    ward_id                   TEXT        NOT NULL,
    observed_date             DATE        NOT NULL,
    rainfall_mm_30d           NUMERIC,
    humidity_pct              NUMERIC,
    temperature_c             NUMERIC,
    evapotranspiration_mm     NUMERIC,
    source                    TEXT,
    tenant_id                 TEXT,
    created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (ward_id, observed_date, source)
);
CREATE INDEX IF NOT EXISTS weather_data_ward_date_idx
    ON public.weather_data (ward_id, observed_date DESC);
CREATE INDEX IF NOT EXISTS weather_data_tenant_id_idx
    ON public.weather_data (tenant_id);

-- ground_truth_calls — Supabase-side thin projection of ground_truth_reports.
CREATE TABLE IF NOT EXISTS public.ground_truth_calls (
    call_id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    pastoralist_id           UUID,
    ward_id                  TEXT,
    call_timestamp           TIMESTAMPTZ NOT NULL DEFAULT now(),
    bcs_score                NUMERIC,
    mortality_rate           NUMERIC,
    offtake_rate             NUMERIC,
    water_point_status       TEXT,
    milk_production_liters   NUMERIC,
    water_trek_distance_km   NUMERIC,
    supplementary_feeding    TEXT,
    trust_score              NUMERIC,
    source_language          TEXT,
    transcript               TEXT,
    tenant_id                TEXT
);
CREATE INDEX IF NOT EXISTS ground_truth_calls_ward_ts_idx
    ON public.ground_truth_calls (ward_id, call_timestamp DESC);
CREATE INDEX IF NOT EXISTS ground_truth_calls_pastoralist_idx
    ON public.ground_truth_calls (pastoralist_id);
CREATE INDEX IF NOT EXISTS ground_truth_calls_tenant_id_idx
    ON public.ground_truth_calls (tenant_id);

-- weather_forecast — 14-day rainfall / temp / ET0 ensemble.
CREATE TABLE IF NOT EXISTS public.weather_forecast (
    forecast_id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    ward_id                      TEXT        NOT NULL,
    generated_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
    target_date                  DATE        NOT NULL,
    horizon_days                 SMALLINT,
    rainfall_mm_p5               NUMERIC,
    rainfall_mm_p50              NUMERIC,
    rainfall_mm_p95              NUMERIC,
    precipitation_probability    NUMERIC,
    temperature_c_mean           NUMERIC,
    temperature_c_max            NUMERIC,
    et0_mm                       NUMERIC,
    source                       TEXT,
    raw_response                 JSONB,
    tenant_id                    TEXT
);
CREATE INDEX IF NOT EXISTS weather_forecast_ward_target_idx
    ON public.weather_forecast (ward_id, target_date);
CREATE INDEX IF NOT EXISTS weather_forecast_tenant_id_idx
    ON public.weather_forecast (tenant_id);

-- ---------------------------------------------------------------------------
-- 5. RLS + tenant isolation policy on every new table.
--
-- Mirrors the DO-block in 0001_multitenant_public. New tables get the
-- same tenant_isolation policy (rows visible only when the session's
-- app.current_tenant_id matches the row's tenant_id). Tables with
-- NULL tenant_id are visible to everyone, matching the Supabase-side
-- "shared reference data" convention for ward_cells and satellite_indices.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
    rec RECORD;
BEGIN
    FOR rec IN
        SELECT unnest(ARRAY[
            'pastoralist_leads',
            'lead_interactions',
            'ward_cells',
            'satellite_indices',
            'weather_data',
            'ground_truth_calls',
            'weather_forecast'
        ]) AS tbl
    LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', rec.tbl);
        EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', rec.tbl);
        EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', rec.tbl);
        EXECUTE format(
            'CREATE POLICY tenant_isolation ON public.%I '
            'USING (tenant_id IS NULL '
            '       OR tenant_id = current_setting(''app.current_tenant_id'', TRUE)) '
            'WITH CHECK (tenant_id IS NULL '
            '            OR tenant_id = current_setting(''app.current_tenant_id'', TRUE))',
            rec.tbl
        );
    END LOOP;
END
$$;

COMMIT;
