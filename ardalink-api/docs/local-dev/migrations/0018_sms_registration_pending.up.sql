-- =============================================================================
-- 0018 — Add sms_registration_pending: SMS's mandatory-registration gate.
--
-- Product decision (2026-08-11), following a truthfulness audit that found
-- an unregistered number got the full advisory experience on every channel
-- indefinitely (only ground-truth WRITES were gated on identity, never the
-- conversation itself) — every channel must now require registration
-- before a substantive reply. WhatsApp/USSD reuse their existing full
-- name+ward+language self-registration flows; SMS had none, and — unlike
-- WhatsApp — costs money per leg for both sides, so this is deliberately
-- minimal: ward only, one round-trip, via a numbered picker. One row per
-- phone (overwritten if re-prompted), matching water_point_followup_
-- pending / whatsapp_registration_pending's own convention.
--
-- IDEMPOTENT. Safe to re-run.
--
-- OPERATIONAL NOTE: same posture as water_point_followup_pending — LOCAL-
-- MIRROR ONLY, ephemeral turn-to-turn state, never synced to/from Supabase.
-- No corresponding Supabase change needed.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.sms_registration_pending (
    phone_number  TEXT PRIMARY KEY,
    prompted_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMIT;
