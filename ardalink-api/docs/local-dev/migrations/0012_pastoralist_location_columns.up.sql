-- =============================================================================
-- 0012 — Add current-location columns to pastoralists + pastoralist_leads.
--
-- Both tables already have a `location` column (PostGIS geography on
-- Supabase, JSONB-mirrored locally per pastoralistLeads.ts's own header
-- comment) — but it's untested end-to-end for writes anywhere in this
-- codebase, and this repo already has an established, proven, simpler
-- precedent for exactly this need: migration 0007 added
-- ground_truth_calls.reported_lat/reported_lon as plain DOUBLE PRECISION
-- columns rather than wrestling with PostGIS/GeoJSON write formats via
-- PostgREST. This migration follows that same precedent for pastoralist
-- location, deliberately NOT touching the existing `location` column —
-- lower risk, and consistent with how this codebase already solved the
-- identical problem once before.
--
-- `location_source` records WHERE a location came from (registration,
-- an explicit relocation statement, an ops correction, etc.) —
-- see pastoralist_location_history (migration 0011) for the full change
-- log; these two columns are only the "current" pointer, read at request
-- time, never reconstructed from history.
--
-- IDEMPOTENT. Safe to re-run.
--
-- OPERATIONAL NOTE: same as every other Supabase-primary table change in
-- this repo's history — must ALSO be applied directly against the live
-- Supabase project (see 0013_supabase_catchup2.supabase-only.sql).
-- =============================================================================

BEGIN;

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

COMMIT;
