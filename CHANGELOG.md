# Changelog

All notable changes to the ArdaLink monorepo are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/).
Service-level changes are in `ardalink-{api,engine,web}/CHANGELOG.md`.

## [0.1.0-pilot] - 2026-07-14

First tagged pilot release. `master` and `staging` pinned at SHA
`4a9ec62` (tag `v0.1.0-pilot-2026-07-14`). 132 commits since the
2026-06-29 seed.

### Added

- **Comms vault** — `Arda-link-AI-Docs/comms/` (project profile,
  content playbook, pitch library, README) prepared for the
  post-presentation audit and external outreach.
- **Business Model Canvas** — `Arda-link-AI-Docs/business-model-canvas.md`
  aligned to the post-presentation audit.
- **Progress deck** — `Arda-link-AI-Docs/progress-2026-07-13-technical.md`
  + `system-diagrams.md` (three Mermaid diagrams).
- **Africa's Talking callbacks** — SMS delivery reports, bulk opt-out,
  subscription notifications; `/api/smsDelivery`, `/api/smsOptOut`,
  `/api/smsSubscription` routes.
- **VCI backfill** — `ardalink-api/src/jobs/vciBackfillJob.ts` + manual
  trigger `/api/ops/vci-backfill` + `/api/wards/:id/baseline` for ops
  debug.
- **Supabase source-of-truth** — `ardsalink-api/src/lib/supabase.ts`
  PostgREST client (60 s cache), ward-id mapping
  (`ardalink-api/src/lib/wardMapping.ts`). 1,093 satellite history
  rows + 2.36 M per-cell NDVI rows for 5 active wards; PostGIS 3.4.
- **Per-cell satellite indices** in herder brief — `api_latest_satellite_indices`
  view + `ward_cells` table (26,975 cells).
- **Leads + loop closure (Phase A)** — `pastoralist_leads` writes,
  `api_phone_identity` lookup, `HerderContext.tier`,
  USSD `Jisajili` self-enroll, voice-call SMS summary, ONGEA/USSD
  outbound dispatch.
- **14-day rainfall forecast** persisted to `weather_forecast`
  (`forecastJob`, every 6 h).
- **Dashboard redesign** — choropleth split into orchestrator + 4 map
  layers + 4 analysis panels (Hud, Legend, Comparison, SeverityBars,
  Insights, TimeTravelSparkline). NDVI history + 14-day forecast
  time-series panel.
- **Ops dashboard panels** — leads panel, callback log, VCI backfill
  trigger, ward map (PostGIS choropleth), time-series panel.
- **Deterministic voice pipeline** — `voiceDeterministicPipeline.ts`
  (value-first opener → DTMF menu → 20 s `<Record>` → Azure Fast
  Transcription with auto-fallback → GPT-5-mini extract →
  `ground_truth_reports` row). Mode chosen by `CALL_PIPELINE_MODE`.
- **Azure LLM provider** — `ardalink-api/src/lib/llm/providers/azure.ts`
  with failover registry (Azure primary, z.ai fallback, MiniMax
  secondary). Verified: `/api/intelligence/brief` returns real Swahili
  brief from `provider: azure, model: gpt-5-mini`.
- **Azure Speech** (STT/TTS) wired end-to-end, region `southafricanorth`
  — neural voices `sw-KE-ZuriNeural`, `en-KE-AsiliaNeural`.
- **At-callbacks** delivery: inbound + delivery reports + opt-out +
  subscription notifications.
- **WPDx water-points** — `ardalink-api/src/lib/wpdx.ts` + `wpdxIsiolo.ts`
  seed; nearest-5 with OK/BAD/? badges in USSD Malisho + voice opener.

### Changed

- **Monorepo CI** — production-grade hardening (`.github/workflows/monorepo-ci.yml`):
  paths-filter, hygiene gate, brand-palette enforcement, jargon guard
  (NDVI/RLS/JWT/gpt-4o/Express in user-facing copy), secrets scan,
  pip-audit, summary aggregator.
- **Documentation set** — `CONVENTIONS.md`, `CONTRIBUTING.md`,
  `RUNBOOK.md`, `LOCAL_SETUP.md`, `STATUS.md` rewritten.
- **Conventions per service** — `ardalink-{api,engine,web}/docs/CONVENTIONS.md`.
- **Choropleth refactor** — extracted orchestrator (`index.tsx`) +
  data hooks + 4 map layers + 4 analysis panels; deleted god-file
  `dashboard/src/components/Choropleth.tsx`.
- **Tenancy** — HMAC-SHA256 attestation wired api↔engine
  (`TENANT_ATTESTATION_SECRET`); engine `TenantAttestationMiddleware`
  enforces Postgres RLS on `gis_engine.*`.

### Fixed

- **CI** — 3 successive flakiness clusters resolved
  (`5d49847 fix(ci): resolve remaining CI issues`,
  `9633a55 fix(ci): resolve CI failures across all jobs`,
  `99a65e8 test(openData): raise live-network probe timeout to 15 s`).
- **httplib2 0.31.2** (PYSEC-2026-3444, transitive via
  google-auth-httplib2) — pinned `httplib2>=0.32.0` as direct dep
  in `ardalink-engine/pyproject.toml`; `pip-audit` clean.
- **pyproject.toml license** — corrected `Proprietary` → `MIT` (was
  missed by CI hygiene regex which only matches `Proprietary[ -]License`).
- **SMS sender ID** — dropped the AT-rejected sender.
- **Forecast 500** — `GET /api/intel/forecast` returns 200 with
  waiting-note when anomaly missing.

### Security

- 8/8 CI jobs green on `Monorepo CI` for SHA `4a9ec62`.
- `pip-audit` clean (no known vulnerabilities in pinned deps).
- `gitleaks` runs in CI (`continue-on-error` for now; tighten in v0.2).
- TODO before v0.2: drop `continue-on-error` on gitleaks step;
  enable Dependabot + GitHub vulnerability alerts; pin CODEOWNERS to
  real GitHub teams.

[Unreleased]: https://github.com/JHUB-AFRICA/arda-link-ai/compare/v0.1.0-pilot-2026-07-14...HEAD
[0.1.0-pilot]: https://github.com/JHUB-AFRICA/arda-link-ai/releases/tag/v0.1.0-pilot-2026-07-14
