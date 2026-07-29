-- =============================================================================
-- 0004 — Drop local ground_truth_reports table.
--
-- Supabase `ground_truth_calls` is now the primary source of truth for herder
-- voice-call ground-truth data. The local `ground_truth_reports` table was a
-- write-only backup with no real data; all reads have been redirected to
-- Supabase. Drop the table so it no longer occupies schema space or risks
-- accidentally being written to.
-- =============================================================================

DROP TABLE IF EXISTS ground_truth_reports;
