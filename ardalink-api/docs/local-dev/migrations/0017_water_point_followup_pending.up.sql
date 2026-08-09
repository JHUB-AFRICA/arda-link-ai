-- =============================================================================
-- 0017 — Add water_point_followup_pending: implicit ground-truth check-in.
--
-- Owner's direction (2026-08-09): don't tell a herder a water point's
-- status is "unconfirmed" and interrogate them about it in the same
-- breath — guide them to it like a real recommendation, then check in
-- afterward whether it panned out. That means remembering, across two
-- separate WhatsApp webhook turns, which point we last pointed a herder
-- toward and when, so a later turn can ask naturally ("did you find
-- water at X?") instead of a same-turn survey question.
--
-- One row per phone (overwritten on repeat recommendations, matching
-- grazing_ring_pending's own convention — see migration 0006). Read
-- with an application-level minimum age (long enough to have plausibly
-- travelled there) and maximum age (too stale to still be relevant);
-- cleared the first time it's surfaced, so it's asked at most once.
--
-- IDEMPOTENT. Safe to re-run.
--
-- OPERATIONAL NOTE: same posture as grazing_ring_pending — LOCAL-MIRROR
-- ONLY, ephemeral turn-to-turn cache, never synced to/from Supabase. No
-- corresponding Supabase change needed.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.water_point_followup_pending (
    phone_number      TEXT PRIMARY KEY,
    water_point_name  TEXT NOT NULL,
    recommended_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMIT;
