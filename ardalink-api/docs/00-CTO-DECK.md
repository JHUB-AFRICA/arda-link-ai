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
| Pilot | 🎯 Q3 2026 — 500 households, 3 wards |

---

## Slide 5 · Architecture (1 diagram)

```
Browser / Phone
     │
     ▼
ardalink-api ──► ardalink-engine ──► Postgres
   (JWT)            (HMAC)              (RLS)
     │
     ▼
Azure OpenAI · Cosmos DB · Africa's Talking · GEE
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
3. **Approve** the pilot ward list (Bula Pesa, Garbatulla, Merti)
4. **Fund** the $50K pilot completion (per EXECUTIVE_INDEX)

---

**Source**: `docs/00-EXECUTIVE-INDEX.md`
**Detail**: `docs/01-ARCHITECTURE.md`, `docs/04-SECURITY.md`, `docs/06-COSTS.md`