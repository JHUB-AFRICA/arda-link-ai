# ArdaLink — Technical Progress Presentation

**Team:** ArdaLink · **Date:** 2026-07-13 · **Slot:** 8:30–9:30 AM

**Status heading:** Pre-launch pilot. All data in Supabase + local mirror is
**test / synthetic** — no real herders enrolled yet. Every "customer" phone
number in this doc (`+254712000004`, `+254799954672`, `+254799955101`) is a
personified test fixture used to exercise the pipeline end-to-end.

---

## 1. Executive summary (1 minute)

ArdaLink is a satellite-to-pastoralist drought-intelligence system for
Isiolo County, Kenya. Pastoralists reach the system via **Africa's Talking
SMS + USSD + Voice** in Kiswahili/English; the system fuses **Sentinel-2
NDVI + Open-Meteo rainfall + WPDx water-point + herder ground-truth** into
personalised briefs and outbound alerts.

**State today (pre-launch):**
- **SMS + USSD verified live on the AT sandbox** end-to-end against
  test personas — inbound message → handler → outbound reply → all AT
  callback types (delivery, opt-out, subscription) round-trip
- **Voice pipeline is code-complete and verified via local/tunnel
  loopback** — the deterministic 3-stage flow (opener → DTMF prompt
  → STT capture → summary SMS) runs against sim requests to
  `/api/voice-callback`. Real-handset demo is blocked on AT Voice
  product activation (see §4.1) — not on our code
- Ops dashboard shows real-time interaction log, lead management,
  ward NDVI trends, 14-day rainfall forecast, PostGIS ward
  choropleth, per-cell heatmap (see §2.5)
- 11 years of Sentinel-2 history + fresh rainfall forecast +
  WPDx water infrastructure all persisted in Supabase — plus 2.36 M
  per-cell NDVI rows across the 5 wards' ~3 300-cell grid, now wired
  into the herder brief and dashboard
- Herder-facing content is Kiswahili-natural, no jargon,
  language-routed per caller preference
- No open loops — every completed action ends with an outbound SMS

**Numbers (all live from the running system, updated 2026-07-15):**

