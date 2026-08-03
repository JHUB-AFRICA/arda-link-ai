-- =============================================================================
-- 0007 — Add reported_lat/reported_lon to ground_truth_calls (DOWN).
--
-- Lossless rollback: both columns are nullable, best-effort QA aids with
-- no other code depending on their presence.
-- =============================================================================

BEGIN;

ALTER TABLE public.ground_truth_calls
  DROP COLUMN IF EXISTS reported_lat,
  DROP COLUMN IF EXISTS reported_lon;

COMMIT;
