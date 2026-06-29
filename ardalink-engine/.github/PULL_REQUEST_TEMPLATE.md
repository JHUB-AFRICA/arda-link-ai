<!--
  ardalink-engine — service-specific additions to the root template.
  GitHub picks ONE PR template per repo. This file is kept as
  documentation; the template that reviewers see on a PR is at
  /.github/PULL_REQUEST_TEMPLATE.md.
-->

> **Note:** This template is **not** auto-applied. The canonical PR
> template is at `/.github/PULL_REQUEST_TEMPLATE.md`. The items below
> are the *additional* checks reviewers should run for `ardalink-engine/`
> changes.

## engine-specific additions

### Biophysical correctness

- [ ] New / changed formula in `ardalink_engine/src/core_math/` is backed by a unit test with hand-computed expected values (no "approximately equal" without a tolerance justification)
- [ ] Any change to scoring weights (energy, nutrition, herd dynamics) is documented in `ardalink-engine/docs/` and reviewed by `@ardalink/engine-team`

### Earth Engine pipeline

- [ ] If you touched `ardalink_engine/src/pipeline/gee.py`, the change was reviewed by `@ardalink/data-team`
- [ ] The GEE pipeline still raises `GEEUnavailableError` (which is mapped to **HTTP 503** at the route layer) when credentials are missing
- [ ] The pipeline never silently swallows an Earth Engine error and returns a fabricated value

### Cosmos DB baseline

- [ ] If you touched `ardalink_engine/src/db/client.py` or `src/db/schema.py`, the change was reviewed by `@ardalink/data-team`
- [ ] Schema changes are additive (no `DROP COLUMN`, no type changes); downgrade is documented

### Azure OpenAI (chat-side enrichment)

- [ ] If you touched `ardalink_engine/src/ai/azure_client.py`, the change was reviewed by `@ardalink/security-team`
- [ ] No new prompt injection point or system-message change without explicit documentation
- [ ] No new outbound call without a timeout

### Degraded mode

- [ ] Every route that depends on a credentialed provider still returns **HTTP 503 + JSON `{error: "upstream_unavailable", provider, feature, message, docs}`** when that provider is missing — no silent graceful-degrade
- [ ] `GET /health` still returns 200 with a `degraded: true` flag (rather than failing the whole pod) when providers are missing

### Coverage

- [ ] `uv run pytest` passes with `--cov-fail-under=70` (enforced in CI)
- [ ] New module → at least one unit test covering the happy path and one edge case
- [ ] If you removed a test, you explained why in the PR body

### Dependencies

- [ ] `uv add` was run, not hand-edits to `pyproject.toml` — the `uv.lock` is the source of truth
- [ ] New dep is permissively licensed (MIT / BSD / Apache-2.0)