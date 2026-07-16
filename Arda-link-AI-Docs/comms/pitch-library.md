# ArdaLink — pitch library

Ready-made pitch variants for different rooms. Every version is
grounded in what the system does *today* (pre-launch), not what we
hope it does. Use them as scaffolding — the presenter's own voice
always beats a memorised script.

---

## 30-second pitch (elevator / cold intro)

> ArdaLink is a drought-intelligence system for Isiolo pastoralists.
> Every day it pulls satellite data, weather forecasts, and
> herder-reported ground truth, and sends any 2G phone a
> personalised Kiswahili SMS or takes a voice call — with the
> nearest working water point, whether the neighbouring ward has
> better pasture, and what other herders nearby have reported this
> week. We're pre-launch: the pipeline is built and tested, real
> pastoralist enrollment starts once Africa's Talking activates our
> voice channel.

*(≈ 76 words, ~30 seconds spoken at conversational pace.)*

---

## 2-minute pitch (partnership meeting, huddle, board slot)

> ArdaLink is a satellite-plus-AI-plus-SMS system that puts drought
> intelligence into the hands of the pastoralist who's actually
> deciding whether to move stock today or wait a week.
>
> The problem it solves: existing drought early-warning systems in
> Kenya are excellent at the county-level policy layer, but the
> herder walking the same grazing corridor his family has walked for
> generations rarely gets the information he needs, in the language
> he speaks, on the phone he already owns.
>
> The way it works: every day the system pulls fresh Sentinel-2
> NDVI for the 5 Isiolo Sub-County wards, compares against 11 years
> of historical baseline, blends in Open-Meteo rainfall, layers
> herder-reported ground truth over the 2012 WPDx water-point
> snapshot, and composes a single natural-Kiswahili sentence that
> tells the herder whether pasture is holding, whether the nearest
> borehole is working, and whether a neighbouring ward is greener.
>
> The system reaches the herder via SMS, USSD, or voice — same
> content, three channels, no smartphone needed. Herder self-enrols
> via a 4-screen USSD flow; they can opt out with a single `STOP`
> text and we honour it across every channel.
>
> Status: pre-launch. **271 automated tests pass** (plus 29 dashboard
> tests). The pipeline is live against synthetic test personas
> end-to-end. Real cohort onboarding starts once Africa's Talking
> activates our voice Test Number and our field-agent SOP is signed
> off with the county. On the ML side, we already sit on **2.36 million
> per-cell NDVI observations spanning 11 years** — once the pilot
> starts flowing ground-truth calls, we can train drought and
> water-point-status models nobody else can build.
>
> The ask depends on who you are — if you're at a county drought
> desk, we'd love to talk about integrating our ground-truth feed
> into your NDMA reporting. If you're a fellow builder, the repo is
> open. If you're a funder, our pre-launch operational cost is about
> $150 – 300/month at 1 500-pastoralist scale (the range depends on
> the SMS-to-voice mix — voice minutes are the biggest lever) — and
> a single county subscription in the $250 – 400/month range covers
> full opex before any other revenue.

*(≈ 279 words, ~2:00 spoken at moderate pace.)*

---

## 5-minute pitch (investor / partner deep-dive)

