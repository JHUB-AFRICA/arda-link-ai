-- =============================================================================
-- OPTIONAL demo data — fake pastoralists + fake ground-truth reports.
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
-- Idempotent — replay-safe. `ON CONFLICT DO UPDATE` on pastoralists;
-- ground_truth_reports guards with a `NOT EXISTS` clause per tenant so
-- a second pass adds nothing.
--
-- Content: 5 pastoralists + 12 ground-truth reports for each of three
-- primary demo tenants (bula-pesa, ngare-mara, burat). Wabera and
-- Oldonyiro operators log in against the bootstrap accounts but see
-- an empty dashboard — real herder data lands via USSD/SMS/voice.
-- =============================================================================

BEGIN;

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
-- 2. Ground-truth reports — 12 per primary demo tenant, spread across the
--    last 30 days. Different stress profiles make the dashboard render as
--    if the pilot has been running for a month.
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

COMMIT;

-- ---------------------------------------------------------------------------
-- Verification counts (read-only)
-- ---------------------------------------------------------------------------
SELECT 'pastoralists'       AS scope, COUNT(*) AS rows FROM public.pastoralists
UNION ALL
SELECT 'reports/bula-pesa',  COUNT(*) FROM public.ground_truth_reports WHERE tenant_id = 'bula-pesa'
UNION ALL
SELECT 'reports/ngare-mara', COUNT(*) FROM public.ground_truth_reports WHERE tenant_id = 'ngare-mara'
UNION ALL
SELECT 'reports/burat',      COUNT(*) FROM public.ground_truth_reports WHERE tenant_id = 'burat';
