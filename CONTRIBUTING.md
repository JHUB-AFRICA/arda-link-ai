# Contributing to ArdaLink

Thanks for your interest. This document is the **canonical git workflow**
for the monorepo. Each service has its own [`CONTRIBUTING.md`](./ardalink-api/CONTRIBUTING.md)
focused on service-specific dev setup — read both.

---

## Branching model

Three long-lived branches, with a strict promotion order:

```
       ┌──────────────┐
       │   master     │  ← sacred. Release-grade. Direct pushes blocked.
       └─────▲────────┘
             │ promotion PR (manual + e2e gate)
             │
       ┌─────┴────────┐
       │  staging     │  ← integration. Final touches / QA / staging deploys.
       └─────▲────────┘
             │ promotion PR (manual + CI green)
             │
       ┌─────┴────────┐
       │    dev       │  ← active development. Always deployable.
       └─────▲────────┘
             │ feature PR (1+ reviewer)
             │
   ┌─────────┴──────────┐
   │  feature/*,        │  ← short-lived (≤ 1 week).
   │  fix/*,            │
   │  chore/*, refactor/*, docs/*   │
   └────────────────────┘
```

### What lives where

| Branch | What it contains | Who pushes | Gate |
|---|---|---|---|
| `master` | Released code. Tag every commit that ships. | No direct pushes | CI green + e2e green |
| `staging` | What we're queueing for the next release. Final touches, doc polish, last-minute config. | No direct pushes | CI green |
| `dev` | Active development. Every feature lands here first. | No direct pushes | CI green |
| `feature/*` | One focused change. ≤ ~400 LOC + accompanying tests. Branched from `dev`. | Author | CI green |
| `fix/*` | Same as `feature/*` but for bug fixes. Branched from `dev`. | Author | CI green |
| `chore/*` | Tooling, deps, hygiene. Branched from `dev`. | Author | CI green |
| `refactor/*` | Restructuring without behaviour change. Branched from `dev`. | Author | CI green |
| `docs/*` | Documentation only. Branched from `dev`. | Author | Optional review |

> **Re-introduce approval requirements when the team grows.** Today the team is small enough that the cost of round-tripping approval exceeds its value. Document this in the PR review checklist and re-enable in the GitHub branch-protection rules when the team passes ~5 active contributors.

### Promotion flow (the actual day-to-day)

1. **Active work** → branch off `dev` (see naming below), implement, test, push, open PR to `dev`.
2. **Integration** → when a release is being prepared, open a PR from `dev` to `staging`. This is where final touches happen: copy polish, README sync, env-var audit, last-minute version bumps.
3. **Release** → when `staging` is green and demos well, open a PR from `staging` to `master`. CI must be green. Tag the merge commit (`vX.Y.Z`).
4. **Back-merge** → after every `staging` → `master` promotion, open a `master` → `dev` sync PR so `dev` never falls behind.

Back-merges are the part everyone forgets. Don't forget them.

---

## Branch naming

### Type prefix

| Prefix | Use for |
|---|---|
| `feature/...` | New capability |
| `fix/...` | Bug fix |
| `chore/...` | Tooling / deps / config |
| `refactor/...` | Restructuring (no behaviour change) |
| `docs/...` | Documentation only |
| `ci/...` | CI / workflow files only |

### Name format

```
<type>/<scope>-<short-kebab-summary>
```

Examples:
- `feature/api-ward-detail-endpoint`
- `fix/choropleth-hover-stuck-on-metric-switch`
- `chore/bump-vite-to-7.4`
- `refactor/choropleth-component-split`
- `docs/conventions-and-module-standards`
- `ci/monorepo-ci-production-grade`

The summary should fit on one line in `git branch` output. Lowercase, dash-separated, no ticket number.

---

## Commit messages

