-- =============================================================================
-- 0012 (down) — Drop the current-location columns.
-- =============================================================================

BEGIN;

ALTER TABLE public.pastoralists
  DROP COLUMN IF EXISTS lat,
  DROP COLUMN IF EXISTS lon,
  DROP COLUMN IF EXISTS location_source,
  DROP COLUMN IF EXISTS location_updated_at;

ALTER TABLE public.pastoralist_leads
  DROP COLUMN IF EXISTS lat,
  DROP COLUMN IF EXISTS lon,
  DROP COLUMN IF EXISTS location_source,
  DROP COLUMN IF EXISTS location_updated_at;

COMMIT;
