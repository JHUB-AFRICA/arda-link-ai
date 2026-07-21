-- =============================================================================
-- 0003 — Realign local Postgres to be a real mirror of Supabase (DOWN).
--
-- Partial rollback only:
--
--   * Drops the seven mirror tables introduced by 0003.up.
--   * Re-inserts the two retired tenants (`garbatulla`, `merti`) so the
--     tenants table looks the way it did before 0003.up ran.
--   * Removes the four canonical wards that 0003.up added.
--
-- Rollback is NOT lossless. The following data is unrecoverable:
--
--   * Rows purged from pastoralists / ground_truth_reports /
--     tenant_feature_flags / admin_users because they pointed at
--     `garbatulla` or `merti`.
--   * Rows purged from satellite_snapshots / climate_snapshots because
--     they carried the pseudo-tenant `isiolo` or a NULL tenant.
--
-- Restore from a pg_dump if you need those rows back. The design
-- assumption (see the accompanying PR description) is that those rows
-- were pre-pilot leaked test data whose deletion is desirable, but
-- this .down.sql leaves a paper trail in case someone later needs the
-- rollback path for a schema-only reason.
-- =============================================================================

BEGIN;

-- Drop mirror tables in reverse creation order.
DROP TABLE IF EXISTS public.weather_forecast;
DROP TABLE IF EXISTS public.ground_truth_calls;
DROP TABLE IF EXISTS public.weather_data;
DROP TABLE IF EXISTS public.satellite_indices;
DROP TABLE IF EXISTS public.ward_cells;
DROP TABLE IF EXISTS public.lead_interactions;
DROP TABLE IF EXISTS public.pastoralist_leads;

-- Undo the tenants change.
DELETE FROM public.tenants
 WHERE tenant_id IN ('wabera', 'ngare-mara', 'burat', 'oldonyiro');

INSERT INTO public.tenants (tenant_id, display_name, region) VALUES
    ('garbatulla', 'Garbatulla Ward', 'Isiolo County'),
    ('merti',      'Merti Ward',      'Isiolo County')
ON CONFLICT (tenant_id) DO NOTHING;

COMMIT;
