<!--
  ardalink-api — service-specific additions to the root template.
  GitHub picks ONE PR template per repo. This file is kept as
  documentation; the template that reviewers see on a PR is at
  /.github/PULL_REQUEST_TEMPLATE.md.
-->

> **Note:** This template is **not** auto-applied. The canonical PR
> template is at `/.github/PULL_REQUEST_TEMPLATE.md`. The items below
> are the *additional* checks reviewers should run for `ardalink-api/`
> changes.

## api-specific additions

### Auth / tenancy

- [ ] If you touched `src/middlewares/tenant.ts` or `src/lib/tenancy.ts`, the change was reviewed by `@ardalink/security-team` (per `/CODEOWNERS`)
- [ ] No new code path reaches the database without going through `withTenantContext()` or equivalent RLS-bound session
- [ ] No new code path accepts a tenant ID from request input without re-validating the JWT claim

### Voice / telephony

- [ ] If you touched `src/routes/{voice,voiceEvents,publicTalk,callTokens}.ts`, the change was reviewed by `@ardalink/api-team`
- [ ] Africa's Talking call-control endpoints still return the documented status codes (`200`, `503` with `{provider: "africas_talking", feature: ...}` when credentials are missing)
- [ ] Browser-voice WebSocket still emits the documented message types (`audio`, `audio_done`, `interrupt`, `transcript`, `end_call`, `error`, `playback_ended`)

### LLM / intelligence

- [ ] If you touched `src/lib/llm/`, the change was reviewed by `@ardalink/security-team`
- [ ] New provider added? → registered in `src/lib/llm/registry.ts` AND covered by a unit test that exercises the registry fallback chain
- [ ] `/api/intelligence/brief` still falls back to `MockClient` when no provider is configured (returns a deterministic placeholder, not a 503 — this is intentional)

### Open data

- [ ] If you added a new free / key-less provider, it is documented in `docs/data-sources.md` with: endpoint, attribution, license, "what it gives", "used by"
- [ ] No new paid / credentialed provider added without a `503 + {provider, feature}` contract on the affected route(s)

### Tests

- [ ] New endpoint → at least one supertest-based integration test
- [ ] Changed endpoint → existing test updated, not deleted
- [ ] `pnpm run test` passes (134 tests minimum; new ones added by this PR)

### Scripts

- [ ] No `|| true` added to any script in `package.json`
- [ ] No new dep added without updating `pnpm-lock.yaml` (`pnpm install` was run)

### Migration safety (when touching `docs/local-dev/migrations/`)

- [ ] New migration is forward-compatible (uses `IF NOT EXISTS`)
- [ ] New migration has been tested against a fresh DB AND an existing-DB upgrade path
- [ ] Schema is still RLS-safe (`ENABLE + FORCE ROW LEVEL SECURITY` on every new operational table)