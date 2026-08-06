-- =============================================================================
-- 0010 — Supabase catch-up: apply everything from 0005/0009 that never
-- actually reached the live Supabase project, plus a newly-discovered
-- gap (alerts_enabled) that predates this repo's migration tracking.
--
-- THIS FILE APPLIES ONLY TO THE LIVE SUPABASE PROJECT (SQL editor). It is
-- not part of the local-mirror migration chain (0000-0009) — those apply
-- automatically via docs/local-dev's bring-up. Supabase's schema is
-- managed independently (created directly in its dashboard, outside this
-- repo's history), so anything Supabase-side has to be run by hand.
--
-- Found via direct inspection of the live project (2026-08-06): none of
-- the four changes below existed. Root causes, one by one:
--
--   1) pastoralists.wa_id / channel_tier / last_tier_check_at — part of
--      migration 0005 (add_whatsapp_support), whose own operational note
--      already flagged this as unapplied. No functional impact today:
--      channelTier.ts reads/writes the LOCAL mirror's pastoralists row
--      only, by design (see that file's header) — but the columns
--      should exist on Supabase too so the two copies aren't permanently
--      divergent in shape.
--
--   2) whatsapp_messages (new table) — same migration 0005. Real impact:
--      logWhatsappMessage() has been failing to write to Supabase on
--      every single WhatsApp turn since the channel went live (silent,
--      warn-logged only) — the entire WhatsApp audit trail exists ONLY
--      in the local Postgres mirror. Reads (hasPriorWhatsappMessages,
--      recentWhatsappMessages) already fall back to the local mirror
--      gracefully, so conversations were never broken by this — but
--      Supabase itself has zero WhatsApp history for anyone querying it
--      directly, and that's a real gap for anything outside this app.
--
--   3) ground_truth_calls.channel — same migration 0005. Every
--      WhatsApp-originated ground-truth row has been persisting to
--      Supabase without its channel column (silently dropped/rejected
--      the same way), making it indistinguishable from a voice call
--      once in Supabase.
--
--   4) ground_truth_corrections (new table) — migration 0009. Already
--      flagged in STATUS.md: every operator correction submitted via
--      the Ground Truth Audit tab silently no-ops server-side.
--
--   5) pastoralists.alerts_enabled — NOT part of any prior migration's
--      operational note; this was a plain oversight; Supabase's
--      pastoralists table simply never had it. Real impact:
--      markPastoralistOptedOut() (src/lib/supabase/pastoralists.ts) is
--      called on every WhatsApp "STOP" keyword and every SMS opt-out
--      (routes/smsOptOut.ts) — the PATCH silently fails today, so a
--      verified pastoralist who asks to stop receiving messages is
--      never actually flagged as opted out in the real data store.
--
-- IDEMPOTENT. Safe to re-run.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1 & 5. pastoralists — WhatsApp identity/tier columns + alerts_enabled.
-- ---------------------------------------------------------------------------

ALTER TABLE public.pastoralists
  ADD COLUMN IF NOT EXISTS wa_id TEXT,
  ADD COLUMN IF NOT EXISTS channel_tier TEXT NOT NULL DEFAULT 'sms'
    CHECK (channel_tier IN ('whatsapp', 'voice', 'ussd', 'sms')),
  ADD COLUMN IF NOT EXISTS last_tier_check_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS alerts_enabled BOOLEAN NOT NULL DEFAULT TRUE;

CREATE UNIQUE INDEX IF NOT EXISTS pastoralists_wa_id_idx
    ON public.pastoralists (wa_id) WHERE wa_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. whatsapp_messages — append-only thread/audit log.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.whatsapp_messages (
    message_id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    phone_number        TEXT        NOT NULL,
    wa_id               TEXT,
    tier                TEXT,
    direction           TEXT        NOT NULL CHECK (direction IN ('in', 'out', 'status')),
    message_type        TEXT        NOT NULL,
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
-- 4. ground_truth_corrections — operator review/correction layer.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.ground_truth_corrections (
    id                SERIAL PRIMARY KEY,
    call_id           TEXT NOT NULL,
    corrected_by      TEXT NOT NULL,
    corrected_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    field             TEXT NOT NULL,
    original_value    TEXT,
    corrected_value   TEXT NOT NULL,
    reason            TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ground_truth_corrections_call_id
    ON public.ground_truth_corrections (call_id);

COMMIT;