| Metric | Count |
|---|---|
| Git commits since 0.1.0 | 130+ |
| API routes | 91 |
| Passing tests | 271 / 271 (api) + 29 / 29 (dashboard) |
| Merged PRs (this alignment sprint) | 16 |
| Satellite indices rows — ward-monthly (11 yr) | 1 093 (861 with VCI populated) |
| Satellite cell indices rows — ~1 km grid, 11 yr | **2 361 853** |
| Ward cells — Isiolo grid | 26 975 (17 – 1 287 per ward) |
| Weather forecast rows | 3 080 (dedup fix in PR #28 collapses ~34 duplicate forecasts per day → 1 per date per ward) |
| Weather data rows — daily observations | 30 (growing daily via `upsertWeatherData` RPC, PR #29) |
| Lead interactions logged | 17 |
| Test pastoralists (verified) | 1 |
| Test leads (self-enrolled) | 2 |

**What shipped in this sprint (2026-07-14 → 15):** 16 PRs merged incl. dashboard heatmap layers (both Ground Truth SVG + Map tab Leaflet overlay), cell-endpoint bypass of a timing-out Supabase view, forecast dedup fix, `.env.local` loader path fix, RPC wrapper library, weather-observation daily upsert job, CI hardening. See PR list on GitHub for the full record.

---

## 2. Live demo walkthrough (25 minutes)

Everything below runs against the local stack (`:3000` api, `:5001`
engine, `:8080` web-proxy). Public URL uses a Cloudflare quick-tunnel
that rotates — the current URL is printed by the tunnel script; check
before demo.

### 2.1 Show the dashboard (3 min)

1. Open dashboard SPA at the tunnel URL → **Login**
   ```
   admin@ardalink.test / admin-secret-2024
   ```
2. Land on **Map** tab — SVG choropleth of the 5 active Isiolo wards
   (Wabera, Bulla Pesa, Ngare Mara, Burat, Oldonyiro). NDVI-coloured
   brown→green with dashed adjacency edges.
3. Switch to **Ground Truth** tab. Four panels stacked:
   - **TimeSeriesPanel** — 12-month NDVI history + 14-day rainfall
     forecast per ward (chip picker to switch)
   - **LeadsSection** — self-enrolled leads with verify / decline actions
   - **CallbackLog** — every AT surface hit in real time (30 s poll)
   - **GroundTruthSection** — the actual herder reports table

### 2.2 SMS end-to-end (5 min)

1. **AT sandbox simulator** open at `simulator.africastalking.com`
   with a Kenyan test phone (e.g. `+254712000004`).
2. **Send SMS `BULA` to shortcode `48910`.**
3. Watch reply arrive: natural Kiswahili brief with severity word +
   rain framing + water-point invitation. Example:
   > *Habari Mohamed, ArdaLink hapa (Bulla Pesa). Malisho ya ward
   > yako bado ni ya kadri, mvua ni ndogo sana mwezi huu. Bwawa la
   > karibu (Burat) ilikuwa mbovu — tuambie kama sasa iko sawa.*
4. **Live curl to prove same happens over the tunnel:**
   ```bash
   curl -X POST https://<tunnel>/api/sms-callback \
     -H "Content-Type: application/x-www-form-urlencoded" \
     --data-urlencode "from=+254712000004" \
     --data-urlencode "to=48910" \
     --data-urlencode "text=BULA" \
     --data-urlencode "id=demo-1"
   ```
5. Refresh dashboard **CallbackLog** — the interaction appears live.
6. Show the other keywords briefly: `MALISHO` (WPDx water points),
   `RIPOTI` (last report), `STOP` (empty reply — opt-out convention).

### 2.3 USSD self-enrollment (Jisajili) (5 min)

1. In AT simulator's USSD tab, dial the service code (the AT test
   channel our sandbox is bound to — check the current one before
   the demo).
2. Walk the 5-item menu:
   ```
   CON ArdaLink — Bula Pesa
     1. Bula Pesa (drought brief)
     2. Malisho (water points)
     3. Ongea na AI (voice call)
     4. Toka
     5. Jisajili / Register
   ```
3. **Pick 5 (Jisajili).** Walk the 4-screen enrollment (screen 1 is
   the menu itself; Jisajili adds four more screens on top):
   - Screen 1 (Jisajili): type a full name
   - Screen 2: pick ward digit (1..5)
   - Screen 3: pick language (Kiswahili / English)
   - Screen 4: END confirmation + welcome SMS dispatched
4. Refresh dashboard **LeadsSection** — the new lead appears with
   status `lead`, verify + decline buttons.
5. Click **Verify** on that lead. Watch:
   - Ops user (admin@ardalink.test) attributed as verifier
   - `pastoralist_leads.status='verified'` + `promoted_pastoralist_id`
     set to the new pastoralists row
   - A welcome SMS dispatched via AT
   - LeadsSection now shows ✓ verified

### 2.4 Voice pipeline (5 min — code + local loopback, not live-handset)

Voice is fully implemented and **verified against sim requests hitting
the local `/api/voice-callback` over the Cloudflare tunnel** — the
XML flow, DTMF handling, and STT + summary-SMS chain all round-trip.
The AT sandbox does not include the Voice product (Denis at AT
support confirmed 2026-07-11), so we can't yet route a real handset
through it. Test-number request is pending (Applications → Voice →
Phone number → Test Number). Everything below is verifiable from the
code + the tunnel-based loopback demo.

1. Open `ardalink-api/src/routes/voice.ts` — deterministic 3-stage flow:
   - **Opener** — `<Say>` (Kiswahili opener from `voiceOpener()` +
     one insight) followed by `<GetDigits>` with a 7-item DTMF menu
   - **DTMF** — reads the digit, spoken confirmation, `<Record>`
     20 s max + `#` finish
   - **Recorded** — pipeline downloads MP3, transcodes via ffmpeg
     to 16 kHz WAV, Azure Speech STT with sequential locale retry
     (sw-KE then en-KE), GPT-5-mini indicator extract,
     ground-truth insert, outbound SMS summary
2. Open `ardalink-api/src/lib/voiceCopy.ts` — natural Kiswahili
   templates with variance pool (deterministic per phone + UTC day)
3. Open `ardalink-api/src/lib/speech.ts` — the fix that unblocked
   sandbox voice: universal ffmpeg → WAV transcode + sequential
   locale retry (Azure short-audio doesn't accept WebM or handle
   `languageIdentification` param).

### 2.5 Data pipeline (5 min)

1. **Satellite** — engine (`:5001`) runs GEE via a
   Copernicus/Sentinel-2 S2 SR Harmonised composite per ward per
   month; result written to `satellite_indices`. Live curl:
   ```bash
   curl http://127.0.0.1:5001/api/v1/satellite/vci?ward_id=bulla-pesa
   ```
   Returns VCI, current NDVI, historic min/max, urban-masked,
   Prosopis-adjusted.

2. **Weather forecast** — `forecastJob.ts` runs every 6 h, hits
   Open-Meteo per ward centroid, writes 14 days × 5 wards = 70 rows
   per pass to `weather_forecast`. **Since PR #29 (2026-07-15)** it
   also fetches 30 days of past observation, upserts a single
   `weather_data` row per ward via the `upsert_weather_data` RPC
   (previously 0 code refs), and calls `refresh_satellite_indices_latest`
   to keep the materialised view current. The `/api/wards/timeseries`
   payload now dedupes stale forecast rows so the dashboard rainfall
   chart shows 14 real dates instead of collapsing on one (PR #28).

3. **VCI backfill** — `POST /api/ops/vci-backfill` computed VCI for
   774/776 historic rows using the 11-year baseline (2 rows skipped
   for missing coverage). Combined with the 87 natively-computed
   rows, **861 of 1 093 satellite_indices rows now have a persisted
   VCI value** (0..100); the remaining 232 rows are current-month
   pulls where the historical envelope isn't yet fully populated.

4. **Herder ground-truth overlays WPDx** — WPDx's 2012 Isiolo
   survey (14 years stale as of 2026) says every borehole is broken.
   When herders confirm "working" via voice/SMS,
   `overlayStatusFromGroundTruth()` in `wpdx.ts` updates the
   effective status in future briefs. Ground-truth window default is
   **90 days** (`recentWaterPointGroundTruth(90)`).

5. **Peer signal** — `peerSignalForWard()` aggregates recent
   ground_truth_calls + lead_interactions in the ward. Window is
   **7 days** — deliberately shorter than the 90-day water-point
   window because peer mood/pasture data goes stale faster than
   water-point functional status. Only surfaces when ≥ 2 other
   callers to avoid the herder's own echo.

6. **Per-cell drought signal (2026-07-14 → 15)** — `wardCellStressSummary()`
   aggregates the 2.36 M-row `satellite_cell_indices` table into a
   ward-level hotspot signal at the ~1 km resolution. Wired into the
   herder brief so the opener can quantify patchy stress ("1 014 of
   1 116 patches in Ngare Mara are dry today, 91 %") instead of only
   the ward-mean NDVI. **Two dashboard surfaces render the grid:**
   the compact SVG map on the Ground Truth tab (PR #23) with a
   **Cells: on/off** toggle, and the full Leaflet map on the Map tab
   (PR #30) with a **Drought heatmap** overlay in the layers control.
   Both are backed by `/api/wards/:id/cells/latest` — the endpoint
   bypasses a timing-out Supabase view (PR #28) and Range-paginates
   the PostgREST 1 000-row cap.

7. **Live stress today (2026-07-15):**

| Ward | Cells | Stressed (NDVI < 0.25) | Cell NDVI range |
|---|---:|---:|---|
| 241 Wabera | 17 | 1 (6 %) | 0.23 – 0.45 |
| 242 Bulla Pesa | 21 | 9 (43 %) | 0.21 – 0.31 |
| 245 Ngare Mara | 1 116 | **1 014 (91 %)** | 0.10 – 0.52 |
| 246 Burat | 833 | 683 (82 %) | 0.10 – 0.49 |
| 247 Oldonyiro | 1 287 | 948 (74 %) | 0.08 – 0.76 |
| **Total** | **3 274** | **2 655 (81 %)** | — |

   The urban wards (Wabera, Bulla Pesa) sit in the wetter southeast;
   the rural wards are broad, mixed-stress landscapes. Ngare Mara's
   91 % cell-level stress is a signal the ward-mean NDVI (0.19) hides —
   the mean masks how uniformly the pattern is spread. **This is the
   value of the cell grid.**

**Dual-write note on ground truth.** Every voice-report ingest
inserts to two rows: `ground_truth_calls` on Supabase (source of
truth, 2 rows today) AND `ground_truth_reports` on the local Postgres
mirror (36 richer rows, retained for the pre-Supabase migration
history). The local mirror is being retired for redundant satellite
+ climate tables (see §5) but stays live for ground truth until
Supabase-primary catches up.

### 2.6 Loop-closure architecture (2 min)

Every action ends in a callback. Show the sequence diagram
(`system-diagrams.md`, diagram 2) — Herder dials USSD 5 → api
resolves identity → captures name/ward/lang → inserts lead → fires
welcome SMS → dashboard updates → ops verifies → welcome-again SMS.
No dead ends.

---

## 3. Sprint plan — week of 2026-07-13 (voice unblock + Phase B kick-off)

**Sprint goal:** demo-able voice call to a real handset by Friday +
first ML forecast running as a Colab notebook, with all Phase A
production dashboards holding steady.

### Assignments

| Owner | Track | Deliverable | Day |
|---|---|---|---|
| Dev lead | **Voice unblock** | Submit AT Test Number request via Applications → Voice → Phone number. Set Category = Test Number. | Mon |
| Dev lead | **Voice unblock** | Once approved: configure voice callback URLs, run 3-way test (inbound call → deterministic pipeline → ground_truth_reports row + summary SMS). | Tue–Wed |
| Backend | **Named tunnel** | Replace Cloudflare quick-tunnel with named tunnel bound to a domain — stop URL rotation that keeps invalidating AT callback config. | Tue |
| Backend | **Phase B — B1** | Set up `ardalink-engine/notebooks/ndvi_forecast.ipynb` in Colab. Read from Supabase, train CatBoost NDVI-forecast on 11yr panel, dump artifact JSON. | Wed–Thu |
| Backend | **Phase B — B2** | `migration_corridor.ipynb` — Dijkstra over ward_neighbors with cost = distance − (dest NDVI forecast gain) − (dest rain probability). Deterministic (no ML). | Thu |
| Frontend | **Dashboard viz** | ~~WardMap gets layer toggles~~ **✅ shipped** (PR #23 Ground Truth SVG heatmap + PR #30 Map-tab Leaflet heatmap). Migration-corridor arrows still pending B2. | Wed–Fri |
| Ops | **Cohort growth** | Field-agent SOP for onboarding the first **10 real pilot pastoralists** (Isiolo Sub-County), scaling to 50 before the public launch. No auto-writes — ops-added only. | Wed |
| All | **Demo prep** | Rehearse next Monday's walkthrough end-to-end using real (not synthetic) data. | Fri |

### Weekly ceremonies

- **Daily standup:** 9:15 AM — what shipped yesterday, blocker today
- **Mid-week check:** Wed 4 PM — voice unblock status + demo dry-run
- **Friday review:** commit history + test coverage delta + docs update

---

## 4. Active blockers

### 4.1 AT Voice product not enabled on sandbox — **critical**

The AT sandbox does not include the Voice product. Confirmed with
AT support (Denis, 2026-07-11). Voice code is fully implemented and
tested against local + tunnel loopback; blocked only on AT
provisioning a live Test Number.

**Impact:** cannot demo real voice call to a handset until resolved.
**Owner:** dev lead. **Blocker:** external (AT approvals team).
**Mitigation:** demo the voice-callback XML flow via curl + walk
the code path in the presentation, show recorded browser demo.

### 4.2 Ephemeral tunnel URLs invalidate AT dashboard config — **high**

Cloudflare quick-tunnels drop every few hours. Each rotation forces
re-pasting all 5 callback URLs into the AT dashboard. Not sustainable
during ops-driven testing.

**Impact:** loses ~10 min every drop + risks demo failing if tunnel
rotates mid-presentation.
**Owner:** backend. **Mitigation this sprint:** named tunnel with a
stable hostname (Tue task).

### 4.3 Supabase service_role missing DELETE on ground_truth_calls — **low**

Two test rows (Mohamed Ali) from an earlier verification run are
stuck in Supabase because service_role lacks DELETE grants. Cannot
clean up test data without the Supabase owner running
`GRANT DELETE ON public.ground_truth_calls TO service_role;`.

**Impact:** cosmetic — the rows are correctly labelled test data
and the pilot hasn't launched.
**Owner:** Supabase admin. **Mitigation:** flag when we onboard the
first real pastoralists.

### 4.4 No real pilot cohort — **planned, not a blocker yet**

Only test personas exist. Real enrollment starts when field-agent
SOP + AT voice number are both in place. Target: **first 10 real
pastoralists, scaling to 50 before public launch**. **This is
planned**, not a blocker in the classical sense — but any
presentation that says "herders using the system" needs to be
corrected to "test personas exercising the system pre-launch".

### 4.7 Open-Meteo licensing on paid tiers — **flag for legal review**

Open-Meteo's free tier is CC-BY-NC (non-commercial). We're safe for
the pre-launch pilot and for a county subscription positioned as
public-service (NDMA-adjacent) rather than commercial resale. If we
sell forecast data to a commercial reinsurer or agri-fintech, we
either need Open-Meteo's commercial plan or a swap to a commercial
provider (Meteomatics, Weather Company). Flagged for legal review
before the first commercial MOU, not blocking today.

### 4.5 CI Node 20 deprecation warnings — **noise**

GitHub Actions warns that Node 20 is deprecated. Doesn't fail any
build. Action versions bumped when their maintainers publish v5s.

### 4.6 CI gitleaks license — **noise**

Warning about missing GITLEAKS_LICENSE secret. Doesn't fail any
build; a free license fetch + repo secret update kills the warning.

---

## 5. ML potential — how ArdaLink learns from its data

The system is designed as a **data flywheel**: more herders → more
ground-truth → better models → better briefs → more herder trust →
more herders. That's the compounding asset. The moat isn't the code
(all open-source stack); it's the labeled data. This section maps the
concrete models the current schema unlocks, ordered by how much herder
data each one needs.

### 5.1 What the data landscape looks like today

We have ~30 million observation data points (satellite × time × cell)
and effectively zero behavioural labels (2 ground-truth calls, 17
lead interactions — all pre-launch test personas). That shapes what
is trainable **today** vs what waits for **pilot launch**.

| Table | Rows | Signal type |
|---|---:|---|
| `satellite_cell_indices` | **2 361 853** | Per-cell monthly NDVI + Prosopis correction + 8 derived indices, 11 yr history |
| `satellite_indices` | 1 093 | Ward-monthly NDVI + VCI (0..100), 11 yr history |
| `ward_cells` | 26 975 | Spatial grid geometry (~1 km cells) |
| `weather_forecast` | 3 080 | Growing daily (Open-Meteo 14-day ensemble × 5 wards × 4 runs/day) |
| `weather_data` | 30 | Daily observations, growing since 2026-07-15 (PR #29) |
| `ward_neighbors` | 28 | Adjacency graph for corridor optimisation |
| `ground_truth_calls` | 2 | **The bottleneck.** Real herder reports fill this only after pilot launch |
| `pastoralist_leads` + `lead_interactions` | 2 + 17 | Enrolment + AT-surface audit trail |

### 5.2 Tier 1 — Trainable today (no herder data needed)

**T1.1 Cell-level VCI backfill — the single biggest unlock.** The
2.36 M cell rows have raw NDVI but `vci_value` is null. Same maths as
the ward-level backfill we already ran (774/776 rows in PR #28's
predecessor). Applied at cell resolution it turns every cell into a
labelled dry/wet observation per month across 11 years. Persist via
`upsert_satellite_cell_indices` (RPC wired in PR #25). **~1 day of
compute.** Every downstream ML task depends on this.

**T1.2 NDVI forecast (per-ward, 1–3 months out).** 11 years × 12
months × 5 wards = 660 monthly data points. Small but tractable with
LightGBM/CatBoost + walk-forward CV. Features: prior 12 NDVI values,
prior 6 rainfall values, month-of-year, neighbour-ward NDVI, public
ENSO / IOD proxies. Deliverable:
`ardalink-engine/notebooks/ndvi_forecast.ipynb` + artifact JSON +
`POST /api/ops/forecast/refresh` reload endpoint. **~1 day.**

**T1.3 Cell-level anomaly detection.** Once T1.1 lands, run per-cell
z-score against its historical envelope (or Isolation Forest). Flag
cells >2 σ below their month's baseline. Nightly job → new
`cell_anomalies` column. Dashboard renders as red hotspot markers on
the heatmap layer. **Turns the 2.36 M-row grid from decoration into
alerts.** ~2 days.

**T1.4 Prosopis (invasive tree) spread tracking.** The
`prosopis_share` + `prosopis_corrected` columns already exist on
every satellite_cell_indices row. Nobody watches them. A simple
year-over-year per-cell delta surfaces where prosopis is expanding —
a real ecological KPI county governments care about. **~1 day.**

### 5.3 Tier 2 — Waits for pilot data volume (weeks–months post-launch)

**T2.1 Herder response propensity.** Given brief content, timing,
herd size, and prior response history, predict reply probability.
Trains on `lead_interactions × ground_truth_calls`. Enables channel
routing: SMS vs voice vs skip. **First real ML that touches the
herder-facing loop.**

**T2.2 Water-point functional-status forecast.** Given seasonality,
recent ground-truth reports, nearby herder activity, predict whether
borehole X is likely working today. **Beats WPDx (14-year stale) by
orders of magnitude.** This is the flagship model — the piece nobody
else can build without ArdaLink's ground-truth stream.

**T2.3 Kiswahili content quality RL loop.** Track which brief
templates get replies vs opt-outs. Reinforcement-learning-from-herder-
response over the variance pool in `voiceCopy.ts`. Content improves
week over week without engineer intervention.

### 5.4 Tier 3 — Novel with the cell grid

**T3.1 Migration-corridor optimiser (deterministic, no ML).** Build a
graph from `ward_cells` (cell_i, cell_j implicitly encode adjacency).
Dijkstra with edge weight = distance + NDVI-forecast-deficit + water
availability + herd-crossing difficulty. **Deterministic + explainable
— no black-box ML** — but transformational for the herder-facing
question "where should I move stock this week?".

**T3.2 Herd-carrying-capacity model.** Per-cell forage estimate
(NDVI × biomass conversion) × herd size → suggested stocking rate.
Livelihood advisory: "your ward can support X animals through the dry
season". Fits the county-planning use case.

**T3.3 Spatiotemporal cell-graph transformer (research).** Each cell
= token with temporal + spatial features. ~100 M params fine-tunable
on our data. Long-horizon research angle for county partners
positioned as "we run our own regional AI".

### 5.5 Becoming a data gem

What makes ArdaLink's data actually unique:

1. **Paired satellite × community-verified ground truth in ASAL Kenya.**
   Almost no other dataset exists at this granularity. WPDx is 14
   years stale; NDMA aggregates by county not community.
2. **Kiswahili pastoralist drought vocabulary.** Natural register,
   tested with a native audience. Small but genuinely novel NLP corpus.
3. **Cell-resolution intra-ward drought variance.** 3 274 cells across
   5 wards — no other publicly-known dataset has this granularity for
   ASAL Kenya.
4. **Consented, opt-outable per-herder migration + water-point
   interaction traces.** Once pilot ingests, this is data reinsurers
   would pay for (parametric livestock insurance triggers).

Data products the platform could offer (tiered by consent + partner
MOU):

| Product | Consumer | Access |
|---|---|---|
| Ward-level NDVI + VCI aggregate (11 yr + live) | Researchers | Open API, CC-BY-NC |
| Cell-level drought heatmap (aggregate) | County govts, NDMA | County-subscription API |
| Ground-truth water-point status feed | NGOs (Mercy Corps, ILRI) | MOU + fee |
| Migration corridor traces (anonymised) | Reinsurers, agri-fintech | Commercial MOU, per-query |
| Kiswahili content corpus + reply-labelled dataset | AI/NLP researchers | Academic license |

### 5.6 Recommended sequencing

1. **Merge remaining doc + heatmap PRs (this week).**
2. **Ship T1.1 cell VCI backfill** — foundation for everything else.
3. **Ship T1.2 NDVI forecast notebook + T1.3 anomaly detection.**
4. **Publish a `data.md` product catalog** (one page per Tier row above:
   what it is, who it's for, MOU template placeholder).
5. **Pilot launch — the actual bottleneck for Tier 2 and 3.** Every
   Tier 2 model depends on ground-truth volume that only real herders
   generate.
6. **First Tier 2 model within 4 weeks of pilot's first 20 verified
   herders.** Water-point functional-status forecast (T2.2) is the
   clearest win to ship first — it validates the whole flywheel.

**One-line pitch for the ML story:** *"We already have 2.36 million
per-cell satellite observations covering 11 years. Every real herder
call adds a ground-truth label satellite alone can't infer. Model
quality compounds with cohort size — the pilot isn't testing a
product, it's minting the training set that makes ArdaLink
unreproducible."*

---

## 6. Quick appendices

### A. How to run the demo (checklist)

```bash
# 1. Verify services
ss -tlnp | grep -E ":3000|:5001|:8080"

# 2. Verify tunnel
curl -s https://<tunnel>/api/healthz

# 3. Login + fetch a token (used for /api/ops/* endpoints)
TOK=$(curl -s -X POST https://<tunnel>/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@ardalink.test","password":"admin-secret-2024"}' \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['token'])")

# 4. Quick health of Phase A data
curl -s https://<tunnel>/api/wards/timeseries | jq '.wards[0] | .name, (.ndvi | length), (.forecast | length)'

# 5. Live SMS BULA (from a test phone in the AT simulator)
#    Reply lands in simulator + dashboard CallbackLog within 30s
```

### B. Test personas (all synthetic pre-launch)

| Phone | Name | Tier | Ward | Preferred lang |
|---|---|---|---|---|
| `+254712000004` | Mohamed Ali | verified (test) | 242 Bulla Pesa | sw |
| `+254799954672` | Amina Wanjiku | lead (self-enrolled test) | 245 Ngare Mara | sw |
| `+254799955101` | Fatuma Osman | lead (self-enrolled test) | 246 Burat | sw |

### C. Reference — see `system-diagrams.md` for UML

- Component diagram: system topology + data flow
- Sequence diagram: USSD self-enrollment end-to-end
- Use case diagram: actors + capabilities

### D. Supabase source-of-truth alignment (2026-07-14)

**Decision:** Supabase is the sole source of truth for reference +
operational data. The local Postgres mirror is being retired for
tables where Supabase has strictly-better coverage, and kept only
for auth + tenancy scaffolding Supabase doesn't yet host.

**Current state (row counts as of 2026-07-14):**

| Object | Location | Rows | Status |
|---|---|---|---|
| `satellite_indices` (ward-monthly, 11 yr) | Supabase | 1 093 | Source of truth |
| `satellite_cell_indices` (~1 km grid, 11 yr) | Supabase | **2 361 853** | **Wired in 2026-07-14** — was 0 src refs |
| `ward_cells` | Supabase | 26 975 | Wired in 2026-07-14 |
| `api_latest_cell_satellite_indices` (view) | Supabase | — | Wired in 2026-07-14 |
| `api_ward_cell_latest_rollup` (view) | Supabase | — | Available, not yet consumed |
| `weather_data` + `weather_forecast` | Supabase | 25 + 1 190 | Source of truth |
| `ground_truth_calls` | Supabase | 2 (test) | Source of truth going forward |
| `pastoralists` | Supabase | 1 (test) | Source of truth going forward |
| `pastoralist_leads` + `lead_interactions` | Supabase | 2 + 17 | Source of truth |
| `satellite_snapshots` | Local | 51 | **Retire** — duplicate of `satellite_indices` |
| `climate_snapshots` | Local | 51 | **Retire** — duplicate of `weather_data` + `weather_forecast` |
| `ground_truth_reports` | Local | 36 | Keep during dual-write until Supabase catches up |
| `pastoralists` | Local | 16 | Keep during dual-write, reconcile up |
| `admin_users`, `tenants`, `tenant_feature_flags` | Local | 4 + 3 + 12 | Keep — no Supabase counterpart yet |

**Untapped Supabase server-side RPCs** (available, not yet called):
`refresh_satellite_indices_latest`, `upsert_satellite_cell_indices`,
`upsert_satellite_indices`, `upsert_weather_data`, `rebuild_ward_cells`.
Moving current-side upsert logic into these RPCs is the next
architectural step; not on this sprint's critical path.

**ML implications of the cell grid.** With per-cell NDVI at ~1 km
resolution, Phase B unlocks:
1. **Per-pixel anomaly** — flag cells whose stress diverges from the
   ward median (e.g. a single stressed patch inside an otherwise-OK
   ward that's driving herder complaints).
2. **Migration-corridor optimisation at cell resolution** — Dijkstra
   over cell-adjacency instead of ward-adjacency; produces routes
   that go around specific bad patches, not just neighbouring wards.
3. **Water-point demand pressure modelling** — join
   `satellite_cell_indices` × WPDx points via cell geometry; per-point
   dry-season demand curve becomes a real signal.

All three are Phase B notebook work, not this sprint's Colab tasks
(NDVI forecast + ward-level corridor) — but they're the reason we
wired the cell tables in now rather than later.
