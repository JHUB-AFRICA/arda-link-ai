-- =============================================================================
-- 0004 — Bootstrap operator accounts + per-tenant feature flags.
--
-- This is structural bootstrap, NOT demo seed. Every ArdaLink deploy
-- (dev, staging, prod) needs:
--
--   * one operator login per tenant so the dashboard is usable;
--   * one super-admin login for cross-tenant work;
--   * default feature flags per tenant so the API doesn't silently
--     disable herder-facing features when a tenant row appears without
--     a matching flag row.
--
-- Pre-2026-07-21 this content lived in `seed-data/seed-demo.sql` mixed
-- in with fake pastoralists / ground-truth reports. That mix meant you
-- could not bring the stack up without also seeding pilot-adjacent
-- test data. This migration splits the two: structural rows land here,
-- optional demo data stays in seed-demo.sql and is opt-in via
-- SEED_DEMO_DATA=1 in start-local.sh.
--
-- Idempotent. Password hashes rotate cleanly via ON CONFLICT DO UPDATE.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Operator accounts — one per canonical Isiolo Sub-County ward + admin.
--
-- password_hash format: <salt-hex>:<scrypt-hash-hex>
-- scrypt N=2^14, keylen=64, salt=16 bytes random.
-- Passwords equal tenant slug (dev-only convention — rotate before any
-- non-dev deploy via the dashboard's password-change flow).
-- ---------------------------------------------------------------------------

INSERT INTO public.admin_users (email, password_hash, tenant_id, display_name, role) VALUES
  ('wabera@ardalink.test',
   '94c5cf2088a6a76f312622a07f7dbc1c:f50481ee063f919d122073f99f400e913b0a5226cb6d63f93e3fc6ed5ac06e3b724f1d1e22394ba536f63c6a4671b53508b25e91e14859cdab5154682d2a0487',
   'wabera', 'Wabera Operator', 'operator'),
  ('bula-pesa@ardalink.test',
   '1a96892f327c940b07cc79300af59cf6:578c567dada55fe196d8578fe76c033d1fbbfd4994d57ea6727efadbf2023b8ed71ec895cffe349f6f11b3e8e9f4ecb5879b880d6be0da043e33392dada08d8e',
   'bula-pesa', 'Bula Pesa Operator', 'operator'),
  ('ngare-mara@ardalink.test',
   '1d097c17e6cd93c222f637be2448d386:eeeba9c2f688656bc370b04e11c5f249da3a2a783017e8a97aa57c0915a6d1956935a5c4991cf4b7cfca7da104b0eda5e8675304e11d3397aef381a02f04a16f',
   'ngare-mara', 'Ngare Mara Operator', 'operator'),
  ('burat@ardalink.test',
   '658a8ea890591b83ab39a87fea895aeb:fda48598f61a0b16efd2549ebfe8dbc5c2e71e9594afa16cf54b36e2181c2002bae4161ee1af7974aeca1a47026d67eb98180e75d49c4b87bde1637678aabf8a',
   'burat', 'Burat Operator', 'operator'),
  ('oldonyiro@ardalink.test',
   '268de45ed49f76e463da90238c734d7c:5221da7157ada2d5bafea70bb9e901406855c774ee3ad74053647fb192fd29950b148f662a8a4ef8500aadce71fbaab58d700077f6796ed9c25ac9b83f277f57',
   'oldonyiro', 'Oldonyiro Operator', 'operator'),
  ('admin@ardalink.test',
   '66e155393a3d7f6ffcbb31cb81f32a42:862ed3af464671e6ec9fef3af544f64917484d7cde33f9bd52841f0db8b79bce1128e862ff59f5fc5c9971b567199776ba3a15325de545ee04bcfb392f168a67',
   'bula-pesa', 'System Admin', 'admin')
ON CONFLICT (email) DO UPDATE
  SET password_hash = EXCLUDED.password_hash,
      tenant_id     = EXCLUDED.tenant_id,
      display_name  = EXCLUDED.display_name,
      role          = EXCLUDED.role;

-- ---------------------------------------------------------------------------
-- 2. Default feature flags per canonical tenant.
--
-- Every tenant gets the same four flags on. Operators (or a future
-- ops UI) can flip individual flags off; the default is "everything on
-- except the ones we don't have infra for yet." Missing flags read as
-- FALSE in the API so a tenant without a row here is silently degraded
-- — that's what this bootstrap prevents.
-- ---------------------------------------------------------------------------

INSERT INTO public.tenant_feature_flags (tenant_id, flag_key, enabled)
SELECT t.tenant_id, f.flag_key, TRUE
  FROM public.tenants t
  CROSS JOIN (VALUES
    ('voice_outbound'),
    ('public_talk'),
    ('ground_truth'),
    ('cost_rails')
  ) AS f(flag_key)
ON CONFLICT (tenant_id, flag_key) DO NOTHING;

COMMIT;
