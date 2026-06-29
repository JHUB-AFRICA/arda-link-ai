-- =============================================================================
-- Demo seed — Tuesday verification
-- Idempotent: re-running this file will not duplicate data (ON CONFLICT
-- clauses on tenants/feature flags; reports use replace-and-increment IDs).
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Tenants (already in 0001 migration, but harmless to repeat)
-- ---------------------------------------------------------------------------
INSERT INTO public.tenants (tenant_id, display_name, region) VALUES
  ('bula-pesa',  'Bula Pesa Ward',  'Isiolo County'),
  ('garbatulla', 'Garbatulla Ward', 'Isiolo County'),
  ('merti',      'Merti Ward',      'Isiolo County')
ON CONFLICT (tenant_id) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  region       = EXCLUDED.region,
  updated_at   = now();

-- ---------------------------------------------------------------------------
-- 2. Feature flags (illustrate per-tenant capability control)
-- ---------------------------------------------------------------------------
INSERT INTO public.tenant_feature_flags (tenant_id, flag_key, enabled) VALUES
  ('bula-pesa',  'voice_outbound', TRUE),
  ('bula-pesa',  'public_talk',    TRUE),
  ('bula-pesa',  'ground_truth',   TRUE),
  ('bula-pesa',  'cost_rails',     TRUE),
  ('garbatulla', 'voice_outbound', TRUE),
  ('garbatulla', 'public_talk',    FALSE),
  ('garbatulla', 'ground_truth',   TRUE),
  ('garbatulla', 'cost_rails',     TRUE),
  ('merti',      'voice_outbound', FALSE),
  ('merti',      'public_talk',    FALSE),
  ('merti',      'ground_truth',   TRUE),
  ('merti',      'cost_rails',     FALSE)
ON CONFLICT (tenant_id, flag_key) DO UPDATE SET
  enabled = EXCLUDED.enabled,
  updated_at = now();

-- ---------------------------------------------------------------------------
-- 3. Pastoralists — 5 per tenant
-- ---------------------------------------------------------------------------
INSERT INTO public.pastoralists (tenant_id, name, phone, location, cattle, goats, camels, water_source, alerts_enabled, alerts_sent) VALUES
  -- Bula Pesa
  ('bula-pesa',  'Halima Hassan',     '+254712000001', 'Kula Pesa', 25, 15, 0, 'Bula Pesa borehole', TRUE, 3),
  ('bula-pesa',  'Hassan Abdi',       '+254712000002', 'Kula Pesa', 40, 30, 0, 'Bula Pesa borehole', TRUE, 5),
  ('bula-pesa',  'Amina Yusuf',       '+254712000003', 'Gotu',      18,  8, 0, 'Gotu pan',            TRUE, 2),
  ('bula-pesa',  'Mohamed Ali',       '+254712000004', 'Bulla Pesa', 60, 40, 0, 'Bulla Pesa dam',     TRUE, 6),
  ('bula-pesa',  'Fatma Ibrahim',     '+254712000005', 'Kula Pesa', 12, 20, 0, 'Bula Pesa borehole', TRUE, 1),
  -- Garbatulla
  ('garbatulla', 'Yusuf Omar',        '+254722000001', 'Garba Tulla', 30, 25, 5, 'Garba Tulla shallow', TRUE, 4),
  ('garbatulla', 'Safia Hassan',      '+254722000002', 'Garba Tulla', 50, 30, 2, 'Garba Tulla shallow', TRUE, 5),
  ('garbatulla', 'Ibrahim Noor',      '+254722000003', 'Kinna',       80, 40, 0, 'Kinna river',         TRUE, 7),
  ('garbatulla', 'Khadija Mohamed',   '+254722000004', 'Garba Tulla', 20, 15, 0, 'Garba Tulla shallow', TRUE, 3),
  ('garbatulla', 'Omar Sheikh',       '+254722000005', 'Kinna',       45, 35, 0, 'Kinna river',         TRUE, 4),
  -- Merti (no voice — feature flag off)
  ('merti',      'Aisha Abdullahi',   '+254732000001', 'Merti',      15,  5, 8, 'Merti pan',           TRUE, 0),
  ('merti',      'Daud Mahamud',      '+254732000002', 'Merti',      35, 20, 3, 'Merti pan',           TRUE, 0),
  ('merti',      'Hawa Abdullahi',    '+254732000003', 'Sericho',     8,  4, 6, 'Sericho borehole',    TRUE, 0),
  ('merti',      'Abdirahman Hassan', '+254732000004', 'Merti',      22, 10, 4, 'Merti pan',           TRUE, 0),
  ('merti',      'Maryan Yusuf',      '+254732000005', 'Merti',      18, 12, 2, 'Merti pan',           TRUE, 0)
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

