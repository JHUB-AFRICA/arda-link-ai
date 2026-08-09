-- =============================================================================
-- 0017 — Add water_point_followup_pending (DOWN).
--
-- Lossless rollback: this table only ever holds ephemeral, short-lived
-- turn-to-turn state (which water point we last recommended and when),
-- never anything worth preserving across a rollback.
-- =============================================================================

BEGIN;

DROP TABLE IF EXISTS public.water_point_followup_pending;

COMMIT;
