-- =============================================================================
-- 0018 — Add sms_registration_pending (DOWN).
--
-- Lossless rollback: this table only ever holds ephemeral, short-lived
-- "have we sent this phone the ward picker yet" state, never anything
-- worth preserving across a rollback.
-- =============================================================================

BEGIN;

DROP TABLE IF EXISTS public.sms_registration_pending;

COMMIT;
