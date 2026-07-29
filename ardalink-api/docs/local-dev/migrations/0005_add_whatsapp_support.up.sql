-- =============================================================================
-- 0005 — Add WhatsApp channel support to the local Postgres mirror.
--
-- Three changes, all additive:
--
--   1) pastoralists gains wa_id (nullable, unique when set) + channel_tier
--      + last_tier_check_at, so the channel-tier resolver
--      (src/lib/channelTier.ts) has somewhere to record which delivery
--      tier (whatsapp/voice/ussd/sms) a herder currently resolves to.
--
--   2) New whatsapp_messages table — an append-only thread/audit log,
--      the WhatsApp analogue of lead_interactions, dual-written from
--      src/lib/supabase.ts's logWhatsappMessage() the same way
--      lead_interactions is (NOT synced via syncJob.ts — see that job's
--      header comment on why append-only tables use dual-write instead).
--
--   3) ground_truth_calls gains a channel column. This did NOT already
--      exist — the only pre-existing differentiator was source_language
--      (sw/en), which is language, not channel. Needed so a WhatsApp-
--      originated ground-truth row can be told apart from a voice one.
--
-- IDEMPOTENT. Safe to re-run. Uses IF EXISTS / IF NOT EXISTS everywhere.
--
-- OPERATIONAL NOTE: this migration only reaches the local mirror. The
-- same three changes must ALSO be applied directly against the live
-- Supabase project (Supabase SQL editor, or that project's own migration
-- path — outside this repo) before insertGroundTruthCall({channel:...})
-- or logWhatsappMessage() will persist server-side. Until then, both
-- fail soft to the local mirror only (see supabase.ts's sbInsert
-- non-2xx → null contract) — track this as a blocking pre-req before
-- WhatsApp goes live against real Supabase data, not something to
-- discover at pilot time.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. pastoralists — WhatsApp identity + channel tier.
-- ---------------------------------------------------------------------------

ALTER TABLE public.pastoralists
  ADD COLUMN IF NOT EXISTS wa_id TEXT,
  ADD COLUMN IF NOT EXISTS channel_tier TEXT NOT NULL DEFAULT 'sms'
    CHECK (channel_tier IN ('whatsapp', 'voice', 'ussd', 'sms')),
  ADD COLUMN IF NOT EXISTS last_tier_check_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS pastoralists_wa_id_idx
    ON public.pastoralists (wa_id) WHERE wa_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. whatsapp_messages — append-only thread/audit log (mirrors
--    lead_interactions' shape; two rows per turn — one 'in', one 'out' —
--    since WhatsApp's richer message_type/template_name/session_expires_at
--    fields justify splitting direction rather than cramming both into
--    one row like lead_interactions does).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.whatsapp_messages (
    message_id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    phone_number        TEXT        NOT NULL,
    wa_id               TEXT,
    tier                TEXT,                     -- 'verified' | 'lead' | 'unknown', snapshot at send time
    direction           TEXT        NOT NULL CHECK (direction IN ('in', 'out', 'status')),
    message_type        TEXT        NOT NULL,      -- 'text' | 'template' | 'interactive_list' | 'interactive_buttons' | 'list_reply' | 'button_reply' | 'location' | 'audio' | 'status'
    template_name       TEXT,
    body_text           TEXT,
    session_expires_at  TIMESTAMPTZ,
    ward_id             TEXT,
    occurred_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    raw_payload         JSONB,
    tenant_id           TEXT
);
CREATE INDEX IF NOT EXISTS whatsapp_messages_phone_idx
    ON public.whatsapp_messages (phone_number, occurred_at DESC);
CREATE INDEX IF NOT EXISTS whatsapp_messages_ward_id_idx
    ON public.whatsapp_messages (ward_id);
CREATE INDEX IF NOT EXISTS whatsapp_messages_tenant_id_idx
    ON public.whatsapp_messages (tenant_id);

-- ---------------------------------------------------------------------------
-- 3. ground_truth_calls — channel differentiator.
-- ---------------------------------------------------------------------------

ALTER TABLE public.ground_truth_calls
  ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'voice'
    CHECK (channel IN ('voice', 'sms', 'ussd', 'whatsapp'));

-- ---------------------------------------------------------------------------
-- 4. RLS + tenant isolation on the new table (mirrors 0003's DO-block).
-- ---------------------------------------------------------------------------

DO $$
DECLARE
    rec RECORD;
BEGIN
    FOR rec IN
        SELECT unnest(ARRAY[
            'whatsapp_messages'
        ]) AS tbl
    LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', rec.tbl);
        EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', rec.tbl);
        EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', rec.tbl);
        EXECUTE format(
            'CREATE POLICY tenant_isolation ON public.%I '
            'USING (tenant_id IS NULL '
            '       OR tenant_id = current_setting(''app.current_tenant_id'', TRUE)) '
            'WITH CHECK (tenant_id IS NULL '
            '            OR tenant_id = current_setting(''app.current_tenant_id'', TRUE))',
            rec.tbl
        );
    END LOOP;
END
$$;

COMMIT;