> Let me start with a number: **10**. That's how many water points
> exist in the WPDx open-data snapshot for Isiolo County. All 10
> were surveyed in 2012. All 10 are marked "Non-Functional". A
> pastoralist in Bulla Pesa in 2026 can't rely on that data. She
> knows some of them work. She knows some of them don't. But she
> has no way to know *which* ones today.
>
> That gap — between what the world's data says and what the herder
> actually needs to know today — is what ArdaLink closes.
>
> **What we built.** ArdaLink is three pipelines meeting in one
> Kiswahili SMS.
>
> Pipeline one is satellite. Sentinel-2 gives us free monthly NDVI
> per ward AND per ~1 km cell. We hold 11 years of ward history in
> Supabase — 1 093 ward-monthly rows plus 2.36 million per-cell
> rows across the 5-ward, 27 000-cell grid — and compute a per-month
> percentile envelope so "worse than the last five Julys" becomes a
> signal, not a vibe. The cell grid lets us say "487 of 1 287 patches
> in Oldonyiro are dry today", not just the ward mean.
>
> Pipeline two is weather. Open-Meteo, refreshed every 6 hours, 14
> days of daily rainfall forecast with confidence bands. Not "3 mm
> of rain expected on Tuesday" — herders don't think that way —
> but "the rain will likely stay away for the next 5 days" as a
> single natural-language phrase.
>
> Pipeline three is ground truth from the herder. When a herder
> tells us "the Burat borehole is working now" — via voice or SMS —
> we log it, we overlay it onto WPDx, and the next herder to text
> `BULA` in the same ward hears the herder-verified status. Each
> herder's report improves the value of every subsequent call in
> that ward for 90 days.
>
> Those three pipelines meet inside a helper that composes a single
> Kiswahili sentence like: *"Habari Mohamed, ArdaLink hapa (Bulla
> Pesa). Malisho ya ward yako bado ni ya kadri, mvua ni ndogo sana
> mwezi huu. Bwawa la karibu (Burat) ilikuwa mbovu — tuambie kama
> sasa iko sawa."*
>
> **What makes this different.** Three things.
>
> First, it speaks the herder's language natively. Not the
> translated-through-Google-Translate version — the register a
> Kiswahili-speaking pastoralist actually uses. We picked
> Kiswahili-first as an engineering constraint, not a translation
> afterthought.
>
> Second, it has a two-way loop. Most drought early-warning
> platforms push. ArdaLink pushes AND listens. Every herder's
> report becomes another herder's peer signal within 7 days. The
> system gets smarter, ward by ward, every day.
>
> Third, it works on the infrastructure that already reaches every
> 2G phone in Kenya. Africa's Talking runs SMS + USSD + voice for
> us — no app to download, no data plan needed, no smartphone
> assumed.
>
> **Where we are today.** Pre-launch. Everything I've described is
> built, tested end-to-end against synthetic personas, and running
> in a Supabase + Africa's Talking sandbox environment. 259
> automated tests all passing. Every AT SMS callback type has a
> handler. USSD self-enrollment is live. The voice pipeline is
> code-complete and blocked only on Africa's Talking provisioning
> a live voice Test Number — which their support team has
> confirmed is in the queue.
>
> **What's next.** Three things in the next 30 days: get the voice
> channel live, onboard the first 10 real Isiolo pastoralists (scaling
> to 50 before public launch) via field-agent introductions, and open
> the ground-truth data feed under MOU to a couple of ecosystem
> partners.
>
> **And why we care about that pilot number.** Every real herder
> report is a labelled data point that satellite alone cannot infer.
> Paired with 2.36 million per-cell NDVI observations already sitting
> in our database, that's the two rarest ingredients in ASAL data
> science — high-resolution earth observation AND community-verified
> ground truth. Once the pilot ingests, we can train models nobody
> else can build: water-point functional-status forecasting that
> beats the 14-year-stale open dataset by orders of magnitude,
> herder-response propensity for smart channel routing, and a
> deterministic migration-corridor optimiser over the 3 274-cell
> Isiolo grid. Model quality compounds with cohort size — the pilot
> isn't testing a product, it's minting the training set that makes
> ArdaLink unreproducible.
>
> **What it costs.** At the pilot's target scale — 1 500
> pastoralists across the 5 canonical wards — we're looking at
> **$150 – 300/month of operating cost**, the range depending on the
> SMS-to-voice channel mix (voice minutes are the biggest lever;
> SMS-heavy is the low end, voice-heavy the high end). Cloud
> infrastructure sits around $30 – 100/month depending on tier;
> satellite (Google Earth Engine free tier) and weather (Open-Meteo
> free non-commercial) are $0. **A single county-government
> subscription in the $250 – 400/month range covers full opex
> before any other revenue stream activates.**
>
> **What we're asking for depends on the room.** If you're a
> county drought desk in ASAL Kenya, we want to integrate a
> ground-truth feed into your NDMA reporting. If you're an
> insurance underwriter working on parametric livestock cover, we
> have the drought-trigger data pipe you're missing. If you're
> funding pre-launch climate-adaptation infrastructure, our
> pipeline is proven — we need runway to onboard the field. If
> you're a fellow builder, the repo is open and we welcome
> collaboration on the Kiswahili content library and the
> ground-truth flywheel.

*(≈ 664 words, ~4:30 spoken at deliberate pace — pad with a personal anecdote to reach the 5-min slot if needed.)*

---

## FAQ — anticipated questions + honest answers

### "How is this different from what NDMA already does?"

NDMA does county-level drought early warning superbly. Their bulletins
reach county desks and inform policy. What they don't do — and don't
claim to do — is put ward-specific, herder-personal information into
an individual pastoralist's SMS inbox in the language she speaks.
ArdaLink is complementary to NDMA, not competitive. In fact, part of
our roadmap is to offer NDMA a ground-truth data feed for their
county-level reports.

### "Why not build an app?"

Smartphone penetration in ASAL Kenya is well below urban averages,
data plans are expensive relative to typical pastoralist household
cash flow, and app-store distribution assumes English literacy. SMS
+ USSD + voice reaches every 2G phone in the country, in whichever
language the herder speaks, at a cost of pennies per interaction.
That constraint set is the point of the design.

