-- =============================================================================
-- 0013 — Supabase catch-up #2: apply 0011/0012's location-tracking schema
-- to the live Supabase project, plus a separately-discovered gap from
-- migration 0007 that was never caught up in 0010.
--
-- THIS FILE APPLIES ONLY TO THE LIVE SUPABASE PROJECT (SQL editor). Same
-- reasoning as 0010: Supabase's schema is managed independently of this
-- repo's local-mirror migration chain, so anything Supabase-side has to
-- be run by hand — there is no direct Postgres connection string or
-- management API token available in this environment to automate it.
--
-- Confirmed missing via direct inspection of the live project
-- (2026-08-06), while verifying the new pastoralist location-history
-- feature end to end: a real USSD registration test failed with
-- `PGRST204 Could not find the 'lat' column of 'pastoralist_leads'`,
-- proving these columns don't exist live yet even though they were
-- added to the local mirror (docs/local-dev/migrations/0011 and 0012).
--
--   1) pastoralist_location_history (new table) — migration 0011. The
--      permanent, append-only location-change log driving the whole
--      "don't keep asking for data you should already know" feature.
--
--   2) pastoralists / pastoralist_leads gain lat, lon, location_source,
--      location_updated_at — migration 0012. Deliberately plain columns,
--      not the existing-but-unused `location` PostGIS column (see that
--      migration's header for why).
--
--   3) ground_truth_calls.reported_lat / reported_lon — migration 0007
--      (`ground_truth_calls_location`). This was ALREADY supposed to be
--      live (0007 shipped 2026-08-0x, well before today), but a direct
--      probe just now confirmed it never actually reached Supabase either
--      (`column ground_truth_calls.reported_lat does not exist`) — the
--      same "declared locally, never hand-applied" gap already found and
--      fixed once for 0005/0009 (see 0010's own header). Folding it in
--      here since it's the same category of gap, found while auditing
--      this exact area of the schema.
--
-- IDEMPOTENT. Safe to re-run.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. pastoralist_location_history — permanent, append-only.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.pastoralist_location_history (
    id                      SERIAL PRIMARY KEY,
    entity_type             TEXT NOT NULL CHECK (entity_type IN ('lead', 'pastoralist')),
    entity_id               TEXT NOT NULL,
    phone_number            TEXT NOT NULL,
    ward_id                 TEXT,
    location_text           TEXT,
    lat                     DOUBLE PRECISION,
    lon                     DOUBLE PRECISION,
    source                  TEXT NOT NULL CHECK (source IN (
                                'ussd_registration', 'whatsapp_registration', 'sms_self',
                                'whatsapp_explicit_statement', 'ops_verification', 'ops_manual_edit')),
    confidence              TEXT CHECK (confidence IN ('high', 'medium', 'low')),
    previous_ward_id        TEXT,
    previous_location_text  TEXT,
    previous_lat            DOUBLE PRECISION,
    previous_lon            DOUBLE PRECISION,
    raw_message_text        TEXT,
    changed_by              TEXT,
    recorded_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pastoralist_location_history_entity
    ON public.pastoralist_location_history (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_pastoralist_location_history_phone
    ON public.pastoralist_location_history (phone_number, recorded_at DESC);

-- ---------------------------------------------------------------------------
-- 2. pastoralists / pastoralist_leads — current-location pointer.
-- ---------------------------------------------------------------------------

ALTER TABLE public.pastoralists
  ADD COLUMN IF NOT EXISTS lat DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS lon DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS location_source TEXT,
  ADD COLUMN IF NOT EXISTS location_updated_at TIMESTAMPTZ;

ALTER TABLE public.pastoralist_leads
  ADD COLUMN IF NOT EXISTS lat DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS lon DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS location_source TEXT,
  ADD COLUMN IF NOT EXISTS location_updated_at TIMESTAMPTZ;

-- ---------------------------------------------------------------------------
-- 3. ground_truth_calls — reported_lat/reported_lon (from 0007, never
--    actually applied live until now).
-- ---------------------------------------------------------------------------

ALTER TABLE public.ground_truth_calls
  ADD COLUMN IF NOT EXISTS reported_lat DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS reported_lon DOUBLE PRECISION;

COMMIT;
