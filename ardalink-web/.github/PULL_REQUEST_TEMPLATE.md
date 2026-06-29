<!--
  ardalink-web — service-specific additions to the root template.
  GitHub picks ONE PR template per repo. This file is kept as
  documentation; the template that reviewers see on a PR is at
  /.github/PULL_REQUEST_TEMPLATE.md.
-->

> **Note:** This template is **not** auto-applied. The canonical PR
> template is at `/.github/PULL_REQUEST_TEMPLATE.md`. The items below
> are the *additional* checks reviewers should run for `ardalink-web/`
> changes.

## web-specific additions

### Dashboard (`ardalink-web/dashboard/`)

- [ ] If you touched auth (`AuthGate.tsx`, `LoginPage.tsx`), the change was reviewed by `@ardalink/security-team`
- [ ] No new localStorage key was added without updating `@workspace/api-client-react` (so dashboard + talk stay in sync)
- [ ] Visual change → screenshots attached (light + dark, mobile + desktop)

### Talk (`ardalink-web/talk/`)

- [ ] If you touched `src/lib/{phone,consent,voiceState}.ts`, the change was reviewed by `@ardalink/security-team`
- [ ] Phone-number handling still routes through `normalizePhone()` + `isValidPhone()` — no inline string surgery
- [ ] Consent state machine still records an ISO timestamp (not a boolean) so future re-confirmation prompts can use the date
- [ ] Voice state transitions still match the documented `idle → connecting → live → stopped/error` diagram (covered by `tests/voiceStateMachine.test.ts`)

### Shared hooks package (`ardalink-web/packages/api-client-react/`)

- [ ] Bumped `version` in `package.json` if the change is observable from consumers
- [ ] New hook → exported from `src/index.ts` AND listed in `README.md`'s hook table
- [ ] Behaviour change to `apiFetch` → updated at least one test in `tests/apiFetch.test.ts` / `tests/errors.test.ts`
- [ ] `pnpm run typecheck` and `pnpm run test` both pass

### Brand palette (when touching dashboard or talk)

- [ ] All new colour usage references a CSS variable from `src/index.css` (no hard-coded hex outside that file)
- [ ] New icons / illustrations come from the existing set OR a brand-licensed source

### Build artefacts

- [ ] `pnpm run build` produces a working `dist/` (CI asserts `dist/index.html` exists)
- [ ] No `dist/`, `node_modules/`, or `.env` committed

### Tests

- [ ] New behaviour → new test in the corresponding package's `tests/`
- [ ] `pnpm run test` passes (covers dashboard, talk, api-client-react)
- [ ] Vitest config (`vitest.config.ts`) unchanged unless you are intentionally adding test infra