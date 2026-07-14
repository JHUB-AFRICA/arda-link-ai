# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.2.0] - 2026-07-14

### Added

- Baseline API: `GET /api/baseline` + per-ward lookup, serving the
  11-year ward-monthly Sentinel-2/NDVI/VCI baseline
- Satellite API: `GET /api/satellite/vci` (MODIS VCI) and per-ward
  snapshots
- Tenant attestation middleware: HMAC-SHA256 verify of `X-Tenant-ID`
  from the API → `set_tenant()` → Postgres RLS on `gis_engine.*`
- GEE pipeline: Sentinel-2 NDVI ingestion (per-cell, 250 m grid, 26,975
  cells across 5 active wards)
- Per-cell grid ingest (`pipeline/grid_ingest.py`) + WPDx obstacles
  cache
- Schedulers: night-only GEE ingest (`pipeline/scheduler.py`),
  configurable intervals
- `scripts/populate_baseline.py` + `scripts/resume_baseline_ingest.py`
  for partial reruns
- 5 new test files: `test_baseline.py` (94% cov), `test_satellite.py`,
  `test_tenancy.py`, `test_tenancy_middleware.py`, `test_wards.py`
- `Arda-link-AI-Docs/architecture.md` cross-referenced from
  `docs/10-ENGINE-API-FLOW.md`

### Fixed

- `httplib2 >= 0.32.0` pinned (transitive via `google-auth-httplib2`)
  — `PYSEC-2026-3444` clean
- `pyproject.toml` license corrected to MIT (was `Proprietary`)

## [0.1.0] - 2026-06-21

### Added
- Initial scaffold from CTO restructure (Phase 1, 2026-06-21)
- 8-doc CTO navigation under `docs/`
- Ruff + mypy + pytest CI gating
- Dependabot for pip and github-actions
- Multi-tenant data model scaffold (arrives Phase 2)

## [0.1.0] - 2026-06-21

### Added
- FastAPI skeleton (`ardalink_engine/main.py`)
- `/health` endpoint
- Pytest smoke test
- pyproject.toml with uv lock baseline
- `.env.example` covering all runtime variables

### Notes
- Live source migrates from `JHUB-AFRICA/arda-link-ai` in Phase 3.
- The 0.1.0 release is intentionally a thin skeleton so the migration is auditable.