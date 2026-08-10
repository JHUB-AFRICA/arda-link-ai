# ArdaLink AI — Herder-Facing Truthfulness & Ground-Data Audit

## Purpose

ArdaLink advises real pastoralists in Isiolo, Kenya over WhatsApp, USSD,
and SMS on water, grazing, and drought conditions. A wrong number here
isn't a UI bug — it can send someone walking 15km to a dead borehole.
This audit exists to verify that everything the system tells a herder
is either (a) a real, database-backed fact, (b) an honestly-labeled
estimate with its precision stated, or (c) an explicit "I don't know,
here's how to get a real answer" — never an invented number, an
unlabeled guess presented as fact, or stale/mock data masquerading as
current.

Do not fix anything found — this is a fact-finding audit. Report findings
with file:line references, a concrete failure scenario ("herder does X,
sees Y, which is wrong because Z"), and a severity (blocks-a-pilot /
real-but-narrow / cosmetic). Where a claim can be checked against the
live running system (not just code), check it live and say so.

## Scope

`ardalink-api` (Express/TypeScript — WhatsApp/USSD/SMS/voice channels),
`ardalink-engine` (FastAPI — water_nodes, satellite/NDVI, grazing rings),
the operator dashboard (`ardalink-web/dashboard`), and the Supabase
schema they read/write. Branch: `feat/operator-console`.

## 1. Real data vs. mock/hardcoded fallback

- Grep every herder-facing code path (`whatsappTurn.ts`, `routes/ussd.ts`,
  `routes/sms.ts`, `routes/chat.ts`, `routes/talk.ts` — NOT the
  `routes/demo/*` simulators, which are allowed to be lighter-weight) for
  any remaining reference to `data/wpdxIsiolo.ts` (the hardcoded 2012
  WPDx snapshot) outside of the documented engine-unreachable fallback in
  `waterNodes.ts`. Confirm the fallback path is only hit when
  `fetchAdminWaterNodes()` genuinely returns null (engine down), never as
  a silent primary path.
- Grep for any hardcoded lat/lon literal (`0.3453`, `37.581`, or similar)
  outside of test fixtures — ward centroids should come exclusively from
  Supabase's `wards.centroid` (`centroidForWardId`/`centroidForTenant`).
- Confirm `src/lib/data/landmarks/index.ts`'s registry is still
  ward-scoped correctly (only ward `242` has real data) and that no code
  path invents a landmark name/coordinate for an uncovered ward.
- In the live `water_nodes` table: re-confirm the 12 `source IS NULL`
  legacy/demo rows (the ones marked `functional`) are still
  `verified = false` and excluded from `nearestRealWaterPoints()`'s
  results. If any have been promoted since, verify that was a deliberate
  operator action (check `admin_audit_log`), not an accidental
  regression in the eligibility filter (`verified = true AND
  deleted_at IS NULL`).
- Confirm the operator dashboard's own water-node views
  (`GroundTruthAuditSection.tsx` and the Water Sources tab) show the
  same real counts as a direct query — no separate cached/stale copy
  drifting from what herders actually get served.

## 2. Anti-hallucination grounding rules — verify none have regressed

Read `whatsappConversation.ts`'s `whatsappGroundingRules()` and confirm
every one of these is still present, unweakened, and not contradicted
elsewhere in the assembled prompt (this file has had five same-day
rewrites in rapid succession — check for leftover contradictory
fragments, not just presence of the current intent):

- Never invent NDVI/rainfall/water-point data for a ward not explicitly
  supplied in the prompt this turn.
