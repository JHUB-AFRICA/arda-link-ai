-- =============================================================================
-- 0016 — Supabase catch-up #3: ground_truth_calls.water_point_name.
--
-- THIS FILE APPLIES ONLY TO THE LIVE SUPABASE PROJECT (SQL editor). Same
-- reasoning as 0010/0013: Supabase's schema is managed independently of
-- this repo's local-mirror migration chain, so anything Supabase-side has
-- to be run by hand — there is no direct Postgres connection string or
-- management API token available in this environment to automate it.
--
-- Confirmed missing via direct inspection of the live project (2026-08-09):
-- a real USSD ground-truth-confirm test (`text=2*1*1`, herder confirming
-- a named water point is working) failed silently server-side with
-- `PGRST204 Could not find the 'water_point_name' column of
-- 'ground_truth_calls' in the schema cache` — the local mirror has had
-- this column since the very first base migration
-- (0000_base_schema.up.sql), but it was never hand-applied to Supabase,
-- the same "declared locally, never caught up" gap 0010/0013 already
-- found and fixed for other columns/tables.
--
-- Without this column, the app layer can compute exactly which named
-- water point a herder is confirming/correcting (ctx.nearestWaterPointName,
-- the LLM's extracted water_point_name, or the USSD/SMS confirm flow's own
-- selection) but has nowhere to persist it — the ground_truth_calls row
-- lands with only a bare status, unlinked to any specific point, making
-- the whole "confirm from herders close to the broken ones" loop
-- unreviewable by an operator. See src/lib/supabase/groundTruth.ts and
-- ardalink-web/dashboard's GroundTruthAuditSection.tsx, both already
-- updated to read/write this column.
--
-- IDEMPOTENT. Safe to re-run.
-- =============================================================================

BEGIN;

ALTER TABLE public.ground_truth_calls
  ADD COLUMN IF NOT EXISTS water_point_name TEXT;

COMMIT;
