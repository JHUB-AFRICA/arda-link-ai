-- =============================================================================
-- Demo seed — Tuesday verification
-- Idempotent: re-running this file will not duplicate data (ON CONFLICT
-- clauses on tenants/feature flags; reports use replace-and-increment IDs).
--
-- Tenant model (2026-07-08 onward): aligned with Supabase's active_wards.
-- Each tenant slug maps 1:1 to a Supabase ward_id via lib/wardMapping.ts.
-- Isiolo Sub-County has 5 finished wards; we seed 3 as demo tenants:
--   bula-pesa   ↔ 242  (Bulla Pesa)
--   ngare-mara  ↔ 245  (Ngare Mara)
--   burat       ↔ 246  (Burat)
-- The other two wards (wabera 241, oldonyiro 247) are known to
-- lib/wardMapping.ts but not seeded here — add rows as needed.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Tenants (already in 0001 migration, but harmless to repeat)
-- ---------------------------------------------------------------------------
INSERT INTO public.tenants (tenant_id, display_name, region) VALUES
  ('bula-pesa',   'Bula Pesa Ward',   'Isiolo County'),
  ('ngare-mara',  'Ngare Mara Ward',  'Isiolo County'),
  ('burat',       'Burat Ward',       'Isiolo County')
ON CONFLICT (tenant_id) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  region       = EXCLUDED.region,
  updated_at   = now();

-- Retired demo tenants — remove any stale rows from earlier seed runs so
-- the RLS assertions in tests continue to hold. Safe on empty tables.
DELETE FROM public.tenant_feature_flags WHERE tenant_id IN ('garbatulla','merti');
DELETE FROM public.ground_truth_reports WHERE tenant_id IN ('garbatulla','merti');
DELETE FROM public.pastoralists         WHERE tenant_id IN ('garbatulla','merti');
DELETE FROM public.admin_users          WHERE tenant_id IN ('garbatulla','merti');
DELETE FROM public.tenants              WHERE tenant_id IN ('garbatulla','merti');
DELETE FROM gis_engine.tenants          WHERE tenant_id IN ('garbatulla','merti');

-- ---------------------------------------------------------------------------
-- 2. Feature flags (illustrate per-tenant capability control)
-- ---------------------------------------------------------------------------
INSERT INTO public.tenant_feature_flags (tenant_id, flag_key, enabled) VALUES
  ('bula-pesa',   'voice_outbound', TRUE),
  ('bula-pesa',   'public_talk',    TRUE),
  ('bula-pesa',   'ground_truth',   TRUE),
  ('bula-pesa',   'cost_rails',     TRUE),
  ('ngare-mara',  'voice_outbound', TRUE),
  ('ngare-mara',  'public_talk',    FALSE),
  ('ngare-mara',  'ground_truth',   TRUE),
  ('ngare-mara',  'cost_rails',     TRUE),
  ('burat',       'voice_outbound', FALSE),
  ('burat',       'public_talk',    FALSE),
  ('burat',       'ground_truth',   TRUE),
  ('burat',       'cost_rails',     FALSE)
ON CONFLICT (tenant_id, flag_key) DO UPDATE SET
  enabled = EXCLUDED.enabled,
  updated_at = now();

-- ---------------------------------------------------------------------------
-- 3. Pastoralists — 5 per tenant
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
  -- Burat (ward 246 — no voice, ground-truth only)
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

-- ---------------------------------------------------------------------------
-- 4. Ground-truth reports — 12 per tenant, spread across the last 30 days
--    Each report has a different stress profile to make the dashboard feel real.
--    NDVI values are realistic for Isiolo drylands (0.10 - 0.55).
-- ---------------------------------------------------------------------------

-- ----- Bula Pesa: drought stress, declining NDVI, water issues -----
INSERT INTO public.ground_truth_reports
  (tenant_id, phone, month, timestamp, user_feedback, action_tag,
   bcs_score, bcs_species, bcs_confidence, bcs_flag_followup,
   offtake_rate, mortality_rate, milk_production,
   water_trekking_distance, water_point_name, water_point_status,
   supplementary_feeding,
   reported_quadrant, reported_location,
   ndvi_score, ndvi_vs_baseline_percent, rainfall_30day_mm, soil_moisture_index,
   call_duration_seconds, indicators_collected, data_completeness_percent,
   trust_score, trust_flags,
   data_methodology_version, standards_applied)
