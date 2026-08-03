-- =============================================================================
-- 0006 — Add grazing_ring_pending (DOWN).
--
-- Lossless rollback: this table only ever holds ephemeral, short-lived
-- turn-to-turn state (a herder's most recent location share awaiting a
-- species reply), never anything worth preserving across a rollback.
-- =============================================================================

BEGIN;

DROP TABLE IF EXISTS public.grazing_ring_pending;

COMMIT;
