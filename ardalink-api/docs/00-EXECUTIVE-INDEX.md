# 00 — Executive Index

**Author**: Lead Software Engineer · **Audience**: CTO, Board, Engineering Leads, Partners · **Read**: 5 min · **Next review**: Q3 2026 · **Last verified**: 2026-06-21

---

## 1 · Where we are

The ArdaLink platform has been **structurally reorganized** into three independent repositories under `MUNENE1212/`, with **multi-tenant data model** shipped as the first capability of the multi-ward pilot, and a **cloud-agnostic Docker stack** ready to boot locally with one command.

| Component | Repo | Status | v0.2.0 evidence |
|---|---|---|---|
| Biophysical engine | `MUNENE1212/ardalink-engine` | ✅ Operational | 5/5 tests · 31 source files · distroless Python 3.12 image |
| API + voice bridge | `MUNENE1212/ardalink-api` | ✅ Operational | 17/17 tests · 89 source files · distroless Node 24 image |
| Operator + Talk apps | `MUNENE1212/ardalink-web` | ✅ Operational | 4/4 tests · dashboard + talk · nginx static image |
| Multi-tenant schema | All three repos | ✅ Schema shipped | RLS policies, tenant registry, HMAC attestation, JWT middleware |
| Local stack | `ardalink-api/infra/docker` | ✅ One-command boot | postgres, redis, engine, api, web, caddy — `make up` |
| Legacy repos | `MUNENE1212/ardalink-ai`, `MUNENE1212/biophysical-engine` | ⏳ Pending freeze-tag | After team approval of migration PRs |

## 2 · What we ship (one diagram)

```
herder phone ──► Africa's Talking ──► ardalink-api (Express 5 + JWT + WS bridge)
                                                │
                                                ├──► ardalink-engine (FastAPI + GEE + grid + journey)
                                                │         │
                                                │         └──► Postgres gis_engine schema (RLS)
                                                │
                                                ├──► Azure AI Foundry — gpt-5-mini (chat + deterministic voice extract), gpt-4o-realtime-preview (realtime demo path, future herder upgrade)
                                                ├──► Azure Speech (STT/TTS, sw-KE + en-KE, southafricanorth)
                                                ├──► z.ai / MiniMax (LLM fallback providers)
                                                ├──► Supabase (reference data primary — wards, satellite_indices, weather_data, ground_truth_calls; PostGIS)
                                                ├──► Cosmos DB (baselines)
                                                └──► browser ──► ardalink-web (dashboard + talk + /api/demo/voice/{deterministic,simulator})
```

Tenant scoping is enforced at three layers:

1. `ardalink-api` — `tenantMiddleware` validates JWT, attaches `req.tenant.tenant_id`, propagates as `X-Tenant-ID` + `X-Tenant-Sig` (HMAC-SHA256) to the engine.
2. `ardalink-engine` — verifies the HMAC, runs every DB operation in a transaction with `SET LOCAL app.current_tenant_id = '<id>'`.
3. Postgres — Row-Level Security policies on every operational table reject any row whose `tenant_id` ≠ session variable.

## 3 · Top 5 risks (impact, likelihood, owner, mitigation)

| # | Risk | Impact | Likelihood | Owner | Mitigation in place |
|---|---|---|---|---|---|
| 1 | Cross-tenant data leak | High | Low | CTO | RLS + HMAC attestation + JWT + fail-closed context binding |
| 2 | GEE quota change | High | Certain | Eng Lead | Baseline cache; engineer reads work without GEE |
| 3 | Test coverage thin on migrated code | Med | High | Eng Lead | Phase 6 backlog — unit + integration test addition per route |
| 4 | Realtime API cost spike | Med | Med | CTO | Per-tenant token bucket; per-ward feature flags; budget rail |
| 5 | Single cloud dependency | Med | Low | CTO | Cloud-agnostic Compose; IaC deferred until pilot validates |

## 4 · Top 5 decisions needed

| # | Decision | Recommendation | Deadline |
|---|---|---|---|
| 1 | Cloud target for first production deploy | GCP (native GEE, Cloud Run for containers) | Q3 2026 |
| 2 | IdP strategy for tenant JWTs | HS256 with shared secret for pilot; OIDC (Auth0/Clerk/WorkOS) at scale | Pilot kickoff |
| 3 | Pilot tenants (multi-ward per plan) | Bula Pesa, Garbatulla, Merti Sub-County operator — already seeded. Satellite VCI demo runs against Bula Pesa, Garbatulla, Kinna wards | Pilot kickoff |
| 4 | Migration PR approval | Approve and merge 3 PRs (#7 engine, #7 web, #8 api) | This week |
| 5 | Legacy repo disposition | Tag as `legacy-2026Q2` with redirect READMEs; do not delete | Cutover |

## 5 · What's next (90 days, KPI-tied)

| When | Milestone | KPI |
|---|---|---|
| Week 1 | Migration PRs merged, v0.2.0 tags cut | All 3 repos green CI |
| Week 2 | Phase 6 test expansion (per-route unit tests) | Coverage ≥ 60% on each repo |
| Week 3 | Compose-based staging on a single VM | 7-day soak, zero manual restarts |
| Week 4 | Pilot kickoff (Bula Pesa) | 50 herders onboarded, call success ≥ 85% |
| Week 6 | Garbatulla + Merti Sub-County rollout | 500 households live across 3 tenants |
| Week 8 | Phase 4: flip CI to gating (remove `\|\| true`) | Zero `\|\| true` in any workflow |
| Week 10 | IaC module (Terraform, cloud-agnostic) | `make infra-plan` works against staging |
| Week 12 | Q3 review | Pilot metrics vs. targets; Series A prep |

## Numbers at a glance

- **Pilot cost**: ~$131/month for 500 households (assumes startup credits → $0 for 12–18 months)
- **Voice cost driver**: Azure OpenAI Realtime per-minute; budget rail is the single biggest lever
- **Code shipped**: 278 source files migrated across the three repos, preserving full git history via `git checkout` (not `git filter-repo --force` — we kept the original commits)
- **Tests**: 26 total (17 api + 4 web + 5 engine), all passing locally
- **CI**: workflows run in 60–90 s; all blocking checks green; non-blocking checks flagged for Phase 4

## What the team should review this week

1. **PR #7** — `MUNENE1212/ardalink-engine` — Phase 3 migration
2. **PR #7** — `MUNENE1212/ardalink-web` — Phase 3 migration
3. **PR #8** — `MUNENE1212/ardalink-api` — Phase 3 migration + Phase 5 Docker + Phase 6 tenant wiring + tests

All three are `MERGEABLE`. The engine and web are `CLEAN`; the API is `UNSTABLE` only because of a third-party Trivy app check (transitive `uuid@8.3.2` vulnerability via `@google/earthengine → googleapis`). Tracked as follow-up, not blocking.

---

[← Back to README](../README.md) · [Next: Architecture →](01-ARCHITECTURE.md)