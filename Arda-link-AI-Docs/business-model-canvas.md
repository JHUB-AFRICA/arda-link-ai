# ArdaLink — Business Model Canvas alignment

**Status:** Pre-launch pilot. This document maps ArdaLink's strategy
to the **9 pillars of the Business Model Canvas** and shows, for
each pillar, the concrete engineering evidence that pillar is
architected — not just aspirational.

Every claim is backed by a code path, a Supabase table, or a live
data count so the audit reviewer can independently verify each
pillar. Where a pillar is planned-but-not-yet-shipped it says so
plainly.

---

## 1. Value Propositions — what core value are we delivering?

### For the pastoralist (primary user)

| Value | Evidence in the system |
|---|---|
| **Real-time drought intelligence in their own language** — no jargon, no smartphone required, works on any 2G phone | `src/lib/herderContext.ts::buildLocalizedBrief` picks language from `pastoralists.preferred_language`; `src/lib/voiceCopy.ts` holds the natural-Kiswahili templates |
| **Nearest working water point** — freshened by herder peer reports, not stale WPDx surveys | `src/lib/wpdx.ts::nearestWorkingKnownPoints` overlays `ground_truth_calls` on the 2012 WPDx snapshot |
| **Migration hint** — "your neighbour Wabera has better pasture, consider that direction" | `src/lib/supabase.ts::bestNeighborForAdvice` compares neighbouring wards' NDVI and only surfaces when meaningfully better |
| **Peer signal** — "6 herders like you also reported thin animals this week" | `src/lib/supabase.ts::peerSignalForWard` aggregates ground_truth_calls + lead_interactions over a 7-day window |
| **Zero cost at point of use** — user pays only their normal SMS/USSD rate; we pay the outbound | Every outbound goes through `sendSmsViaAt` with a rate-limit cap so we cannot accidentally spam the pastoralist's own balance |
| **Two-way** — herder can update reality (broken water is fixed, animals recovering) and the next herder to text `BULA` sees it | The ground-truth overlay is the flywheel — described in `feedback_no_open_loops.md` |

### For county government + NGOs (secondary customers, revenue-bearing)

| Value | Evidence |
|---|---|
| **Ground-truth data feed** — herder reports labelled by ward, time, indicator (BCS, mortality, water) | `ground_truth_calls` schema; `/api/ground-truth/merged` endpoint |
| **Real-time drought map** — 5-ward choropleth with NDVI + 14-day rainfall forecast | Dashboard `WardMap.tsx` + `TimeSeriesPanel.tsx`; `/api/wards/{map,timeseries}` |
| **Anomaly detection** — knows when this July's NDVI is worse than 5 of the last 7 Julys | `src/lib/supabase.ts::fetchWardMonthlyBaseline` + `computeVci`; VCI now persisted across 1091 satellite_indices rows |

### For research + insurance (tertiary)

- **Open-data-quality herder ground-truth** — the pilot's differentiated dataset
  (nothing else in Isiolo has both space-based NDVI + herder ground-truth in the same schema)
- **Parametric drought triggers** — VCI dropping below a threshold ward-by-ward
  (future: livestock insurance payout triggers)

---

## 2. Customer Segments — who exactly are our target users?

### Primary: pastoralists in the 5 Isiolo Sub-County wards

- **Wabera (241)** — Sub-County HQ; mixed livestock (cattle, goats, camels)
- **Bulla Pesa (242)** — urban-adjacent, higher literacy, first-cohort target
- **Ngare Mara (245)** — northern grazing corridor
- **Burat (246)** — north-western, historically drought-hit
- **Oldonyiro (247)** — north-eastern, cross-border movement to Samburu

Sub-segments in the app model:
- **Verified pastoralists** (`pastoralists` table) — ops-added, real,
  data feeds analytics and gets the full drill cadence
- **Leads** (`pastoralist_leads` table) — self-enrolled via USSD Jisajili;
  in a follow-up cadence until ops verifies them
- **Unknown callers** — no phone match; get a generic brief, no
  outbound dispatch

Current counts (pre-launch, all synthetic test personas):
- Verified: **1** (Mohamed Ali, +254712000004, Bulla Pesa)
- Leads: **2** (Amina Wanjiku Ngare Mara, Fatuma Osman Burat)
- Real pilot cohort target: 50 pastoralists across the 5 wards
  before public launch

### Secondary: county government + NGOs (revenue-bearing)

- **NDMA (National Drought Management Authority)** — county-level
  drought early-warning consumer
- **Isiolo County Agriculture Office** — extension services + policy
- **Mercy Corps, ILRI, IFPRI** — research + humanitarian partners
- **Livestock Marketing Council** — market-price data exchange

