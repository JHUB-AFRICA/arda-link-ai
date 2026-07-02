<!--
  Production-readiness checklist. Every PR touching this monorepo must
  tick every applicable box. If you cannot tick a box, write a one-line
  note explaining why in the PR body and link to the tracking issue.
-->

## Target branch

- [ ] `dev` — feature / fix / refactor / chore / docs (the usual case)
- [ ] `staging` — final touches for the next release (less common; opens from `dev`)
- [ ] `master` — cutting a release (rare; opens from `staging` after CI green)

See [`../CONTRIBUTING.md`](../CONTRIBUTING.md) for the full branching model. PRs opened against the wrong branch will be closed and re-opened.

## What this PR changes

<!-- One-paragraph summary. Link issues with `Fixes #123`. -->

## Type of change

- [ ] Bug fix (non-breaking change that fixes an issue)
- [ ] New feature (non-breaking change that adds capability)
- [ ] Breaking change (fix or feature that would cause existing functionality to change)
- [ ] Documentation / refactor (no behaviour change)
- [ ] Dependency bump (lockfile + manifest)
- [ ] CI / infrastructure

## Service(s) touched

- [ ] `ardalink-engine/` (Python / FastAPI)
- [ ] `ardalink-api/` (Node / Express)
- [ ] `ardalink-web/dashboard/`
- [ ] `ardalink-web/talk/`
- [ ] `ardalink-web/packages/api-client-react/`
- [ ] `ardalink-marketing/`
- [ ] `Arda-link-AI-Docs/`
- [ ] Root (`README.md`, `RUNBOOK.md`, `LICENSE`, `.github/`, `CODEOWNERS`)

## Production-readiness checklist

### Build & test (must all pass)

- [ ] `pnpm install --frozen-lockfile` / `uv sync --frozen` succeeds locally (dep-pin intact)
- [ ] `pnpm run typecheck` (api, dashboard, talk, api-client-react) — no errors
- [ ] `uv run ruff check .` — clean
- [ ] `uv run pytest` — all tests pass, coverage ≥ 70% on `ardalink_engine/`
- [ ] `pnpm run test` (api, dashboard, talk, api-client-react) — all tests pass
- [ ] `pnpm run build` (api, dashboard, talk) — `dist/` artefact check passes

### Hygiene

- [ ] No `TODO` / `FIXME` / `XXX` / `HACK` / `STUB` markers in committed source (CI greps for these)
- [ ] No committed `node_modules/`, `dist/`, `.venv/`, `__pycache__/`, `.pytest_cache/`, or `.env`
- [ ] No new `|| true` or `|| echo` in any package.json script or CI step
- [ ] gitleaks passes (no new secrets)
- [ ] `pnpm audit --prod --audit-level=high` / `pip-audit` — no new high/critical findings

### Code health

- [ ] New code is covered by tests (unit + integration where applicable)
- [ ] No commented-out blocks of source code
- [ ] Public API changes are documented in the relevant service's `docs/`
- [ ] Error responses follow the project's degraded-mode contract (HTTP 503 + `{error, provider, feature, message, docs}`) where upstream providers are involved
- [ ] No silent graceful-degrade — every missing-credential path returns a loud, named 503

### User-facing (when touching `ardalink-marketing/`)

- [ ] No jargon in user-facing copy: no `NDVI`, `RLS`, `JWT`, `Azure gpt-4o`, `Express`, etc.
- [ ] Brand palette respected (`--bg #0B0B12`, `--surface #15151F`, `--primary #F59E0B`, `--accent #FF3C00`, `--ok #84CC16`)
- [ ] `prefers-reduced-motion` honoured if any animation was added/changed
- [ ] "View on GitHub ↗" link points to <https://github.com/JHUB-AFRICA/arda-link-ai>

### Documentation

- [ ] Root `README.md` is still accurate (service table, links)
- [ ] `RUNBOOK.md` updated if local-dev flow changes
- [ ] Per-service `README.md` updated if endpoints / env vars / degraded-mode contract change
- [ ] Per-service `docs/data-sources.md` updated if a new external provider is added/removed
- [ ] New public symbol / endpoint added? → mentioned in the relevant `docs/02-API.md`

### Legal / governance

- [ ] No third-party code added without an approved licence in the comment header
- [ ] No `Proprietary` markers re-introduced anywhere (project is MIT)
- [ ] No new branding that could be confused with another product

### Reviewers

<!-- CODEOWNERS auto-notifies based on path. Not a hard gate today — see
     /CONTRIBUTING.md for when this becomes a formal approval. Add
     relevant teammates here for cross-team awareness. -->

- Paths I touched (per `/CODEOWNERS`):
- [ ] (Optional) I asked for an explicit review from the owner because this is high-risk / cross-cutting

---

## How I tested

<!-- Concrete steps to reproduce. Mark N/A for docs-only PRs. -->

## Risk & rollback

<!-- One paragraph: what could break, and how to revert. Required for anything touching auth, multi-tenant boundaries, or external providers. -->

## Tracking

<!-- Link issue, ticket, or "no issue yet". -->

Fixes #