We follow [Conventional Commits](https://www.conventionalcommits.org/).

```
<type>(<scope>): <imperative summary>

<body — wrap at 72 chars>

<footer — references, breaking-change notes>
```

- `type` must be one of: `feat`, `fix`, `chore`, `refactor`, `docs`, `ci`, `test`, `perf`, `revert`.
- `scope` is the affected area (e.g. `api`, `web/dashboard`, `ci`, `engine`).
- Summary: imperative ("add", not "added"), no trailing period, ≤ 72 chars.
- Body: WHY, not WHAT. The diff already says what.
- Breaking changes: append `BREAKING CHANGE: <description>` to the footer.

Examples:
```
feat(api): GET /api/open-data/geo/ward-detail endpoint

Mirrors the existing isiolo-wards loader pattern: try multiple
paths for docs/local-dev/data/ward-detail.json, cache in-memory,
log on load. Public — no auth — added to PUBLIC_PATHS in tenant.ts.

No typecheck regressions in the openData route itself.
```

```
fix(choropleth): clear selected ward on metric change
```

If a PR has more than one logical commit, write each commit as if it were a standalone — rebase / squash before opening the PR so history tells a clean story.

---

## Pull requests

### Target branch — pick the right one

| Your change | Opens against |
|---|---|
| New feature, fix, refactor, chore, docs | `dev` |
| Final touches for an upcoming release | `staging` |
| Cutting a release | `master` |

The PR template (`.github/PULL_REQUEST_TEMPLATE.md`) reminds you to confirm the target. Update it in the PR body if you got it wrong.

### Required checks before merge

- All CI jobs green (lint, typecheck, test, build, gitleaks, hygiene)
- Branch is up-to-date with the target
- Commit history is clean (squash / rebase before review, not after)
- Diff is reviewable: if it's > ~600 LOC, split it
- `/CODEOWNERS` paths touched? → mention the relevant owner in the PR description so they're notified (informational — no formal approval gate today)

### Reviewing a PR

- Reply with line-anchored comments where possible (`src/file.ts:42`)
- Be explicit: ✅ ship / ❌ change-request / 💬 discussion
- Reviewers are empowered to request a split or docs addition without "earning" the comment
- "This module is too big" or "Please add a function doc" is a complete review comment
- **When the team grows past ~5 active contributors**, the PR template's "Reviewers" section becomes the formal approval gate — see "Required checks before merge" above.

---

## Local setup checklist

Before opening your first PR:

```bash
git clone git@github.com:JHUB-AFRICA/arda-link-ai.git
cd arda-link-ai

# Service-specific installs (pnpm or uv — see per-service docs):
cd ardalink-api && pnpm install
cd ../ardalink-engine && uv sync --all-extras --frozen

# Pre-commit hooks
corepack enable
pnpm exec husky install        # if configured; otherwise use pre-commit

# Smoke test the local stack
make -C ardalink-api/docs/local-dev up
curl http://localhost:3000/api/healthz
```

If the smoke test fails, the rest of your day will be debugging — fix that first.

---

## Things we don't do

- **Force pushes to `dev`, `staging`, `master`.** Always.
- **Squash merges that hide commit history.** Use squash only for single-commit feature branches. Multi-commit branches keep their commits intact.
- **Direct pushes to protected branches.** Always open a PR.
- **Force-merge broken CI.** Fix the breakage; don't paper over it.
- **Long-lived feature branches.** If your branch lives more than a week, split it or merge what's ready.
- **"WIP" PRs that hang forever.** Open a draft PR if you want early visibility, but mark it ready for review before the end of the week.
- **Bumping deps without a lockfile change.** Always commit the updated lockfile.

---

## Where to get help

- `RUNBOOK.md` — operator-facing local-dev setup and incident response
- `CONVENTIONS.md` — code organisation and documentation standard
- Per-service `docs/00-EXECUTIVE-INDEX.md` — service architecture
- Slack `#ardalink-dev` — for the humans in the loop
- GitHub Discussions — for things that don't need a PR