### "Isn't Kiswahili just going to be Google Translate?"

No. Kiswahili content is written in the register Isiolo herders
actually use. We deliberately picked common words over textbook
Kiswahili Sanifu ("mifugo" not "wanyama wa nyumbani"), avoided
loan-word jargon ("mvua" not "precipitation"), and pre-warmed a
variance pool of natural phrasings so consecutive calls don't sound
scripted. The content library is tested and iterated with team
members who speak Kiswahili as a first language.

### "How does the herder trust you?"

Three trust anchors. First: opt-in via USSD Jisajili, not spam. The
herder subscribes on their terms. Second: `STOP` at any time and we
honour it across every channel — no dark patterns. Third: we invite
the herder to correct us ("tuambie kama sasa iko sawa" — tell us if
it's working now). Trust builds by treating the herder as the
source of truth, not the target of a marketing broadcast.

### "What about privacy? These are real phone numbers."

Row-level security on the Postgres tables so per-tenant queries can't
cross-read another cohort's data. Opt-out honoured system-wide. No
personal data sold or licensed outside pre-agreed MOU scopes. The
pastoralist's phone number never leaves our infrastructure except
in the AT dispatch to that same number.

### "You've built a lot for pre-launch. When are real herders using it?"

Two gates before real enrollment: (1) Africa's Talking provisions our
voice Test Number so the voice channel works end-to-end on a real
handset, and (2) our field-agent SOP is signed off with the county.
Both are on track this month. When those two are done, we start the
first 10–50 enrollments and scale from there.

### "Who owns the ground-truth data?"

The pastoralist. We hold it under a data-processing agreement, use it
to improve their own subsequent briefs and the peer-signal aggregate
their ward sees, and share it with partners only under pre-agreed
MOUs. The pastoralist can opt out any time, at which point their data
is retained only as required by regulator / audit rules and is not
used for outbound.

### "What happens when the pilot ends?"

We don't think of it as ending. The pilot is Phase 1 of a rolling
county-by-county cohort expansion. The sustainable business model
(one county subscription in the $250 – 400/month range covers full opex at 1 500-user scale) is
designed to keep the system running for the pastoralist regardless
of grant-funding cycles.

### "You say ML — what will you actually train, and when?"

Three tiers, ordered by how much herder data each needs.

**Trainable today (satellite-only, no pilot data needed):** cell-level
VCI backfill across the 2.36 M-row grid (turns raw NDVI into per-cell
drought severity); ward-monthly NDVI forecasting one-to-three months
out (LightGBM/CatBoost on 11 years of history); nightly cell-level
anomaly detection surfacing hotspots on the dashboard; prosopis
invasive-spread tracking using the `prosopis_share` column that
already exists.

**Waits for pilot ground-truth volume:** water-point functional-status
forecasting (the flagship — beats WPDx's 14-year-stale dataset by
orders of magnitude), herder response propensity for smart channel
routing (SMS vs voice vs skip), and a reinforcement-learning loop
where Kiswahili brief templates improve week-over-week based on which
ones get replies vs opt-outs.

**Novel with the cell grid (Phase B):** deterministic migration-
corridor optimiser using Dijkstra over the 3 274-cell adjacency graph
with edge weights from NDVI-forecast-deficit + water availability;
herd-carrying-capacity model that translates per-cell forage into
suggested stocking rates.

We ship Tier 1 in the next four weeks and Tier 2 within four weeks of
the pilot's first 20 verified herders.

### "What's the hardest technical thing you've solved?"

Making a Kiswahili severity phrase feel natural — "malisho ni ya
kadri" — while remaining honest to the underlying satellite VCI
number. The engineering pipeline is straightforward; the language
work is where the value lives, and where it's easiest to accidentally
sound robotic. Every content template goes through a Kiswahili
native-speaker review before it ships.

### "What's the biggest risk?"

Two: (1) Africa's Talking voice provisioning gets delayed and we
push real cohort enrollment further right than planned, and (2)
scaling the ground-truth flywheel requires cohort density —
below ~10 herders per ward the peer-signal aggregate is too thin
to be useful, so early-days content leans harder on satellite +
weather until the community layer thickens.

---

## Pitch-selection cheat sheet

- **30 sec** → cold intro at events, LinkedIn DM, WhatsApp intro
- **2 min** → partnership meeting opener, huddle slot, board
  update, university guest talk
- **5 min** → investor first-meeting, funder Q&A opener,
  conference lightning talk
- **FAQ** → keep open during any of the above; use as ready-made
  responses when the room asks
