-- =============================================================================
-- 0008 — Add admin_audit_log (DOWN).
--
-- Rollback is lossy (drops the audit history) but there's no other data
-- depending on this table's presence — nothing reads it back to
-- reconstruct resource state.
-- =============================================================================

BEGIN;

DROP TABLE IF EXISTS public.admin_audit_log;

COMMIT;
