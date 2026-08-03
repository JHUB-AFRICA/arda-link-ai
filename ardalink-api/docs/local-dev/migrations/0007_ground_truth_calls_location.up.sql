-- =============================================================================
-- 0007 — Add reported_lat/reported_lon to ground_truth_calls.
--
-- ground_truth_calls had no coordinate or water-point-reference field at
-- all (only ward_id) — nothing to automatically join a piosphere-ring
-- advisory against. These two additive columns let a WhatsApp-channel
-- ground-truth report carry through the coordinates from a recent
-- location share (see src/lib/grazingRingPending.ts + whatsappTurn.ts's
-- handleFreeText), turning "did herders told they were in/out of a ring
-- later report BCS/mortality/offtake consistent with its VCI" into a
-- simple SQL join instead of reading transcripts by hand.
--
-- Populated on a best-effort basis only (NULL when no location share
-- preceded the report, or it aged out after 15 minutes) — this is a QA
-- aid, not a guarantee every row has coordinates.
--
-- IDEMPOTENT. Safe to re-run.
--
-- OPERATIONAL NOTE: same as every other ground_truth_calls change in this
-- repo's history (see 0005's header) — this must ALSO be applied
-- directly against the live Supabase project (Supabase SQL editor, or
-- that project's own migration path) before reported_lat/reported_lon
-- will persist server-side. Until then it fails soft to the local mirror
-- only.
-- =============================================================================

BEGIN;

ALTER TABLE public.ground_truth_calls
  ADD COLUMN IF NOT EXISTS reported_lat DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS reported_lon DOUBLE PRECISION;

COMMIT;
