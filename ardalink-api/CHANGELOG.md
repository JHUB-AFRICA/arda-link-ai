# Changelog

All notable changes are documented here. Format: [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Added

- Typed wrappers around the Supabase server-side RPCs that had 0 code
  refs: `refreshSatelliteIndicesLatest`, `upsertSatelliteIndices`,
  `upsertSatelliteCellIndices`, `upsertWeatherData`, `rebuildWardCells`.
  Signatures pulled directly from the PostgREST OpenAPI; every `p_*`
  arg name matches the RPC parameter exactly. Paved path for future
  writers that need server-side upsert semantics (RLS + idempotency
  are enforced at the RPC boundary rather than the client).
- `forecastJob` now calls `refreshSatelliteIndicesLatest` at the end
  of each 6 h cycle so the `api_latest_satellite_indices` materialised
  view stays current. The endpoint is idempotent — safe to invoke on
  every cycle even when no new satellite rows landed.

## [0.2.0] - 2026-07-14

### Added

- Africa's Talking surface: outbound SMS + voice client with kill switch +
  rate limits (`src/lib/africastalking.ts`)
- 4 AT SMS callback routes: `/api/smsDelivery` (delivery reports),
  `/api/smsOptOut` (bulk opt-out), `/api/smsSubscription` (subscription
  notifications), inbound SMS
- VCI backfill job + manual trigger `/api/ops/vci-backfill` + per-ward
  baseline `/api/wards/:id/baseline`
- Supabase PostgREST client (`src/lib/supabase.ts`, 60 s cache) +
  ward-id mapping (`src/lib/wardMapping.ts`) + 5 demo routes
- Per-cell satellite indices in herder brief
  (`api_latest_satellite_indices` view)
- 14-day rainfall forecast job (`forecastJob.ts`, every 6 h)
- Leads + loop closure (Phase A): `pastoralist_leads` writes,
  `api_phone_identity` lookup, `HerderContext.tier`, USSD `Jisajili`
  self-enroll
- Deterministic voice pipeline (`voiceDeterministicPipeline.ts`,
  20 s `<Record>` → Azure Fast Transcription → GPT-5-mini extract)
- Azure LLM provider (`src/lib/llm/providers/azure.ts`) + failover
  registry (Azure → z.ai → MiniMax)
- Azure Speech STT/TTS wiring (region `southafricanorth`)
- WPDx water-points (`src/lib/wpdx.ts` + `wpdxIsiolo.ts`); nearest-5
  with OK/BAD/? badges in USSD Malisho + voice opener
- Demo channel simulators: `/api/demo/voice|ussd|sms` with personalisation
  from `pastoralists` + `ground_truth_reports`
- Ops routes: `/api/ops/leads`, `/api/ops/interactions`, `/api/ops/ward-cells`
- Tenant middleware (`src/middlewares/tenant.ts`) + HMAC-SHA256
  attestation to engine
- 20+ new test files covering AT surface, Supabase exports, voice
  pipeline, ward mapping, WPDx, satellite job, speech

### Fixed

- SMS sender ID dropped (the one AT rejected)
- `GET /api/intel/forecast` returns 200 with waiting-note when anomaly
  missing (was 500)
- `httplib2` pinned ≥ 0.32.0 in `ardalink-engine/pyproject.toml` (the
  CI vuln-scan caught a transitive 0.31.2 marked PYSEC-2026-3444)

## [0.1.0] - 2026-06-21

### Added

- Express 5 + TypeScript skeleton
- `/api/healthz` endpoint
- Vitest smoke test
- Canonical OpenAPI stub at `lib/api-spec/openapi.yaml`
- 8-doc CTO navigation under `docs/`
- ESLint + Prettier + tsc CI gating
- Dependabot, PR/issue templates, SECURITY.md

### Notes

- Live source migrates from `JHUB-AFRICA/arda-link-ai` in Phase 3.
- Voice bridges (`voiceStream.ts`, `voiceStreamBrowser.ts`), intelligence
  pipeline, and ground-truth schema land in v0.2.0.