SELECT
  'bula-pesa', '+254712000004', '2026-06',
  now() - (d || ' days')::interval,
  'Herder: Cattle are thin and we are walking far for water.\nArdaLink: How far?',
  CASE (d % 4) WHEN 0 THEN 'water_access_concern'
                WHEN 1 THEN 'livestock_stress'
                WHEN 2 THEN 'no_action'
                ELSE 'pasture_quality' END,
  CASE (d % 3) WHEN 0 THEN 2.4 WHEN 1 THEN 2.7 ELSE 3.0 END,
  'cattle', CASE (d % 4) WHEN 0 THEN 'medium' ELSE 'high' END, FALSE,
  CASE (d % 3) WHEN 0 THEN 'early' WHEN 1 THEN 'normal' ELSE 'not_selling' END,
  CASE (d % 4) WHEN 0 THEN '4-plus' WHEN 1 THEN '1-3' ELSE 'none' END,
  CASE (d % 3) WHEN 0 THEN 'reduced' WHEN 1 THEN 'stopped' ELSE 'normal' END,
  CASE (d % 4) WHEN 0 THEN 'over_10km' WHEN 1 THEN '5-10km' ELSE 'under_5km' END,
  'Bulla Pesa dam', 'operational_poor',
  CASE (d % 2) WHEN 0 THEN 'no' ELSE 'planning' END,
  'SW', 'Bulla Pesa',
  0.18 + (d * 0.01), -28.0 - (d * 0.3), 12.0 + (d * 0.5), 0.15,
  180 + (d * 5), 7, 78.0,
  72, '[]'::jsonb,
  'v1.0', 'ILRI/FAO BCS, FEWS NET, LEGS, WFP CSI, FAO AWG'
FROM generate_series(1, 12) d
WHERE NOT EXISTS (SELECT 1 FROM public.ground_truth_reports WHERE tenant_id = 'bula-pesa');

-- ----- Ngare Mara: moderate stress, mixed water sources -----
INSERT INTO public.ground_truth_reports
  (tenant_id, phone, month, timestamp, user_feedback, action_tag,
   bcs_score, bcs_species, bcs_confidence, bcs_flag_followup,
   offtake_rate, mortality_rate, milk_production,
   water_trekking_distance, water_point_name, water_point_status,
   supplementary_feeding,
   reported_quadrant, reported_location,
   ndvi_score, ndvi_vs_baseline_percent, rainfall_30day_mm, soil_moisture_index,
   call_duration_seconds, indicators_collected, data_completeness_percent,
   trust_score, trust_flags,
   data_methodology_version, standards_applied)
SELECT
  'ngare-mara', '+254722000003', '2026-06',
  now() - (d || ' days')::interval,
  'Herder: Animals are okay but water is far.\nArdaLink: Where do you go?',
  CASE (d % 3) WHEN 0 THEN 'livestock_stress' WHEN 1 THEN 'no_action' ELSE 'water_access_concern' END,
  CASE (d % 3) WHEN 0 THEN 2.9 WHEN 1 THEN 3.3 ELSE 3.5 END,
  'mixed', 'high', FALSE,
  'normal', 'none', 'normal',
  CASE (d % 3) WHEN 0 THEN '5-10km' WHEN 1 THEN 'under_5km' ELSE 'over_10km' END,
  'Kambi Garba dam', 'operational_good',
  'no',
  'NE', 'Kambi Garba',
  0.32 + (d * 0.005), -8.0 - (d * 0.2), 25.0, 0.28,
  200 + (d * 3), 6, 82.0,
  85, '[]'::jsonb,
  'v1.0', 'ILRI/FAO BCS, FEWS NET, LEGS, WFP CSI, FAO AWG'
FROM generate_series(1, 12) d
WHERE NOT EXISTS (SELECT 1 FROM public.ground_truth_reports WHERE tenant_id = 'ngare-mara');

-- ----- Burat: stable, no voice, only ground-truth -----
INSERT INTO public.ground_truth_reports
  (tenant_id, phone, month, timestamp, user_feedback, action_tag,
   bcs_score, bcs_species, bcs_confidence, bcs_flag_followup,
   offtake_rate, mortality_rate, milk_production,
   water_trekking_distance, water_point_name, water_point_status,
   supplementary_feeding,
   reported_quadrant, reported_location,
   ndvi_score, ndvi_vs_baseline_percent, rainfall_30day_mm, soil_moisture_index,
   call_duration_seconds, indicators_collected, data_completeness_percent,
   trust_score, trust_flags,
   data_methodology_version, standards_applied)
SELECT
  'burat', '+254732000001', '2026-06',
  now() - (d || ' days')::interval,
  'Herder (in-person): Camels are doing well.\nOperator: BCS looks good.',
  'no_action',
  3.8, 'camels', 'high', FALSE,
  'normal', 'none', 'normal',
  'under_5km', 'Burat pan', 'operational_good',
  'no',
  'NW', 'Burat',
  0.42 + (d * 0.003), 5.0, 35.0, 0.35,
  240, 5, 90.0,
  91, '[]'::jsonb,
  'v1.0', 'ILRI/FAO BCS, FEWS NET, LEGS, WFP CSI, FAO AWG'
