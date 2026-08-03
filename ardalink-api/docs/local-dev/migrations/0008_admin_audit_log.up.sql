-- =============================================================================
-- 0008 — Add admin_audit_log: who changed what, when, why.
--
-- One additive table backing the operator data-management console (water
-- source edits, species-ring-radii tuning, ground-truth corrections,
-- pastoralist edits, lead actions). Every write endpoint in that console
-- calls src/lib/adminAudit.ts's recordAudit() around its own write — this
-- table is pure audit trail, never itself the source of truth for any
-- resource's current state (before/after JSON is a record of what
-- happened, not something anything reads back to reconstruct state).
--
-- IDEMPOTENT. Safe to re-run.
--
-- OPERATIONAL NOTE: this table is LOCAL-MIRROR ONLY, same as
-- grazing_ring_pending (migration 0006) — never synced to/from Supabase.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.admin_audit_log (
    id           SERIAL PRIMARY KEY,
    actor_sub    TEXT NOT NULL,
    tenant_id    TEXT NOT NULL,
    resource     TEXT NOT NULL,
    resource_id  TEXT NOT NULL,
    action       TEXT NOT NULL,
    before       JSONB,
    after        JSONB,
    reason       TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_log_resource
    ON public.admin_audit_log (resource, resource_id);
CREATE INDEX IF NOT EXISTS idx_admin_audit_log_created_at
    ON public.admin_audit_log (created_at DESC);

COMMIT;
