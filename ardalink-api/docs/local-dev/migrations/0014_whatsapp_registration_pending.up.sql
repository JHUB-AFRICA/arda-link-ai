-- =============================================================================
-- 0014 — Add whatsapp_registration_pending: state for WhatsApp's new
-- self-registration flow, mirroring USSD's "Jisajili" (name -> ward ->
-- language -> save) across separate stateless webhook turns.
--
-- Phase 2 of the location/registration/landmark plan (2026-08-06):
-- WhatsApp had no self-registration path at all — a brand-new number got
-- the same welcome menu as anyone, nothing ever captured into
-- pastoralist_leads. USSD's registration works because AT re-POSTs the
-- FULL accumulated keypad text on every screen; WhatsApp webhook turns
-- carry no such accumulated state, so it has to be persisted here between
-- turns instead.
--
-- One row per phone (overwritten on repeat registration attempts).
-- Local-mirror only — never synced to/from Supabase, same as
-- grazing_ring_pending (migration 0006): this is mid-flow scratch state,
-- not data worth permanently keeping once the flow completes (the actual
-- result lands in pastoralist_leads + pastoralist_location_history,
-- which ARE permanent).
--
-- IDEMPOTENT. Safe to re-run.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.whatsapp_registration_pending (
    phone_number    TEXT PRIMARY KEY,
    step            TEXT NOT NULL CHECK (step IN ('ask_name', 'ask_ward', 'ask_language')),
    draft_full_name TEXT,
    draft_ward_id   TEXT,
    started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMIT;
