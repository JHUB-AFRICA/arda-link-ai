# ArdaLink — project profile

**One line:** ArdaLink puts drought intelligence into the hands of
Isiolo pastoralists — in the language they speak, on the phones
they already have, without asking for anything they don't already
know.

**Status:** Pre-launch pilot. Full technical pipeline is built,
tested end-to-end, and operating against test personas. Real
pastoralist enrollment starts once the Africa's Talking Voice
product is provisioned + field-agent SOP is signed off.

---

## The problem

Pastoralist communities in Isiolo County depend on rain-fed
grasslands and shared water infrastructure for their livelihoods.
Both are becoming less predictable as the climate shifts:

- **The last five years have all been "worst since 20XX" for
  someone's ward.** Local rainfall variability is outpacing the
  seasonal rhythms herders' families have relied on for
  generations.
- **The water-point data of record (WPDx) is a decade stale.**
  The 2012 Isiolo survey lists every borehole as
  "Non-Functional". Some are working again. Some aren't. Nobody
  is systematically refreshing this signal.
- **Existing drought early-warning systems don't reach herders
  directly.** NDMA bulletins flow to county desks; they rarely
  reach the person deciding whether to move stock north today or
  wait a week.
- **Smartphones and apps are the wrong tool.** Herders overwhelmingly
  own basic 2G phones. The information has to arrive as SMS or via
  USSD, not through an app store.

## The solution

ArdaLink is a **satellite + AI + text-and-voice system** that
delivers ward-specific, herder-personal drought intelligence to any
mobile phone in Isiolo.

Every day, the system:

1. **Pulls fresh satellite data** — Sentinel-2 NDVI for the 5
   canonical Isiolo Sub-County wards (Wabera, Bulla Pesa, Ngare
   Mara, Burat, Oldonyiro), compared against 11 years of
   historical baseline to compute an anomaly signal (VCI).
2. **Fetches a 14-day rainfall forecast** — Open-Meteo per ward
   centroid, refreshed every 6 hours.
3. **Blends in herder ground-truth** — reports from other herders
   in the same ward within the last 7 days: is the water working,
   are the animals thin, what's the mood.
4. **Composes a natural-language brief** — in Kiswahili or English,
   depending on caller preference. No jargon like "VCI" or "NDVI":
   the herder hears *"grass is very poor this month, very little
   rain, the Burat borehole was broken — tell us if it's working
   now"*.
5. **Reaches the herder via their preferred channel** — SMS keyword
   like `BULA`, USSD menu at `*384*NNNN#`, or an inbound/outbound
   voice call in their language.
6. **Captures their reply as fresh ground-truth** — closing the
   loop so the next herder's brief improves.

## Who it's for

### Primary users — pastoralists in Isiolo County

Not smartphone-first users. Not literacy-first users. The system
meets them on the tools they already have and in the language they
already speak.

- **Verified pastoralists** — enrolled by field agents; get the
  full daily drill and are trusted for ground-truth
- **Self-enrolled leads** — anyone who dials the USSD service code
  and completes the 4-screen Jisajili flow. Land in a follow-up
  cadence until an ops agent verifies them.

### Beneficiaries downstream

- **County government + NDMA** — a ward-scale drought early-warning
  signal grounded in space-based data and validated by community
  reports
- **NGOs (Mercy Corps, ILRI)** — a data feed for programme design
  and impact evaluation
- **Insurance underwriters (parametric livestock insurance)** —
  objective triggers for payout events
- **Researchers (ILRI, IGAD-ICPAC, universities)** — a
  space-plus-ground pastoralist dataset that doesn't exist
  elsewhere

## What makes it different

### It speaks the herder's language

Not the "translated" language you get when English content is run
through a translator. Kiswahili content is written in the register
Isiolo herders actually use. The system picks language per caller
from their subscription preference.

### It has a two-way loop

Most drought early-warning systems push. ArdaLink pushes AND
listens. The herder's report ("water is working now") updates the
data other herders receive tomorrow. The system gets smarter with
every call.

### It uses infrastructure that already exists

- **Africa's Talking** for SMS + USSD + Voice — the same
  infrastructure that already reaches every 2G phone in East Africa
- **Google Earth Engine** for satellite — free-tier, public data
- **Open-Meteo** for weather — free, community-run
- **Supabase** for data — managed Postgres, generous free tier
- **Azure Speech** for Kiswahili STT/TTS — the best-in-class
  Kenyan voices

Almost nothing built here is a monolith. Every piece can be swapped
if a better provider emerges.

### It respects consent by default

The herder subscribes on their terms via USSD. They can text `STOP`
at any time and the system honours it across every channel. The
opt-out signal from AT's aggregation flow triggers the same
cross-tier flip. Nothing goes out to someone who hasn't asked for
it or has asked us to stop.

### It's honest about pre-launch

Every number in this profile ties to a Supabase table or a code
path. Nothing here claims to be already helping herders — it
claims to be *the pipeline that will help herders when the pilot
launches*. That's a critical distinction for funders and county
partners; over-claiming is fatal to trust.

## What's built today (evidence-backed)

- **259 automated tests, all passing** — every AT surface, every
  data helper, every language-aware brief template
- **1 093 rows of Sentinel-2 satellite history** — 11 years,
  monthly, 5 wards
- **910 rows of 14-day rainfall forecast** — refreshed every 6 h
- **All 5 Africa's Talking SMS callback types wired** — incoming,
  delivery reports, opt-out, subscription notifications
- **USSD self-enrollment flow live** — 4-screen Jisajili
- **Voice pipeline code-complete** — waiting on AT Voice product
  activation to demo to a live handset
- **Ops dashboard** — real-time interaction log, lead management,
  ward NDVI trends, 14-day rainfall forecast, PostGIS choropleth

Every claim above is independently verifiable in
`../progress-2026-07-13-technical.md` (with exact file paths and
counts) and `../system-diagrams.md` (with UML).

## What's next (this month)

- **Voice unblock** — Africa's Talking Test Number provisioning
- **Named tunnel** — replace ephemeral demo hosting with a stable
  URL so callback config stops rotating
- **First real pilot cohort** — 10–50 pastoralists onboarded via
  field agents; ops-verified, feeding the ground-truth loop with
  real signal
- **ML forecasting** — 14-day NDVI forecast per ward via a
  gradient-boosted model in a Colab notebook, artifact loaded by
  the engine

## How to reach us

- **Repo:** `github.com/JHUB-AFRICA/arda-link-ai`
- **Technical dossier:** `Arda-link-AI-Docs/` — progress deck,
  system diagrams, Business Model Canvas alignment
- **Team lead:** *(to be filled by team on their Notion workspace)*
- **Comms lead:** *(to be filled by team on their Notion workspace)*