FROM generate_series(1, 12) d
WHERE NOT EXISTS (SELECT 1 FROM public.ground_truth_reports WHERE tenant_id = 'burat');

-- ---------------------------------------------------------------------------
-- 5. gis_engine.tenants (mirrors public.tenants; legacy kept both)
-- ---------------------------------------------------------------------------
INSERT INTO gis_engine.tenants (tenant_id, display_name, region) VALUES
  ('bula-pesa',   'Bula Pesa Ward',   'Isiolo County'),
  ('ngare-mara',  'Ngare Mara Ward',  'Isiolo County'),
  ('burat',       'Burat Ward',       'Isiolo County')
ON CONFLICT (tenant_id) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  region       = EXCLUDED.region,
  updated_at   = now();

COMMIT;

-- ---------------------------------------------------------------------------
-- Verification counts (read-only)
-- ---------------------------------------------------------------------------
SELECT 'tenants' AS table, COUNT(*) AS rows FROM public.tenants
UNION ALL
SELECT 'feature_flags', COUNT(*) FROM public.tenant_feature_flags
UNION ALL
SELECT 'pastoralists',  COUNT(*) FROM public.pastoralists
UNION ALL
SELECT 'reports/bula-pesa',   COUNT(*) FROM public.ground_truth_reports WHERE tenant_id = 'bula-pesa'
UNION ALL
SELECT 'reports/ngare-mara',  COUNT(*) FROM public.ground_truth_reports WHERE tenant_id = 'ngare-mara'
UNION ALL
SELECT 'reports/burat',       COUNT(*) FROM public.ground_truth_reports WHERE tenant_id = 'burat';
-- ---------------------------------------------------------------------------
-- 6. Admin users (operators). One per tenant + a super-admin.
--
-- Demo credentials (rotate before any non-dev deploy):
--   bula-pesa@ardalink.test    / bula-pesa
--   ngare-mara@ardalink.test   / ngare-mara
--   burat@ardalink.test        / burat
--   admin@ardalink.test        / admin-secret-2024   (super-admin, tenant=bula-pesa)
--
-- password_hash format: <salt-hex>:<scrypt-hash-hex>
-- scrypt N=2^14, keylen=64, salt=16 bytes random
--
-- 2026-07-21 note: ngare-mara and burat now use scrypt hashes of their
-- own tenant slugs (passwords 'ngare-mara' and 'burat'). The earlier
-- shim that reused garbatulla/merti hashes has been removed to keep
-- passwords legible in the demo UI. Local DBs seeded before this date
-- must re-run this file after DELETE FROM admin_users, since ON CONFLICT
-- DO NOTHING will not update existing rows.
-- ---------------------------------------------------------------------------
INSERT INTO public.admin_users (email, password_hash, tenant_id, display_name, role) VALUES
  ('bula-pesa@ardalink.test',
   '1a96892f327c940b07cc79300af59cf6:578c567dada55fe196d8578fe76c033d1fbbfd4994d57ea6727efadbf2023b8ed71ec895cffe349f6f11b3e8e9f4ecb5879b880d6be0da043e33392dada08d8e',
   'bula-pesa', 'Bula Pesa Operator', 'operator'),
  ('ngare-mara@ardalink.test',
   '1d097c17e6cd93c222f637be2448d386:eeeba9c2f688656bc370b04e11c5f249da3a2a783017e8a97aa57c0915a6d1956935a5c4991cf4b7cfca7da104b0eda5e8675304e11d3397aef381a02f04a16f',
   'ngare-mara', 'Ngare Mara Operator', 'operator'),
  ('burat@ardalink.test',
   '658a8ea890591b83ab39a87fea895aeb:fda48598f61a0b16efd2549ebfe8dbc5c2e71e9594afa16cf54b36e2181c2002bae4161ee1af7974aeca1a47026d67eb98180e75d49c4b87bde1637678aabf8a',
   'burat', 'Burat Operator', 'operator'),
  ('admin@ardalink.test',
   '66e155393a3d7f6ffcbb31cb81f32a42:862ed3af464671e6ec9fef3af544f64917484d7cde33f9bd52841f0db8b79bce1128e862ff59f5fc5c9971b567199776ba3a15325de545ee04bcfb392f168a67',
   'bula-pesa', 'System Admin', 'admin')
ON CONFLICT (email) DO UPDATE
  SET password_hash = EXCLUDED.password_hash,
      tenant_id     = EXCLUDED.tenant_id,
      display_name  = EXCLUDED.display_name,
      role          = EXCLUDED.role;