- Never state a water point name/distance/status not given to it this
  turn (no recalling a prior turn's number for a new location).
- Never claim to have received a live location unless the inbound
  message was an actual WhatsApp location share, not text describing one.
- Never claim to send a map pin/attachment (the bot cannot do this).
- Never invent survival/water-finding/livestock technique.
- Never route a herder to a **confirmed** broken/dry point.
- Never conflate an **unknown**-status point with a confirmed-broken
  one (they must be treated completely differently — see §3).

For each rule, find one live or synthetic test that would trip it, and
confirm the current prompt actually prevents it (not just that the rule
text exists — LLM instruction-following is not code, verify against a
real generated prompt string via the test suite, and ideally one live
message).

## 3. The "unknown vs. confirmed-broken" distinction (the day's central fix)

This was corrected twice in one day after live incidents — audit it
specifically:

- Confirm `resolveWaterPointPresentation()` in `whatsappConversation.ts`
  is the single source of truth for this branching, and that
  `whatsappTurn.ts`'s pending-followup write path calls the *same*
  function (or the query-ward equivalent) rather than a second,
  possibly-drifted copy of the logic.
- Live-test: message the bot as a herder near a point whose real
  `water_nodes` status is `unknown`. Confirm the reply (a) names the
  point, (b) states a distance, (c) does **not** say "unknown" or
  "unconfirmed" to the herder, (d) does not ask a same-turn
  yes/no status question.
- Live-test: message the bot as a herder near a point confirmed
  `non-functional`/`dry`. Confirm the reply (a) does NOT present it as
  a destination, (b) explicitly says not to travel there, (c) may ask a
  same-turn status-change question (this one case still asks
  immediately — confirm that's intentional, not a leftover bug).
- Confirm the "directions from anywhere" query-ward path
  (`resolveQueryWard`) feeds the SAME correct point into the pending
  ground-truth follow-up as what the reply actually named — this exact
  mismatch was caught and fixed once already (herder asked about Burat,
  bot named a Burat point, but the follow-up table was tracking the
  herder's home-ward point instead). Verify no analogous drift exists
  for the landmark-mention path (`findLandmarkMention`) or the
  fresh-GPS-share path.

## 4. Implicit ground-truth loop — the delayed check-in

- Confirm `water_point_followup_pending` rows are written only when a
  point is genuinely presented as a recommendation (mode `"unknown"`),
  never for confirmed-working or confirmed-broken points.
- Confirm the read side enforces both the minimum age (~20 min — enough
  time to travel) and maximum age (~24h — still relevant) and that a
  row is consumed (cleared) the first time it's surfaced, so a herder is
  never asked about the same recommendation twice.
- Confirm the check-in framing in the prompt never uses the words
  "ground truth," "survey," "data," or "report" to the herder — check a
  real generated prompt string, not just the source comment's intent.
- Check for races: what happens if the herder sends two messages in
  quick succession (before the LLM reply to the first has caused any
  side effects)? Could a follow-up be double-written or double-cleared?
  Is this table subject to the same true concurrency risk noted for
  `whatsapp_registration_pending` (no per-phone lock), and if so, is that
  an acceptable, low-probability edge case given real herder typing
  speed, same as it was ruled there?

## 5. Structured ground-truth capture — does the data actually close the loop?

- Confirm `ground_truth_calls.water_point_name` is populated end-to-end:
  LLM-extracted (`extractIndicators().water_point_name`), USSD's
  point-picker confirm flow, and SMS's `MAJI SAWA`/`MAJI MBAYA` keyword
  all write it, and `recentGroundTruthCalls()`'s SELECT actually returns
  it.
- **Check live Supabase directly** (not just the local mirror) for
  whether migration `0016_ground_truth_calls_water_point_name` has
  actually been applied — if not, ground-truth writes with a point name
  are failing (caught, logged, silently falling back to the local
  mirror) and the ops dashboard's Ground Truth Audit panel is reporting
  `ready: false`. This was flagged as an outstanding action item; confirm
  whether it's since been applied.
- Confirm there is still no automatic write-path from a herder's
  confirmation back into `water_nodes.functional_status` — that mutation
  is deliberately operator-console-only (see `admin_water.py`'s header).
  If any code path bypasses this (calls the engine's PATCH endpoint
  directly from a herder-facing route), that's a real regression against
  a deliberate design decision, not an improvement.

## 6. Distance/location honesty

- Confirm every distance shown to a herder is haversine straight-line
  (see `waterNodes.ts`'s `haversineKm`), and that no prompt or UI text
  implies it's a walking/road distance.
- Confirm the four-tier origin provenance (live GPS > landmark mention >
  registered location > ward centroid) is labeled correctly and
  consistently in every generated prompt — spot check with fixtures
  covering all four tiers plus the "directions from anywhere" query-ward
  centroid case.
- Check whether the straight-line-vs-actual-travel-distance caveat is
  disclosed to herders anywhere, or only known internally — if a
  real herder has ever pushed back that a stated distance took much
  longer to walk, that's worth surfacing even though it's expected
  behavior, not a bug.

## 7. Data freshness — is stale data presented as current?

`GET /api/healthz` currently reports `pipeline.status: "degraded"`:
`satellite_indices` last wrote 2026-07-09 (~33 days stale, past its
36h threshold) and `weather_data` last wrote ~20h ago (past its 12h
threshold).

- Determine whether ward-level NDVI/VCI figures currently being quoted
  to herders (in `wardLine`/`droughtLine` and USSD/SMS's `BULA` brief)
  reflect this staleness, and whether anything in the reply discloses
  "as of [date]" or similarly signals the data's age — or whether a
  33-day-old NDVI reading is being presented with the same confidence as
  a fresh one.
- Is this staleness an expected pause (e.g. GEE quota, a known paused
  job) or a genuine silent writer failure? Check
  `journalctl --user -u ardalink-api.service` and the satellite job's
  own logs for errors, not just the heartbeat's timestamp.

## 8. Cross-channel consistency

WhatsApp, USSD, and SMS each have their own copy of "resolve real
water_nodes data, fall back to WPDx only if unreachable." Confirm none
has drifted — e.g., a fix landing in `whatsappTurn.ts` without an
equivalent in `routes/ussd.ts`/`routes/sms.ts`. USSD/SMS notably do NOT
yet have the delayed-follow-up mechanism WhatsApp has (they ask
immediately when a herder taps/confirms a specific point) — confirm
that's a known, accepted gap (documented in `STATUS.md`), not something
someone will assume is already parity.

## 9. Live verification checklist

Run these against the actually-running service (`curl` against
`localhost:3001` or the public webhook), not just unit tests, and record
the real request/response pairs:

1. WhatsApp: ask for water in a ward with a nearby `unknown`-status
   point. Confirm plain, non-hedged guidance.
2. WhatsApp: same herder, ~20+ min later (or a manually-backdated pending
   row), any unrelated message. Confirm a natural check-in appears.
3. WhatsApp: ask for water where the nearest point is confirmed
   `non-functional`. Confirm it is NOT presented as a destination.
4. USSD: `*<code>#` → Malisho → pick a point number → confirm
   working/not-working. Confirm a `ground_truth_calls` row lands with
   the right `water_point_name` and `channel='ussd'`.
5. SMS: `MALISHO` then `MAJI SAWA`. Confirm the reply references the
   actual nearest point and a `ground_truth_calls` row lands with
   `channel='sms'`.
6. Ask about a landmark-named place (e.g. "Abubakar Mosque", ward 242).
   Confirm the distance is computed from the landmark's own coordinates,
   not the ward centroid.
7. Ask about a different ward by name ("niko Ngare Mara"). Confirm the
   reply's water point matches that ward, not the herder's home ward,
   and that the SAME point is what gets tracked for a later check-in.

## Output format

One finding per issue: `file:line` (or "live-only, no single file"),
one-sentence claim of the defect, the concrete failure scenario, and
severity. If a section turns up nothing, say so explicitly — an audit
that only reports problems looks incomplete next to one that also
confirms what's solid.
