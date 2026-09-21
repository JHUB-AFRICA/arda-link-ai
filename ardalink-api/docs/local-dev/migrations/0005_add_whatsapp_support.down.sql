-- =============================================================================
-- 0005 — Add WhatsApp channel support (DOWN).
--
-- Drops whatsapp_messages entirely and reverts the pastoralists /
-- ground_truth_calls column additions.
--
-- Rollback is lossy for whatsapp_messages (the whole thread log is
-- dropped) but lossless for the two ALTER TABLE additions, since they
-- were new nullable/defaulted columns with no pre-existing data to
-- reconcile.
-- =============================================================================

BEGIN;

DROP TABLE IF EXISTS public.whatsapp_messages;

ALTER TABLE public.ground_truth_calls
  DROP COLUMN IF EXISTS channel;

DROP INDEX IF EXISTS public.pastoralists_wa_id_idx;

ALTER TABLE public.pastoralists
  DROP COLUMN IF EXISTS wa_id,
  DROP COLUMN IF EXISTS channel_tier,
  DROP COLUMN IF EXISTS last_tier_check_at;

COMMIT;
