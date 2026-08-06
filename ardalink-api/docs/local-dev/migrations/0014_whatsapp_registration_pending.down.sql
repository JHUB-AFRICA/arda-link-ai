-- =============================================================================
-- 0014 (down) — Drop whatsapp_registration_pending.
-- =============================================================================

BEGIN;

DROP TABLE IF EXISTS public.whatsapp_registration_pending;

COMMIT;
