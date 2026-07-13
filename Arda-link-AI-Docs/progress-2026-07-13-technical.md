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
- All three channels (SMS, USSD, voice pipeline) working end-to-end
  against the AT sandbox — verified live with test personas
- Ops dashboard shows real-time interaction log, lead management,
  ward NDVI trends, 14-day rainfall forecast
- 11 years of Sentinel-2 history + fresh rainfall forecast +
  WPDx water infrastructure all persisted in Supabase
- Herder-facing content is Kiswahili-natural, no jargon,
  language-routed per caller preference
- No open loops — every completed action ends with an outbound SMS

**Numbers (all live from the running system):**

| Metric | Count |
|---|---|
| Git commits | 118 |
| API routes | 87 |
| Passing tests | 259 / 259 |
| Satellite indices rows (11yr) | 1 093 |
| Weather forecast rows | 910 |
| Lead interactions logged | 17 |
| Test pastoralists (verified) | 1 |
| Test leads (self-enrolled) | 2 |

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

1. In AT simulator's USSD tab, dial the service code
   (`*384*NNNN#` — check current channel).
2. Walk the 5-item menu:
   ```
   CON ArdaLink — Bula Pesa
     1. Bula Pesa (drought brief)
     2. Malisho (water points)
     3. Ongea na AI (voice call)
     4. Toka
     5. Jisajili / Register
   ```
3. **Pick 5 (Jisajili).** Walk the enrollment:
   - Screen 2: type a full name
   - Screen 3: pick ward digit (1..5)
   - Screen 4: pick language (Kiswahili / English)
   - Screen 5: END confirmation + welcome SMS dispatched
4. Refresh dashboard **LeadsSection** — the new lead appears with
   status `lead`, verify + decline buttons.
5. Click **Verify** on that lead. Watch:
   - Ops user (admin@ardalink.test) attributed as verifier
   - `pastoralist_leads.status='verified'` + `promoted_pastoralist_id`
     set to the new pastoralists row
   - A welcome SMS dispatched via AT
   - LeadsSection now shows ✓ verified

### 2.4 Voice pipeline (5 min — code walkthrough, not live)

Voice is fully implemented but the AT sandbox does not include
voice product — Denis at AT support confirmed. Test number request
pending (Applications → Voice → Phone number → Test Number).
Everything below is verifiable from the code + prior local runs.

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
   per pass to `weather_forecast`.

3. **VCI backfill** — `POST /api/ops/vci-backfill` computed VCI
   for 774/776 historic rows using the 11-year baseline. Now every
   satellite_indices row has a persisted VCI value (0..100).

4. **Herder ground-truth overlays WPDx** — WPDx's 2012 Isiolo
   survey says every borehole is broken. When herders confirm
   "working" via voice/SMS, `overlayStatusFromGroundTruth()` in
   `wpdx.ts` updates the effective status in future briefs.

5. **Peer signal** — `peerSignalForWard()` aggregates recent
   ground_truth_calls + lead_interactions in the ward over 7 days.
   Only surfaces when ≥ 2 other callers to avoid the herder's
   own echo.

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
| Frontend | **Dashboard viz** | WardMap gets layer toggles: forecast-NDVI overlay from artifact, migration corridor arrows from B2 output. | Wed–Fri |
| Ops | **Cohort growth** | Field-agent SOP for onboarding 10 real pilot pastoralists (Isiolo Sub-County). No auto-writes — ops-added only. | Wed |
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
SOP + AT voice number are both in place. **This is planned**, not
a blocker in the classical sense — but any presentation that says
"herders using the system" needs to be corrected to "test personas
exercising the system pre-launch".

### 4.5 CI Node 20 deprecation warnings — **noise**

GitHub Actions warns that Node 20 is deprecated. Doesn't fail any
build. Action versions bumped when their maintainers publish v5s.

### 4.6 CI gitleaks license — **noise**

Warning about missing GITLEAKS_LICENSE secret. Doesn't fail any
build; a free license fetch + repo secret update kills the warning.

---

## 5. Quick appendices

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
