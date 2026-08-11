# ArdaLink — Technical Progress

> **Pre-launch pilot.** Every phone number in this doc
> (`+254712000004`, `+254799954672`, `+254799955101`) is a test
> fixture. No real herders enrolled yet.

---

## 1. What ArdaLink is

**A drought-early-warning line for Isiolo pastoralists.** Any 2G
phone reaches it. It answers in Kiswahili or English.

```
   ┌──────────────────┐    ┌───────────────┐    ┌──────────────────┐
   │  Satellites      │    │  Weather      │    │  Water-point     │
   │  (greenness      │ +  │  (14-day      │ +  │  registry +      │
   │   per ~1 km cell)│    │   rainfall)   │    │  herder reports  │
   └────────┬─────────┘    └───────┬───────┘    └────────┬─────────┘
            └─────────────────┬────┴─────────────────────┘
                              ▼
                    ┌──────────────────┐
                    │   Kiswahili      │
                    │   brief per      │
                    │   herder         │
                    └────────┬─────────┘
                             ▼
              ┌──────────────┴────────────────┐
              │   SMS   ·   USSD   ·   Voice  │
              └───────────────────────────────┘
```

### Where we are

| Channel | Status |
|---|---|
| SMS | ✅ Verified live against Africa's Talking sandbox |
| USSD (self-enrol) | ✅ Verified live — 4-screen flow with a real welcome text |
| Voice | ⚠️ Code complete, works over our tunnel — waiting for AT to switch on the phone number |
| Dashboard | ✅ Real-time interaction log, ward map, drought heatmap, rainfall chart |
| Herder consent + opt-out | ✅ `STOP` honoured across every channel |

### Data on hand

