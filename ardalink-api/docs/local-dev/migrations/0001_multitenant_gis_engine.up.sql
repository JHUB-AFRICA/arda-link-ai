-- =============================================================================
-- Migration 0001 — Multi-tenant data model (forward) for ardalink-engine/gis_engine
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS gis_engine.tenants (
    tenant_id     TEXT PRIMARY KEY,
    display_name  TEXT NOT NULL,
    region        TEXT NOT NULL,
    bbox_s        DOUBLE PRECISION,
    bbox_w        DOUBLE PRECISION,
    bbox_n        DOUBLE PRECISION,
    bbox_e        DOUBLE PRECISION,
    active        BOOLEAN NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO gis_engine.tenants (tenant_id, display_name, region, bbox_s, bbox_w, bbox_n, bbox_e)
VALUES
    ('bula-pesa',    'Bula Pesa Ward',   'Isiolo County', -0.6, 36.5, 2.9, 39.6),
    ('garbatulla',   'Garbatulla Ward',  'Isiolo County', -0.6, 36.5, 2.9, 39.6),
    ('merti',        'Merti Ward',       'Isiolo County', -0.6, 36.5, 2.9, 39.6),
    ('legacy',       'Legacy data',      'Pre-multi-tenant', NULL, NULL, NULL, NULL)
ON CONFLICT (tenant_id) DO NOTHING;

DO $$
DECLARE
    rec RECORD;
BEGIN
    FOR rec IN
        SELECT c.relname AS tbl
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'gis_engine'
          AND c.relkind = 'r'
          AND c.relname NOT IN ('tenants')
    LOOP
        EXECUTE format(
            'ALTER TABLE gis_engine.%I ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT %L',
            rec.tbl,
            'legacy'
        );
        EXECUTE format(
            'CREATE INDEX IF NOT EXISTS %I ON gis_engine.%I (tenant_id)',
            rec.tbl || '_tenant_id_idx',
            rec.tbl
        );
    END LOOP;
END
$$;

DO $$
DECLARE
    rec RECORD;
BEGIN
    FOR rec IN
        SELECT c.relname AS tbl
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'gis_engine'
          AND c.relkind = 'r'
          AND c.relname NOT IN ('tenants')
    LOOP
        EXECUTE format('ALTER TABLE gis_engine.%I ENABLE ROW LEVEL SECURITY', rec.tbl);
        EXECUTE format('ALTER TABLE gis_engine.%I FORCE ROW LEVEL SECURITY', rec.tbl);
        EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON gis_engine.%I', rec.tbl);
        EXECUTE format(
            'CREATE POLICY tenant_isolation ON gis_engine.%I '
            'USING (tenant_id = current_setting(''app.current_tenant_id'', TRUE)) '
            'WITH CHECK (tenant_id = current_setting(''app.current_tenant_id'', TRUE))',
            rec.tbl
        );
    END LOOP;
END
$$;

COMMIT;