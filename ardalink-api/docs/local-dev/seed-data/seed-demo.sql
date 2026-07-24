-- =============================================================================
-- OPTIONAL demo data — fake pastoralists for visual demos.
--
-- Structural bootstrap (tenants, operator logins, feature flags) lives
-- in `../migrations/0004_bootstrap_operator_accounts.up.sql` and runs
-- unconditionally on every stack bring-up. THIS file only exists for
-- visual demos when a fresh DB is easier to look at with placeholder
-- rows than an empty one.
--
-- **Never run in production.** Every row inserted here is synthetic
-- and would pollute pilot analytics. `start-local.sh` only runs this
-- file when `SEED_DEMO_DATA=1` is set in the environment (default
-- off).
--
-- Idempotent — replay-safe. `ON CONFLICT DO UPDATE` on pastoralists.
--
-- Content: 5 pastoralists for each of three primary demo tenants
-- (bula-pesa, ngare-mara, burat). Wabera and Oldonyiro operators log
-- in against the bootstrap accounts but see an empty dashboard — real
-- herder data lands via USSD/SMS/voice.
--
-- Retired tenants: garbatulla, merti, kinna were used in early demos
-- and must not appear as active tenants. Any orphan rows are deleted
-- on each replay of this file so a stale DB can't carry them forward.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 0. Retire orphan rows from retired demo tenants.
--    Safe to run even if no rows exist — DELETE is a no-op then.
-- ---------------------------------------------------------------------------
DELETE FROM public.pastoralists WHERE tenant_id IN ('garbatulla', 'merti', 'kinna');

-- ---------------------------------------------------------------------------
-- 1. Pastoralists — 5 per primary demo tenant.
-- ---------------------------------------------------------------------------
INSERT INTO public.pastoralists (tenant_id, name, phone, location, cattle, goats, camels, water_source, alerts_enabled, alerts_sent) VALUES
  -- Bula Pesa (ward 242)
  ('bula-pesa',   'Halima Hassan',     '+254712000001', 'Kula Pesa',    25, 15, 0, 'Bula Pesa borehole', TRUE, 3),
  ('bula-pesa',   'Hassan Abdi',       '+254712000002', 'Kula Pesa',    40, 30, 0, 'Bula Pesa borehole', TRUE, 5),
  ('bula-pesa',   'Amina Yusuf',       '+254712000003', 'Gotu',         18,  8, 0, 'Gotu pan',           TRUE, 2),
  ('bula-pesa',   'Mohamed Ali',       '+254712000004', 'Bulla Pesa',   60, 40, 0, 'Bulla Pesa dam',     TRUE, 6),
  ('bula-pesa',   'Fatma Ibrahim',     '+254712000005', 'Kula Pesa',    12, 20, 0, 'Bula Pesa borehole', TRUE, 1),
  -- Ngare Mara (ward 245)
  ('ngare-mara',  'Yusuf Omar',        '+254722000001', 'Ngare Mara',   30, 25, 5, 'Ngare Mara spring',  TRUE, 4),
  ('ngare-mara',  'Safia Hassan',      '+254722000002', 'Ngare Mara',   50, 30, 2, 'Ngare Mara spring',  TRUE, 5),
  ('ngare-mara',  'Ibrahim Noor',      '+254722000003', 'Kambi Garba',  80, 40, 0, 'Kambi Garba dam',    TRUE, 7),
  ('ngare-mara',  'Khadija Mohamed',   '+254722000004', 'Ngare Mara',   20, 15, 0, 'Ngare Mara spring',  TRUE, 3),
  ('ngare-mara',  'Omar Sheikh',       '+254722000005', 'Kambi Garba',  45, 35, 0, 'Kambi Garba dam',    TRUE, 4),
  -- Burat (ward 246)
  ('burat',       'Aisha Abdullahi',   '+254732000001', 'Burat',        15,  5, 8, 'Burat pan',          TRUE, 0),
  ('burat',       'Daud Mahamud',      '+254732000002', 'Burat',        35, 20, 3, 'Burat pan',          TRUE, 0),
  ('burat',       'Hawa Abdullahi',    '+254732000003', 'Burat',         8,  4, 6, 'Burat borehole',     TRUE, 0),
  ('burat',       'Abdirahman Hassan', '+254732000004', 'Burat',        22, 10, 4, 'Burat pan',          TRUE, 0),
  ('burat',       'Maryan Yusuf',      '+254732000005', 'Burat',        18, 12, 2, 'Burat pan',          TRUE, 0)
ON CONFLICT (tenant_id, phone) DO UPDATE SET
  name = EXCLUDED.name,
  cattle = EXCLUDED.cattle,
  goats = EXCLUDED.goats,
  alerts_sent = EXCLUDED.alerts_sent;

COMMIT;

-- ---------------------------------------------------------------------------
-- Verification counts (read-only)
-- ---------------------------------------------------------------------------
SELECT 'pastoralists/bula-pesa'  AS scope, COUNT(*) AS rows FROM public.pastoralists WHERE tenant_id = 'bula-pesa'
UNION ALL
SELECT 'pastoralists/ngare-mara', COUNT(*) FROM public.pastoralists WHERE tenant_id = 'ngare-mara'
UNION ALL
SELECT 'pastoralists/burat',      COUNT(*) FROM public.pastoralists WHERE tenant_id = 'burat';
