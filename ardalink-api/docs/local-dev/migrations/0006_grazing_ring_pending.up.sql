-- =============================================================================
-- 0006 — Add grazing_ring_pending: WhatsApp species-capture state.
--
-- One additive change: a new table holding "we're waiting for this phone
-- number to reply with which species they graze" between two separate
-- webhook turns (herder shares GPS location -> we ask species via 3
-- buttons -> herder taps one -> we can now call the engine's
-- /api/v1/grazing/advisory). No such session/pending-flow mechanism
-- existed anywhere in this codebase before this migration.
--
-- One row per phone (overwritten on repeat location shares via ON
-- CONFLICT). Treated as stale and ignored if the button reply arrives
-- more than ~15 minutes after the location share (handled in
-- application code, not here) — covers a herder who shares location but
-- never taps a species button.
--
-- IDEMPOTENT. Safe to re-run. Uses IF NOT EXISTS everywhere.
--
-- OPERATIONAL NOTE: unlike 0005's changes, this table is LOCAL-MIRROR
-- ONLY — it's never read from or written to Supabase, purely an
-- ephemeral turn-to-turn cache for this API's own webhook handler. No
-- corresponding change is needed against the live Supabase project.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.grazing_ring_pending (
    phone_number  TEXT PRIMARY KEY,
    lat           DOUBLE PRECISION NOT NULL,
    lon           DOUBLE PRECISION NOT NULL,
    requested_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    tenant_id     TEXT
);

COMMIT;