-- ----- Garbatulla: moderate stress, mixed water sources -----
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
  'garbatulla', '+254722000003', '2026-06',
  now() - (d || ' days')::interval,
  'Herder: Animals are okay but water is far.\nArdaLink: Where do you go?',
  CASE (d % 3) WHEN 0 THEN 'livestock_stress' WHEN 1 THEN 'no_action' ELSE 'water_access_concern' END,
  CASE (d % 3) WHEN 0 THEN 2.9 WHEN 1 THEN 3.3 ELSE 3.5 END,
  'mixed', 'high', FALSE,
  'normal', 'none', 'normal',
  CASE (d % 3) WHEN 0 THEN '5-10km' WHEN 1 THEN 'under_5km' ELSE 'over_10km' END,
  'Kinna river', 'operational_good',
  'no',
  'NE', 'Kinna',
  0.32 + (d * 0.005), -8.0 - (d * 0.2), 25.0, 0.28,
  200 + (d * 3), 6, 82.0,
  85, '[]'::jsonb,
  'v1.0', 'ILRI/FAO BCS, FEWS NET, LEGS, WFP CSI, FAO AWG'
FROM generate_series(1, 12) d
WHERE NOT EXISTS (SELECT 1 FROM public.ground_truth_reports WHERE tenant_id = 'garbatulla');

-- ----- Merti: stable, no voice, only ground-truth -----
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
  'merti', '+254732000001', '2026-06',
  now() - (d || ' days')::interval,
  'Herder (in-person): Camels are doing well.\nOperator: BCS looks good.',
  'no_action',
  3.8, 'camels', 'high', FALSE,
  'normal', 'none', 'normal',
  'under_5km', 'Merti pan', 'operational_good',
  'no',
  'NW', 'Merti',
  0.42 + (d * 0.003), 5.0, 35.0, 0.35,
  240, 5, 90.0,
  91, '[]'::jsonb,
  'v1.0', 'ILRI/FAO BCS, FEWS NET, LEGS, WFP CSI, FAO AWG'
FROM generate_series(1, 12) d
WHERE NOT EXISTS (SELECT 1 FROM public.ground_truth_reports WHERE tenant_id = 'merti');

-- ---------------------------------------------------------------------------
-- 5. gis_engine.tenants (mirrors public.tenants; legacy kept both)
-- ---------------------------------------------------------------------------
INSERT INTO gis_engine.tenants (tenant_id, display_name, region) VALUES
  ('bula-pesa',  'Bula Pesa Ward',  'Isiolo County'),
  ('garbatulla', 'Garbatulla Ward', 'Isiolo County'),
  ('merti',      'Merti Ward',      'Isiolo County')
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
SELECT 'reports/bula-pesa',  COUNT(*) FROM public.ground_truth_reports WHERE tenant_id = 'bula-pesa'
UNION ALL
SELECT 'reports/garbatulla', COUNT(*) FROM public.ground_truth_reports WHERE tenant_id = 'garbatulla'
UNION ALL
SELECT 'reports/merti',      COUNT(*) FROM public.ground_truth_reports WHERE tenant_id = 'merti';
-- ---------------------------------------------------------------------------
-- 4. Admin users (operators). One per tenant + a super-admin.
--
-- Demo credentials (rotate before any non-dev deploy):
--   bula-pesa@ardalink.test    / bula-pesa
--   garbatulla@ardalink.test   / garbatulla
--   merti@ardalink.test        / merti
--   admin@ardalink.test        / admin-secret-2024   (super-admin, tenant=bula-pesa)
--
-- password_hash format: <salt-hex>:<scrypt-hash-hex>
-- scrypt N=2^14, keylen=64, salt=16 bytes random
-- ---------------------------------------------------------------------------
INSERT INTO public.admin_users (email, password_hash, tenant_id, display_name, role) VALUES
  ('bula-pesa@ardalink.test',
   '1a96892f327c940b07cc79300af59cf6:578c567dada55fe196d8578fe76c033d1fbbfd4994d57ea6727efadbf2023b8ed71ec895cffe349f6f11b3e8e9f4ecb5879b880d6be0da043e33392dada08d8e',
   'bula-pesa', 'Bula Pesa Operator', 'operator'),
  ('garbatulla@ardalink.test',
   '484f9e1ce229bdccdcefe75628e9b969:4e300efc2d6e02d093bbf200b966f607648a993cd742a4482fae0e88b929ee7006324178c546396a92572c2526230b321d17277a433258d576f574d9a8bcdb01',
   'garbatulla', 'Garbatulla Operator', 'operator'),
  ('merti@ardalink.test',
   'd0da46b07bfa17f7845fb78df865e44d:4c49ffec4727079a500316d70d8efa426507debd540eadc9a05d7b551e11732f40ebd96d5c2629f61f866592c638165af1cc619ee5f660138557b6422168b6e4',
   'merti', 'Merti Operator', 'operator'),
  ('admin@ardalink.test',
   '66e155393a3d7f6ffcbb31cb81f32a42:862ed3af464671e6ec9fef3af544f64917484d7cde33f9bd52841f0db8b79bce1128e862ff59f5fc5c9971b567199776ba3a15325de545ee04bcfb392f168a67',
   'bula-pesa', 'System Admin', 'admin')
ON CONFLICT (email) DO NOTHING;