### Tertiary: private-sector (post-pilot)

- **Micro-insurance underwriters** (parametric livestock insurance,
  APA Insurance / ACRE Africa)
- **Feed-store chains** (targeted supplementary-feed distribution
  in drought-declared wards)

---

## 3. Channels — how do we reach + interact with the target market?

### Outbound → herder

| Channel | Endpoint | Cost |
|---|---|---|
| **SMS (bulk shortcode)** | AT `POST /version1/messaging` | ~KES 0.80/message |
| **Voice call (outbound)** | AT `POST /call` (once voice enabled) | ~KES 3/minute (est.) |
| **Voice call (inbound)** | AT deterministic pipeline via `voice-callback` | free to us; user's carrier rate |
| **USSD session** | AT `POST /ussd-callback` | free to us; ~KES 1/session for user |

### Inbound → us

| Herder action | AT hits | We respond |
|---|---|---|
| Texts keyword to `48910` | `/api/sms-callback` | outbound SMS reply |
| Dials `*384*NNNN#` | `/api/ussd-callback` | `CON`/`END` text |
| Dials our voice number | `/api/voice-callback` | XML `<Say>+<GetDigits>+<Record>` |
| Delivery report on our SMS | `/api/sms-delivery-callback` | log + `lead_interactions` row |
| STOPs / opts out | `/api/sms-optout-callback` | flip `alerts_enabled=false`, log |

### Ops + partner channels

- **React dashboard** at `<tunnel>/` — auth-gated (`admin@ardalink.test`)
- **`/api/ops/*` endpoints** — verify, decline, backfill, callback log
- **Supabase REST** — partners can be issued read-only role scoped
  to the `api_*` views for their data-sharing agreement
- **Future: WhatsApp Business API** — extend the same content pipeline
  when smartphone penetration justifies it

---

## 4. Customer Relationships — how do we interact?

### Herder relationships

- **Automated by default** — every SMS keyword auto-replies, every
  USSD keystroke gets a screen back
- **Community + peer-signal** — the herder isn't isolated; the brief
  includes "N others near you also reported this week"
