-- =============================================================================
-- 0002 — admin_users
--
-- Operator / admin accounts for the dashboard. Each admin is scoped to
-- exactly one tenant. Login (POST /api/auth/login) takes {email, password}
-- and returns a JWT bound to the admin's tenant_id.
--
-- NOTE: RLS is intentionally NOT enabled on this table. The auth lookup
-- runs before the tenant context is known, so a tenant_id-based RLS
-- policy would hide every row. The application layer (auth route)
-- is the security boundary here: it returns the user only if the
-- password matches, and the resulting JWT carries the tenant_id
-- claim which IS subject to RLS on every other table.
--
-- We must explicitly DISABLE RLS + drop the auto-applied policy
-- because the 0001 migration enables RLS on every public.* table.
--
-- password_hash is `salt:scrypt-hash-hex` (Node crypto.scrypt, 64 bytes,
-- 16-byte salt). See src/routes/auth.ts for the verify path.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.admin_users (
    id              SERIAL PRIMARY KEY,
    email           TEXT NOT NULL UNIQUE,
    password_hash   TEXT NOT NULL,
    tenant_id       TEXT NOT NULL REFERENCES public.tenants(tenant_id) ON DELETE CASCADE,
    display_name    TEXT NOT NULL,
    role            TEXT NOT NULL DEFAULT 'operator'
                    CHECK (role IN ('operator', 'supervisor', 'admin')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_login_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS admin_users_tenant_id_idx
    ON public.admin_users (tenant_id);

-- Disable RLS on this table only. The 0001 loop auto-enables RLS on
-- every public.* table; admin_users is the explicit exception.
ALTER TABLE public.admin_users DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON public.admin_users;

COMMIT;
