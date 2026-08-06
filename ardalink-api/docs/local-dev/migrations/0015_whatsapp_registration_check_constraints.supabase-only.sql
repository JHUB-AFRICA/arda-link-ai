-- =============================================================================
-- 0015 — Loosen two live Supabase CHECK constraints that WhatsApp's new
-- self-registration flow (Phase 2 of the location/registration/landmark
-- plan) tripped over.
--
-- THIS FILE APPLIES ONLY TO THE LIVE SUPABASE PROJECT (SQL editor). Both
-- tables here are Supabase-native (created directly in its dashboard, not
-- by this repo's migrations), so neither constraint is visible or
-- alterable from the local mirror — confirmed: the local mirror has NO
-- check constraints on either column at all, which is exactly why this
-- gap wasn't caught by local testing and only surfaced on a real, live
-- WhatsApp registration test (2026-08-06).
--
--   1) pastoralist_leads.enrollment_source — only allowed the values that
--      existed when the table was first created (ussd_self, sms_self,
--      inbound_call, field_agent), predating WhatsApp registration
--      entirely. The flow's final upsertPastoralistLead({...,
--      enrollment_source: "whatsapp_self"}) call failed with `23514`
--      (silent to the herder — upsertPastoralistLead fails soft, same
--      contract as every other Supabase write in this repo). A SEPARATE
--      upsertPastoralistLead call inside setCurrentLocation
--      (location-only fields, no enrollment_source) then created the row
--      fresh instead, with enrollment_source defaulting to 'ussd_self'
--      and full_name/preferred_language left null — a herder who just
--      typed their real name got a lead row that looked like it came
--      from USSD with no name recorded at all.
--
--   2) lead_interactions.keyword — same story: WhatsApp's audit-trail tags
--      for the new registration steps (registration_start,
--      registration_name, registration_ward, registration_ward_invalid,
--      registration_language_invalid, registration_complete) aren't in
--      whatever fixed list this constraint currently enforces. Rather
--      than reverse-engineer and re-enumerate every value already in use
--      across USSD/SMS/voice/WhatsApp (impossible to fully verify without
--      a live introspection this environment doesn't have), this
--      column's actual purpose is a free-form audit/analytics tag, not a
--      strict state machine key — so the constraint is dropped rather
--      than re-enumerated, matching what the column is actually used for
--      throughout this codebase's history.
--
-- Uses a DO block to find and drop whatever each constraint is actually
-- named (rather than guessing) — safer than a blind DROP CONSTRAINT
-- IF EXISTS <guessed-name>, since neither constraint was defined by this
-- repo and their exact names aren't visible without live introspection.
--
-- IDEMPOTENT. Safe to re-run.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. pastoralist_leads.enrollment_source — add 'whatsapp_self'.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  con RECORD;
BEGIN
  FOR con IN
    SELECT DISTINCT con.conname
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_attribute att ON att.attrelid = rel.oid AND att.attnum = ANY(con.conkey)
    WHERE rel.relname = 'pastoralist_leads'
      AND con.contype = 'c'
      AND att.attname = 'enrollment_source'
  LOOP
    EXECUTE format('ALTER TABLE public.pastoralist_leads DROP CONSTRAINT %I', con.conname);
  END LOOP;
END $$;

ALTER TABLE public.pastoralist_leads
  ADD CONSTRAINT pastoralist_leads_enrollment_source_check
  CHECK (enrollment_source IN ('ussd_self', 'sms_self', 'inbound_call', 'field_agent', 'whatsapp_self'));

-- ---------------------------------------------------------------------------
-- 2. lead_interactions.keyword — drop the fixed-value constraint
--    entirely (this column is a free-form audit tag, not an enum).
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  con RECORD;
BEGIN
  FOR con IN
    SELECT DISTINCT con.conname
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_attribute att ON att.attrelid = rel.oid AND att.attnum = ANY(con.conkey)
    WHERE rel.relname = 'lead_interactions'
      AND con.contype = 'c'
      AND att.attname = 'keyword'
  LOOP
    EXECUTE format('ALTER TABLE public.lead_interactions DROP CONSTRAINT %I', con.conname);
  END LOOP;
END $$;
