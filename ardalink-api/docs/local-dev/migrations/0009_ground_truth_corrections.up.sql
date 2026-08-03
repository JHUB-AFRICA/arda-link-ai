-- =============================================================================
-- 0009 — Add ground_truth_corrections: operator review layer.
--
-- ground_truth_calls is deliberately append-only (see 0003/0005's own
-- history — nothing UPDATEs it, and ops/leads.ts's header explicitly
-- states "Never mutates ground_truth_calls or ground_truth_reports").
-- LLM-extracted indicators flow in unreviewed; this table is the
-- correction layer that respects that invariant instead of violating it —
-- one row per corrected FIELD (not per call), referencing the original
-- call_id, so a single call can accumulate multiple independent
-- corrections over time without overwriting each other, and a correction
-- can itself later be re-corrected with full history preserved.
--
-- `field` is validated against an application-level allowlist
-- (src/routes/ops/admin.ts) — never a free-form column name.
--
-- IDEMPOTENT. Safe to re-run.
--
-- OPERATIONAL NOTE: ground_truth_calls' source of truth is Supabase, not
-- this local mirror — same for its correction layer. This migration
-- covers local dev only; the same table must ALSO be created directly
-- against the live Supabase project (Supabase SQL editor) before
-- corrections persist server-side. Until then, src/lib/supabase/groundTruth.ts's
-- insertGroundTruthCorrection() fails soft (same sbInsert non-2xx->null
-- contract as every other Supabase write in this repo).
-- =============================================================================

BEGIN;

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
