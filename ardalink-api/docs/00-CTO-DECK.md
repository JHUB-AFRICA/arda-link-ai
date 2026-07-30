# 00-CTO-DECK — Slide Outline

10 slides. Each ≤ 30 words on the slide; full content in linked docs.

---

## Slide 1 · Title

**ArdaLink — Q2 2026 Platform Review**
Three-repo split. Multi-tenant ready. Pilot-ready.
CTO · 2026-06-21

---

## Slide 2 · The problem (1 stat)

**Kenyan pastoralists lose ~KES 2B per drought cycle.**
Satellites see it weeks early. Nobody delivers the signal.

---

## Slide 3 · The product (1 diagram)

```
satellite ──► ArdaLink Engine ──► herder's phone call
                (FastAPI)            (Swahili/English)
                │
                └──► ArdaLink API ──► Azure OpenAI Realtime
                        │
                        └──► browser dashboard
```

---

## Slide 4 · Status today

| Component | Status |
|---|---|
| Engine | ✅ Operational, 5/5 tests |
| API | ✅ Operational, 17/17 tests |
| Web | ✅ Operational, 4/4 tests |
| Multi-tenant | ✅ Schema + RLS shipped |
| Local stack | ✅ `make up` |
| LLM layer | ✅ Azure AI Foundry (`gpt-5-mini`) primary + z.ai fallback via provider-agnostic registry |
| Speech (STT/TTS) | ✅ Azure Speech `southafricanorth`, `sw-KE-ZuriNeural` + `en-KE-AsiliaNeural`, endpoints live |
| Voice pipeline (herder) | ✅ **Deterministic mode default** — AT `<Record>` → Azure Speech → GPT-5 Mini extract → `ground_truth_calls` (Supabase). Verified 2026-07-07. |
| Voice pipeline (upgrade path) | 🔜 Realtime (`gpt-4o-realtime-preview`) kept wired for browser demos and Phase-3 herder upgrade once bandwidth + pricing align |
| Reference data | ✅ Supabase (PostGIS + ward / `satellite_indices` / `weather_data`) — populated + integrated 2026-07-08; local Postgres retained as backup mirror |
| Voice demos | ✅ `/api/demo/voice/deterministic` (production pipeline in browser) + `/api/demo/voice/simulator` (realtime WS) |
| WhatsApp channel | ✅ Shipped, live-tested (Evolution API) — ⚠️ 360dialog/Meta Cloud API path blocked on pending Meta Business verification |
| Pilot | 🎯 Q3 2026 — 500 households, 5 active wards |

---

## Slide 5 · Architecture (1 diagram)

```
Browser / Phone / WhatsApp
     │
     ▼
ardalink-api ──► ardalink-engine ──► Postgres
   (JWT)            (HMAC)              (RLS)
     │
     ▼
Azure OpenAI · Supabase · Africa's Talking · GEE · 360dialog/Evolution
```

Three layers of tenant enforcement: JWT → HMAC → RLS.

---

## Slide 6 · Security posture

- JWT (HS256) on every API call
- HMAC-SHA256 tenant attestation between services
- Postgres RLS on every operational table
- Distroless containers, non-root, healthchecks
- Gitleaks + Trivy + Dependabot enabled
- `minimumReleaseAge: 1440` for npm supply-chain

---

## Slide 7 · Cost trajectory

| Stage | Households | Monthly | Per herder |
|---|---|---|---|
| Pilot | 500 | $131 | $0.26 |
| County | 5,000 | $1,212 | $0.24 |
| Regional | 50,000 | $6,000 | $0.12 |

**With startup credits, first 12–18 months: $0.**

---

## Slide 8 · Risks

1. GEE quota change → mitigated (cache)
2. Test coverage thin → Phase 6 backlog
3. Realtime cost spike → budget rail + flags
4. Single cloud → cloud-agnostic Compose first, IaC deferred
5. Meta Business API verification pending → Evolution API keeps WhatsApp live-tested meanwhile; config-only flip once approved

---

## Slide 9 · Roadmap (90 days)

- **W1** PRs merged, v0.2.0 cut
- **W2** Test coverage ≥ 60%
- **W3** 7-day staging soak
- **W4** Pilot kickoff
- **W6** 500 households, 3 wards
- **W8** CI flipped to gating
- **W10** Terraform IaC
- **W12** Q3 review + Series A prep

---

## Slide 10 · Asks

1. **Approve** the three migration PRs this week
2. **Pick** the cloud target (recommend GCP)
3. **Approve** the pilot tenant list — the 5 active Isiolo wards (Wabera, Bulla Pesa, Ngare Mara, Burat, Oldonyiro); Garbatulla/Merti/Kinna were retired 2026-07
4. **Fund** the $50K pilot completion (per EXECUTIVE_INDEX)

---

**Source**: `docs/00-EXECUTIVE-INDEX.md`
**Detail**: `docs/01-ARCHITECTURE.md`, `docs/04-SECURITY.md`, `docs/06-COSTS.md`