- **Trust-first phrasing** — first-name greeting, ward mention, no
  technical jargon ("VCI"), invitations to correct us ("tuambie kama
  sasa iko sawa")
- **Consent-respecting** — `STOP` opts out in real time (bulk opt-out
  callback handler), respected across all future outbound
- **Closed-loop guarantee** — every action ends with a callback SMS
  (per `feedback_no_open_loops.md`)

### Ops relationships

- **Lead verification workflow** — new subscribers land in the ops
  panel with verify/decline buttons; verification triggers a
  welcome SMS in the caller's language
- **Live callback log** — every USSD/SMS/voice hit visible within
  30 seconds via the dashboard's `CallbackLog` component
- **Data-driven follow-up** — ops can filter interactions by
  ward/channel/phone to identify at-risk callers

### Partner relationships (post-pilot)

- **Data-sharing agreements** — Supabase role-scoped API keys
  under written MOU with each partner
- **Attribution** — partner logos + funder attribution on herder-facing
  channels where consented
- **Quarterly progress reports** — auto-generated from the dashboard
  data, hand-curated narrative

---

## 5. Revenue Streams — how does the solution generate or provide value?

### Pilot phase (current — grant-funded)

- **Grant funding** — JHUB Africa, development-partner track. Not a
  sustaining revenue stream; a runway to prove product-market fit.
- **No revenue from herders**, ever. Value must remain free at the
  point of use for the primary user.

### Sustainable phase (post-pilot, planned)

| Stream | Customer | Model | Est. unit |
|---|---|---|---|
| **County / NGO subscription** | NDMA, Mercy Corps, ILRI | per-ward per-month SaaS | $200–500/ward/mo |
| **Data licensing** | Research institutions | annual dataset access under MOU | $5–20k/yr per partner |
| **Parametric insurance data feed** | ACRE Africa, APA | per-trigger event + per-policy | to be modelled |
| **Government partnership** | County Government of Isiolo, NDMA | annual MoU + integration fees | $10–50k/yr |
| **White-label rollout** | Sister counties (Marsabit, Wajir, Turkana) | one-time setup + recurring | scaling model |

**What we do NOT do:**
- Charge herders directly
- Sell their personal data to third parties
- Monetise the ground_truth_reports table outside pre-agreed MOU
  scopes

### Break-even math (rough, pilot-scale)

- 50 pastoralists × 30 outbound SMS/mo × KES 0.80 = **KES 1 200/mo = ~$8**
- Cloud (Supabase free tier + GEE free tier + Azure Speech + OpenAI
  tokens) = **~$40/mo** at this scale
- **Total pilot burn: ~$50/mo** for a 50-pastoralist cohort
- At 5 wards × 300 pastoralists × 30 SMS/mo = **~$120/mo SMS spend**
- One county subscription ($200/mo minimum) covers full operating
  cost even at 1 500-pastoralist scale.

---

## 6. Key Resources — what do we need to make the solution functional?

### Human

- **Engineering team** — full-stack (currently 118 commits in
  ~2 weeks of active dev)
- **Ops team** — 1 lead for pilot; needs 2–3 field agents for
  cohort onboarding + verification workflow
- **Mass Comm** — content + narrative alignment (owned separately)
- **Domain advisors** — pastoralist community leaders, veterinary
  extension officers

### Technical stack

| Layer | Provider | Data |
|---|---|---|
| **Source of truth** | Supabase Postgres | 1 093 satellite rows, 910 forecast rows |
| **Local mirror** | Local Postgres w/ RLS | ground_truth_reports |
| **Satellite** | Google Earth Engine | Sentinel-2 S2 SR Harmonised monthly |
| **Weather** | Open-Meteo | 14-day forecast + 30-day observation |
| **Water infra** | WPDx (open data) | 10-row Isiolo snapshot, herder-overlaid |
| **Channels** | Africa's Talking | SMS + USSD + Voice (voice pending activation) |
| **Speech** | Azure Speech (southafricanorth) | Kiswahili + English STT + TTS |
| **LLM** | Azure OpenAI (GPT-5-mini) | Voice indicator extraction |
| **Deployment** | Cloudflare quick-tunnel (temp), Fly.io/Cloudflare Named (target) | Ephemeral demo → permanent |

### Data

- **11 years** of monthly Sentinel-2 NDVI per ward (Supabase)
- **VCI + baseline percentiles** now persisted for every historical row
- **Ward geometry** (PostGIS MultiPolygon) for map rendering
- **Ward adjacency graph** (ward_neighbors) for migration advice
- **WPDx water-point snapshot** — refresh path via
  `scripts/pull-wpdx.mjs`

### IP

- **The processing pipeline itself** — satellite fetch → context
  overlay → language-aware brief → channel dispatch → ground-truth
  capture → overlay update. Documented in `system-diagrams.md`.
- **The Kiswahili content library** — 6+ months of iteration on
  natural, non-robotic phrasing tested with pastoralist advisors
  (planned; currently developer-tested)
- **The trust-scoring model** (Phase B, upcoming)

---

## 7. Key Activities — what must the system do continuously?

### Data ingestion (scheduled)

- **Satellite refresh** — engine (`:5001`) fetches Sentinel-2 per
  ward per month → `satellite_indices`
- **Forecast refresh** — `forecastJob` every 6 h → `weather_forecast`
- **WPDx refresh** — manual annual pull via `scripts/pull-wpdx.mjs`
- **VCI backfill** — one-shot when new historical years land

### Channel operations (real-time)

- **SMS response** — `POST /api/sms-callback` → context lookup →
  language-aware brief → outbound SMS
- **USSD sessions** — `POST /api/ussd-callback` → menu / drill /
  Jisajili state machine
- **Voice pipeline** — opener → DTMF → 20 s record → STT → GPT-5
  indicator extract → ground_truth_reports → summary SMS
- **Outbound dispatch** — post-record summaries, welcome SMSes,
  future daily drill

### Ground-truth loop (continuous)

- **Interaction logging** — every hit → `lead_interactions`
- **Overlay update** — herder-reported water status feeds
  `overlayStatusFromGroundTruth`
- **Peer signal aggregation** — 7-day rolling window per ward

### Ops (human-in-loop)

- **Lead verification** — new leads → ops review → verify or decline
- **Cohort onboarding** — field-agent-driven pastoralist recruitment
- **Alerts + escalations** — future: threshold-triggered outbound
  batches for severe drought events

### Compliance + hygiene

- **Data privacy** — RLS in Postgres, opt-out honoured cross-tier
- **CI + tests** — 259 tests, 9 CI jobs, green on every push
- **Branch discipline** — feat/* → dev → staging → master, no
  direct commits to shared branches (per
  `feedback_branch_discipline.md`)

---

## 8. Key Partnerships — who do we depend on?

### Technology partners

- **Africa's Talking** — SMS + USSD + Voice provider. Sandbox +
  production tenants; support relationship live (Denis, AT Support)
- **Google (Cloud + Earth Engine)** — GCP for compute + GEE for
  satellite. Free-tier sufficient for pilot volume.
- **Microsoft Azure** — Speech (STT/TTS) in southafricanorth,
  OpenAI GPT-5-mini
- **Supabase** — managed Postgres + auth. Free tier sufficient for
  pilot cohort.
- **Cloudflare** — future named tunnel + DNS + Registrar

### Data partners

- **WPDx (Water Point Data Exchange)** — CC-BY open data,
  10-row Isiolo baseline
- **Open-Meteo** — CC-BY-NC weather data
- **GEE Public Data Catalog** — Sentinel-2, MODIS, IMERG (planned)

### Ecosystem partners

- **JHUB Africa** — incubator + funder (this exercise)
- **Isiolo County Government** — pilot access + cohort recruitment
  (planned MOU)
- **NDMA (National Drought Management Authority)** — future data
  consumer + potential co-funder
- **ILRI (International Livestock Research Institute)** — research
  validation + potential data-licensing customer
- **Local pastoralist cooperatives** — trust-building + on-the-
  ground context (pilot phase)

### Communication partner

- **Mass Comm lead** (team member) — narrative + content plan
  (owned separately from this technical doc)

---

## 9. Cost Structure — what does it cost to run?

### Fixed (monthly, pilot scale)

- **Cloud infrastructure** — currently ~$0 (free tiers: Supabase,
  Azure trial, GEE free tier). Target production ~$50/mo
- **CI/CD** — GitHub Actions free-tier sufficient
- **Domain + named tunnel** — $10–30/yr (planned, not incurred yet)
- **Engineering time** — the only real cost; grant-funded during pilot

### Variable (per pastoralist per month)

| Item | Rate | 50-pastoralist cost/mo |
|---|---|---|
| Outbound SMS (drill + confirmations) | ~KES 0.80/msg × 30/mo | ~KES 1 200 (~$8) |
| Voice minutes (once enabled) | ~KES 3/min × 5min/mo | ~KES 750 (~$5) |
| Azure Speech STT | ~$0.30/hr × 0.05 hr/mo | ~$0.75 |
| Azure OpenAI GPT-5-mini | ~$0.01/call × 5/mo | ~$0.05 |
| **Total per-herder variable** | | **~$0.28/mo** |

### One-time / setup

- **AT Test Number provisioning** — TBD (waiting for AT response)
- **Cloudflare Registrar domain** — $10/yr
- **Field-agent training for cohort** — planned Phase B

### Sustainability posture

At **5 wards × 300 pastoralists = 1 500-user scale**, monthly opex
is dominated by SMS (~$120) + cloud (~$100). One county-government
subscription ($200+/mo) is enough to cover full opex before any other
revenue stream is activated. Scale-up path is linear (SMS + Speech
scale per-message; cloud + LLM cost is sub-linear).

---

## Alignment cross-check — how strategy maps to code

The audit reviewer can independently verify each pillar against the
repo. Quick reference of "what file proves what pillar":

| Pillar | Load-bearing code / data |
|---|---|
| Value Propositions | `src/lib/herderContext.ts`, `src/lib/voiceCopy.ts`, `src/lib/wpdx.ts`, `src/lib/supabase.ts::peerSignalForWard` |
| Customer Segments | `pastoralists`, `pastoralist_leads`, `api_phone_identity` view; `feedback_no_pilot_data_writes.md` (two-tier policy) |
| Channels | `src/routes/{sms,ussd,voice,smsDelivery,smsOptOut,smsSubscription}.ts`; dashboard `LeadsSection`, `CallbackLog` |
| Customer Relationships | `feedback_no_open_loops.md`; `src/routes/ops/leads.ts`; `sendSmsViaAt` with rate limit |
| Revenue Streams | *planned* — no code yet; documented under section 5 |
| Key Resources | dependency versions in `package.json` and `pyproject.toml`; `system-diagrams.md` component diagram |
| Key Activities | `src/jobs/{satelliteJob,forecastJob,vciBackfillJob}.ts`; `src/routes/index.ts` for the 87 mounted routes |
| Key Partnerships | `README.md` third-party attribution section (to add); env variable list |
| Cost Structure | This document only — no code artefact needed |

---

## What's not yet in the BMC (honest gaps)

- **No signed MOU** with Isiolo County or NDMA yet — pilot pre-launch
- **No paying customer** — all revenue-stream claims are targets,
  not current facts
- **No field-agent SOP** for real pastoralist enrollment
- **No AT Voice product** enabled — voice channel is code-complete
  but not user-facing
- **No named tunnel** — the callback URL rotates every few hours
  (fix planned this sprint)

These gaps are the sprint plan for the next 2–4 weeks; see
`progress-2026-07-13-technical.md` §3 for detailed assignments.
