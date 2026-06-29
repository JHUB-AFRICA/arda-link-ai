# 00 — Executive Index

**Owner**: CTO · **Audience**: Executive, Board, Engineering Leads · **Read**: 5 min · **Next review**: Q3 2026

---

## Where we are

ArdaLink Web hosts the two user-facing surfaces of the platform.

| Component                            | Status        | Notes                                     |
| ------------------------------------ | ------------- | ----------------------------------------- |
| Operator Dashboard (React 19 + Vite) | ✅ Skeleton   | Migrates Phase 3                          |
| Public Talk (React 19 + Vite)        | ✅ Skeleton   | Migrates Phase 3                          |
| Shared API hooks                     | 🔜 Phase 3    | Orval-generated from ardalink-api OpenAPI |
| Multi-tenant UI guards               | 🔜 Phase 2    | Hide/show per tenant claims               |
| CI gating                            | ✅ Configured | ESLint + tsc + vitest enforced            |
| Container image (static)             | 🔜 Phase 5    | Served via Caddy                          |

## What we ship

Two browser apps that turn satellite intelligence and pastoralist voice into a
map operators can read and a conversation anyone can have.

## Top risks

1. **Live migration is large** — `WardMapLive` (15 KB), `CallModal` (11 KB),
   `dashboard.tsx` (67 KB). _Owner_: Phase 3, audited PR-by-PR.
2. **Realtime key leakage** — browser holds ephemeral Realtime key. _Owner_:
   Phase 8 (security baseline).
3. **No design system contract yet** — Phase 7 will pin the component library.

## Top decisions needed

1. Map provider (current: OSM tiles; paid option for SLA?).
2. Static asset CDN strategy.
3. Public Talk rate-limit UX (free-tier boundary).

## What's next

| When    | Milestone                    | KPI                              |
| ------- | ---------------------------- | -------------------------------- |
| Week 1  | Phase 3 code migration       | v0.2.0 released                  |
| Week 2  | Generated hooks wired        | All queries typed end-to-end     |
| Week 4  | E2E smoke (Playwright) green | No regression                    |
| Q3 2026 | Multi-ward pilot UI          | Operators see tenant-scoped data |