| What | Rows | Freshness |
|---|---:|---|
| Ward-level satellite history | 1 093 | 11 years, monthly |
| **Cell-level satellite history (~1 km grid)** | **2 361 853** | **11 years, monthly** |
| Cell geometry (5 wards' grid) | 26 975 | Static |
| Rainfall forecast (14-day) | 3 080 | Refreshed every 6 h |
| Daily weather observation | 30 | New — added 2026-07-15, growing daily |
| Ward adjacency graph | 28 | Static |
| Herder reports (test) | 2 | Real ones start with pilot |
| Test personas | 3 | Pre-launch fixtures |

### Delivery this sprint (2026-07-14 → 15)

- **16 pull requests merged**
- 271 API tests + 29 dashboard tests all green
- Two new drought-heatmap surfaces on the dashboard
- Rainfall chart fixed (was collapsing to a single date)
- Every claim below ties to a merged PR

---

## 2. Live demo — how to run it

Everything runs locally. API on `:3000`, satellite engine on `:5001`,
web-proxy on `:8080`. Public demo goes through a Cloudflare tunnel —
check the tunnel script for the current URL before demoing.

### 2.1 Dashboard

Log in at the tunnel URL with `admin@ardalink.test /
admin-secret-2024`, then walk the two map surfaces:

| Tab | What it shows |
|---|---|
| **Map** | Full Leaflet map of Isiolo. Layer toggle exposes the drought heatmap (~3 300 cells coloured by greenness) + pastoralist pins + landmarks |
| **Ground Truth** | Compact ward map with the same heatmap · rolling 12-month greenness chart · 14-day rainfall chart · live log of every incoming SMS/USSD/voice hit · verify-a-lead panel |

### 2.2 SMS — full loop

From the Africa's Talking simulator, text `BULA` to shortcode `48910`
with test phone `+254712000004`. A natural Kiswahili brief comes
back:

> *Habari Mohamed, ArdaLink hapa (Bulla Pesa). Malisho ya ward yako
> bado ni ya kadri, mvua ni ndogo sana mwezi huu. Bwawa la karibu
> (Burat) ilikuwa mbovu — tuambie kama sasa iko sawa.*

The exchange appears live in the dashboard's callback log within a
few seconds.

**Keyword vocabulary:**

| Type | Reply |
|---|---|
| `BULA` | Drought brief for your ward |
| `MALISHO` | Nearest water points |
| `RIPOTI` | Your last report back to you |
| `STOP` | Opt out across every channel |

### 2.3 USSD self-enrolment (Jisajili)

Dial the sandbox service code. Five-item menu:

```
CON ArdaLink — Bula Pesa
  1. Bula Pesa (drought brief)
  2. Malisho (water points)
  3. Ongea na AI (voice call)
  4. Toka  (exit)
  5. Jisajili  (register)
```

Picking `5` walks four screens: name → ward digit → language →
confirmation + welcome SMS. The new lead appears in the dashboard.
An operator can **Verify** with one click; the system promotes the
lead into the pastoralists table, records who verified, and sends a
second welcome SMS.

### 2.4 Voice pipeline

Built and tested over our tunnel. Waiting on Africa's Talking to
switch on the phone number — the sandbox doesn't include Voice.

Three-stage flow, all verified end-to-end against simulated calls:

```
  Herder dials  →  Kiswahili greeting  →  Menu (press 1-7)
                                              │
                                              ▼
                     Record their reply (up to 20 s)
                                              │
                                              ▼
                Transcribe  →  Extract key facts  →  Write to database
                                              │
                                              ▼
                    Send them a Kiswahili summary SMS
```

The transcription pipeline handles Kiswahili and English
automatically. The summary SMS closes the loop — the herder never
hangs up wondering if it "went through".

### 2.5 The data behind every brief

Every brief a herder receives is a blend of five signals:

```
  ┌──────────────────────┐  Sentinel-2 satellite, monthly for
  │ 1. Greenness         │  each ~1 km patch of the ward.
  │    (11 yr history)   │  Live example: Ngare Mara is at
  └──────────────────────┘  greenness 0.19 vs its 11-yr July norm.

  ┌──────────────────────┐  Open-Meteo, refreshed every 6 hours.
  │ 2. 14-day rainfall   │  Also stores yesterday's actual —
  │    forecast          │  we now write both, not just forecast.
  └──────────────────────┘

  ┌──────────────────────┐  A national dataset of every borehole /
  │ 3. Water-point       │  water source. Last surveyed 2012 —
  │    registry (WPDx)   │  14 years stale — so we...
  └──────────────────────┘
              │
              ▼
  ┌──────────────────────┐  ...let herders confirm what's actually
  │ 4. Herder reports    │  working right now via voice / SMS.
  │    (last 90 days)    │  Their reports overwrite the stale registry.
  └──────────────────────┘

  ┌──────────────────────┐  What other herders in the same ward
  │ 5. Peer signal       │  reported this week. Only surfaces once
  │    (last 7 days)     │  at least 2 other people have reported.
  └──────────────────────┘
```

### 2.5.1 The greenness grid — headline result

We resolved a broken Supabase view this sprint and unlocked the
2.36 million per-cell records that were sitting unused. The heatmap
now shows drought as a **spatial pattern**, not a single ward
average.

| Ward | Cells | Stressed today | Green today |
|---|---:|---:|---:|
| Wabera (urban) | 17 | 6 % | 94 % |
| Bulla Pesa (urban) | 21 | 43 % | 57 % |
| Ngare Mara | 1 116 | **91 %** | 9 % |
| Burat | 833 | 82 % | 18 % |
| Oldonyiro | 1 287 | 74 % | 26 % |
| **All 5** | **3 274** | **81 %** | **19 %** |

The two urban wards sit in the wetter southeast pocket. The three
rural wards are essentially in drought at cell resolution. The
ward-average NDVI number would have hidden this — the mean says
"0.19" but doesn't tell you that **91 % of Ngare Mara's patches are
dry**. That's the value of the grid.

### 2.6 No dead ends

Every path ends with a text back to the herder.

```
   Herder dials USSD 5  →  system captures name / ward / language
                       →  writes lead to database
                       →  sends welcome SMS
                       →  operator verifies from dashboard
                       →  sends second welcome SMS
                       ─────────────────────────────
                             No open loops. Ever.
```

Same rule for voice: every hang-up gets a summary SMS. Every SMS
gets a reply. Every opt-out is honoured everywhere.

---

## 3. Sprint plan

**Goal:** first real voice call on a handset · first ML model running
· dashboard stays green throughout.

| Track | Status | Owner |
|---|---|---|
| Voice line switched on by Africa's Talking | ⏳ waiting on their team | Dev lead |
| Stable public URL (replace rotating tunnel) | 🔧 planned | Backend |
| First greenness-forecast model in a notebook | 🔧 planned | Backend |
| Migration-corridor route picker (no ML — just a shortest-path over the ward grid) | 🔧 planned | Backend |
| Dashboard heatmap layers (both maps) | ✅ shipped | Frontend |
| Field-agent guide for onboarding first 10 herders (scaling to 50) | 🔧 planned | Ops |
| Demo dry-run with real data | 🔧 planned | All |

### Rhythm

- Daily standup — what shipped, what's blocked
- Mid-week check — voice status + demo dry-run
- Friday review — commits, tests, docs

---

## 4. Active blockers

| Severity | Blocker | The fix | Who |
|---|---|---|---|
| 🔴 Critical | Voice needs Africa's Talking to activate our phone number | Waiting on their approvals team | External |
| 🟠 High | The demo URL rotates every few hours (Cloudflare quick-tunnel) | Move to a named tunnel with a stable domain | Backend |
| 🟡 Legal | Weather-forecast provider licence (Open-Meteo) is non-commercial only | Fine for county + public-service; needs a commercial swap before selling data to reinsurers | Legal review |
| 🟢 Planned | No real pilot herders yet (0 real, 3 test) | Field-agent guide + first 10, then 50 | Ops |
| ⚪ Noise | Node 20 deprecation warnings in CI | Bump when maintainers publish v5s | — |
| ⚪ Noise | gitleaks-license warning in CI | Free-tier licence + repo secret | — |
| ⚪ Cosmetic | Can't delete two test rows from Supabase (missing grant) | One-line SQL grant from DB admin | Supabase admin |

---

## 5. How ArdaLink learns

Every herder call adds a real-world label that satellites alone can't
see. Paired with 11 years of satellite history, that's the flywheel:

```
      more herders  ──►  more ground-truth
            ▲                    │
            │                    ▼
      better briefs        better models
            ▲                    │
            └──── smarter answers ┘
```

### 5.1 The data we sit on today

```
   Satellite observations          ~30 000 000 data points
   ═════════════════════════════════════════════════════
   Per ~1 km patch, 11 years, monthly                    ← 2.36 M rows
   Per ward, 11 years, monthly                           ← 1 093 rows
   Weather forecast + observation                        ← 3 100 rows
   Ward adjacency (for route models)                     ← 28 edges

   Community observations           17 (all test)
   ═════════════════════════════════════════════════════
   Real herder reports                                   ← 0 today
                                                       ↑
                                          ── unlocks once pilot launches ──
```

### 5.2 What we can train right now (no herders needed)

| # | Model | What it does | Effort |
|---|---|---|---|
| 1 | **Patch-level drought score** | Turns raw greenness into a 0–100 "how dry vs history" score for every ~1 km patch. Unlocks the next three. | small |
| 2 | **Greenness forecast** | 1–3 months out per ward, from 11 years of history + rainfall + neighbour signals. | small |
| 3 | **Hotspot alerts** | Nightly job flags patches that are much drier than their normal for the season. Red markers on the map. | small |
| 4 | **Invasive-tree tracking** | The satellite data already records where Prosopis is spreading. We haven't looked at it yet. | small |

### 5.3 What we can train once the pilot flows (weeks after launch)

| # | Model | What it does |
|---|---|---|
| 5 | **Water-point status forecast** | Predicts whether a specific borehole is working today. **Beats the current open dataset — last surveyed in 2012.** This is the flagship. |
| 6 | **Reply predictor** | For a given herder + brief, likelihood they'll reply. Lets the system pick SMS vs voice vs skip. |
| 7 | **Self-improving Kiswahili content** | Templates that get replies win; templates that get opt-outs fade. Content quality climbs week over week without a developer editing anything. |

### 5.4 What the cell grid unlocks (Phase B)

| # | Model | What it does |
|---|---|---|
| 8 | **Best-route picker** | Shortest path across the 3 274-patch grid, weighted by expected greenness + water. Answers "where should I move stock this week?" |
| 9 | **Carrying-capacity advisory** | Per-patch forage × herd size → suggested stocking rate for the dry season. |
| 10 | **Regional AI** | A small county-specific model trained on all of the above. "Isiolo runs its own AI." |

### 5.5 Why the data is a moat

Four things nobody else has together:

- **Satellite × community-verified ground truth in dryland Kenya.** Not aggregated to county level; not stale.
- **1 km resolution across the ward grid.** 3 274 patches per pass.
- **Kiswahili drought vocabulary tested with native speakers.**
- **Consented, opt-outable migration + water-point traces per herder.**

### 5.6 Products the data could become

| Data product | Who wants it | How they'd access |
|---|---|---|
| Ward-level greenness + drought score (open) | Researchers | Free API, non-commercial licence |
| Patch-level drought heatmap | County governments, NDMA | County subscription |
| Herder-verified water-point feed | NGOs (Mercy Corps, ILRI) | MOU + fee |
| Anonymised migration traces | Reinsurers, agri-fintech | Commercial MOU |
| Kiswahili content + reply corpus | AI / NLP researchers | Academic licence |

### 5.7 The sequence

```
   1  Ship the patch-level drought score  ─┐
   2  Ship the greenness forecast          │ ─── all before pilot
   3  Ship hotspot alerts on the dashboard │
   4  Publish the data-product catalog    ─┘
   ─────────────────────────────────────────
   5  Pilot launches → real ground-truth starts flowing
   ─────────────────────────────────────────
   6  Water-point status forecast          ─── within 4 weeks of
                                                first 20 herders
```

**In one sentence:** *We already have 11 years of satellite history
covering every 1 km patch of the ward. Every herder call adds a
label satellites can't see. Model quality compounds with cohort
size — the pilot isn't testing a product, it's minting the training
set that makes ArdaLink unreproducible.*

---

## 6. Appendices

### A. Pre-demo checklist

```
✓  local services up on :3000, :5001, :8080
✓  tunnel URL fresh (rotates every few hours)
✓  admin login works
✓  /wards/timeseries returns 12 greenness rows + 14 forecast dates
✓  Africa's Talking simulator open in a browser tab
✓  test phones ready: +254712000004, +254799954672, +254799955101
```

### B. Test personas

| Phone | Name | Role | Ward |
|---|---|---|---|
| `+254712000004` | Mohamed Ali | Verified test herder | Bulla Pesa |
| `+254799954672` | Amina Wanjiku | Self-enrolled test lead | Ngare Mara |
| `+254799955101` | Fatuma Osman | Self-enrolled test lead | Burat |

### C. Diagrams

See `system-diagrams.md` — component diagram, USSD sequence, actor
use-cases.

### D. Database at a glance

Supabase is the single source of truth. The local database is being
trimmed to only what Supabase doesn't yet host (admin auth,
per-tenant settings, live dual-writes for herder reports).

| Where | What | Rows |
|---|---|---|
| Supabase | Ward-level satellite history | 1 093 |
| Supabase | **Patch-level satellite history** (was untouched pre-sprint) | **2 361 853** |
| Supabase | Ward grid geometry | 26 975 |
| Supabase | Weather forecast + observation | 3 080 + 30 |
| Supabase | Herder + lead + interaction records | 1 + 2 + 17 |
| Local | Admin login, tenant settings | small |
| Local | Herder reports mirror (dual-write for safety) | 36 |
