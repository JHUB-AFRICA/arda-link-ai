-- =============================================================================
-- 0009 — Add ground_truth_corrections (DOWN).
--
-- Lossy rollback (drops correction history) but ground_truth_calls itself
-- is untouched — corrections are strictly additive, never a mutation of
-- the original append-only rows.
-- =============================================================================

BEGIN;

DROP TABLE IF EXISTS public.ground_truth_corrections;

COMMIT;
