-- =============================================================================
-- Migration 0001 — Multi-tenant data model (forward) for ardalink-api/public
-- Idempotent: re-running produces no errors.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.tenants (
    tenant_id     TEXT PRIMARY KEY,
    display_name  TEXT NOT NULL,
    region        TEXT NOT NULL,
    active        BOOLEAN NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO public.tenants (tenant_id, display_name, region) VALUES
    ('bula-pesa',  'Bula Pesa Ward',  'Isiolo County'),
    ('garbatulla', 'Garbatulla Ward', 'Isiolo County'),
    ('merti',      'Merti Ward',      'Isiolo County')
ON CONFLICT (tenant_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.tenant_feature_flags (
    tenant_id     TEXT NOT NULL REFERENCES public.tenants(tenant_id) ON DELETE CASCADE,
    flag_key      TEXT NOT NULL,
    enabled       BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, flag_key)
);

DO $$
DECLARE
    rec RECORD;
BEGIN
    FOR rec IN
        SELECT c.relname AS tbl
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind = 'r'
          AND c.relname NOT IN ('tenants', 'tenant_feature_flags', 'migrations', '__drizzle_migrations')
    LOOP
        EXECUTE format(
            'ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS tenant_id TEXT',
            rec.tbl
        );
        EXECUTE format(
            'CREATE INDEX IF NOT EXISTS %I ON public.%I (tenant_id)',
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
        WHERE n.nspname = 'public'
          AND c.relkind = 'r'
          AND c.relname NOT IN ('tenants', 'tenant_feature_flags', 'migrations', '__drizzle_migrations')
    LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', rec.tbl);
        EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', rec.tbl);
        EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', rec.tbl);
        EXECUTE format(
            'CREATE POLICY tenant_isolation ON public.%I '
            'USING (tenant_id = current_setting(''app.current_tenant_id'', TRUE)) '
            'WITH CHECK (tenant_id = current_setting(''app.current_tenant_id'', TRUE))',
            rec.tbl
        );
    END LOOP;
END
$$;

COMMIT;