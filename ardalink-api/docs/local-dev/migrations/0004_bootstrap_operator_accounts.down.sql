-- =============================================================================
-- 0004 — DOWN — Bootstrap operator accounts + per-tenant feature flags.
--
-- Removes the six seeded operator logins and every tenant_feature_flags
-- row inserted by the up migration. Non-destructive: leaves the
-- tables in place (they're structural, defined in earlier migrations).
--
-- Any operator whose password was rotated via the dashboard *after*
-- the up migration ran will lose their login on rollback. In dev this
-- is fine — rerun the up migration to restore the default hashes.
-- =============================================================================

BEGIN;

DELETE FROM public.admin_users
 WHERE email IN (
   'wabera@ardalink.test',
   'bula-pesa@ardalink.test',
   'ngare-mara@ardalink.test',
   'burat@ardalink.test',
   'oldonyiro@ardalink.test',
   'admin@ardalink.test'
 );

DELETE FROM public.tenant_feature_flags
 WHERE flag_key IN ('voice_outbound', 'public_talk', 'ground_truth', 'cost_rails');

COMMIT;
