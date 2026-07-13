# ArdaLink — content playbook

**Purpose:** editorial calendar + story drafts + social copy + visual
asset plan for the ArdaLink pilot. Everything here is scaffolding —
the Mass Comm teammate rewrites in their voice, prioritises against
what's actually shippable in a given week.

**Constraint threaded throughout:** pre-launch. Every content
angle either (a) speaks to the *system* we've built or (b) speaks
to the *why* behind it. Nothing claims real-user outcomes because
we don't have real users yet.

---

## §1 — What we're saying (three master narratives)

Pick one, run with it consistently for 4–6 weeks, retire when the
next milestone (voice launch, first real cohort) opens a new angle.

### Master narrative A — "The satellite that speaks Kiswahili"

**Angle:** technology in service of culture. Frontier AI + earth
observation + Kenyan language, in the hands of the person who
actually needs the answer.

**When to use:** launching to the tech community, developer
audiences, LinkedIn thought leadership.

**Key beats:**
- Global satellite data is free (Sentinel-2, MODIS). The problem
  isn't data availability — it's the last mile.
- The last mile in Isiolo is a Kiswahili SMS to a 2G phone.
- The engineering challenge isn't building the AI — it's making
  the AI natural in a Kenyan register on a channel that costs KES
  0.80 per message.

**Proof points:**
- 11 years of Sentinel-2 NDVI in Supabase
- Kiswahili content library tested end-to-end via AT sandbox
- Voice pipeline handles both `sw-KE` and `en-KE` STT + TTS

### Master narrative B — "Pastoralists teaching AI"

**Angle:** the ground-truth flywheel. AI usually asks for data
without giving anything back. ArdaLink reverses the flow.

**When to use:** AI + development sector audiences, policy talks,
grant applications.

**Key beats:**
- The system starts with 14-year-old WPDx water-point data. Every
  point marked "broken" in 2012.
- When a herder tells us via voice or SMS that a borehole is
  working now, the next herder to text `BULA` hears "working" not
  "broken". WPDx becomes wrong; the herder becomes the source of
  truth.
- Each herder's report becomes another herder's peer signal within
  7 days.

**Proof points:**
- `overlayStatusFromGroundTruth()` in `wpdx.ts`
- `peerSignalForWard()` in `supabase.ts`
- The `no-open-loops` design rule (SMS handoff on every action)

### Master narrative C — "The drought will happen; the loss doesn't have to"

**Angle:** impact framing. Drought is a known-known — the surprise
is always the losses that could have been avoided if the right
person had the right information at the right hour.

**When to use:** funders, insurance partners, county government.

**Key beats:**
- Isiolo has had five back-to-back drought years. NDMA bulletins
  are excellent for policy. They rarely reach the herder deciding
  whether to move stock today.
- A single herder-facing SMS can change a livestock loss trajectory:
  "your neighbour Wabera has a bit more pasture, worth thinking
  that direction; nearest working borehole is 12 km".
- Cost per herder-facing decision: ~KES 0.80. Cost of losing an
  adult cow to drought: KES 40 000+.

**Proof points:**
- The complete migration-hint + water-point + peer-signal brief
  that Mohamed Ali (test) gets on `BULA` today
- Break-even math in `business-model-canvas.md §9`

---

## §2 — Audience map (who + how)

| Segment | Channel | Register | Cadence |
|---|---|---|---|
| **Development sector** (UNDP, USAID, GIZ, FCDO) | LinkedIn long-form + newsletter | Evidence-heavy, impact-forward, careful with claims | Monthly deep-dive |
| **Kenyan tech community** (iHub, Nairobi Startup News, Techweez, Techmoran, dev.to) | Blog posts + Twitter/X threads | Engineering-forward, code-in-the-post OK, opinion + hot take welcome | Weekly |
| **Pastoralist communities** | Community radio (Iftin FM, Radio Iman), community leaders, WhatsApp groups | Kiswahili, elder-first respectful, no jargon | Monthly + event-driven |
| **County government** (Isiolo County Government, NDMA) | Formal brief PDFs, in-person meetings, MoU packets | Deferential, policy-aligned, KPI-forward | Quarterly + upon request |
| **Academic** (ILRI, IGAD-ICPAC, universities) | Journal articles, conference talks (Africa Tech Summit, AI4G Africa) | Rigorous, method-forward, dataset-forward | 2 conference talks / year |
| **Insurance + agri-fintech** | Executive one-pagers, data-sample demos | Value-per-policy quantified, integration path clear | Ad hoc partnership outreach |

---

## §3 — Story drafts (ready-to-write outlines)

Not full articles — the Mass Comm teammate writes the actual
prose. These are the beats, evidence, and call-to-action per piece
so drafting is fast.

### Draft 1 — "Why we chose SMS over apps for Isiolo pastoralists"

**Target channel:** Medium + dev.to + LinkedIn cross-post
**Word count target:** 900–1200
**Audience:** tech + development

**Structure:**
1. **Hook** — a photo you've probably seen: a herder holding a
   Nokia-era feature phone. That phone is why we chose SMS.
2. **The straw-man solution:** "just build an app". Show why it
   fails: smartphone penetration, data-cost, literacy layer.
3. **The right question:** what infrastructure already reaches
   every Isiolo phone? SMS + USSD. Africa's Talking runs the
   aggregation layer for us.
4. **What that constraint forces:** ≤160 char messages, no images,
   no charts, no forms — every design decision downstream flows
   from this.
5. **What we get back:** universality. The system doesn't have a
   "download" step. The herder texts a shortcode and it works.
6. **What we sacrifice:** rich UI. We're forced to compress a
   drought brief into 158 characters of Kiswahili.
7. **The engineering pay-off:** language-first design produces
   better content on *every* channel, including future WhatsApp.
8. **Call to action:** if you're building for the same herder,
   we'd love to share notes. Repo link.

**Proof to weave in:**
- Screenshot of live SMS reply (test persona; label as such)
- One-liner about AT's sandbox economics (KES 0.80/msg)
- Link to `progress-2026-07-13-technical.md`

### Draft 2 — "How a 2012 borehole survey becomes today's ground truth"

**Target channel:** dev.to (engineering) + LinkedIn (development)
**Word count target:** 800–1000
**Audience:** AI + drought / climate space

**Structure:**
1. **Hook** — the number: **10.** That's how many rows exist in
   WPDx for Isiolo. All 10 marked "Non-Functional" since 2012.
2. **The naive read:** WPDx is broken, ignore it.
3. **The right read:** WPDx is a *starting point*. The gap between
   2012 and today IS the pilot's opportunity.
4. **The mechanic:** any herder can report "the borehole is
   working now" via voice or SMS. That report goes into
   `ground_truth_calls`. A helper (`overlayStatusFromGroundTruth`)
   turns those reports into a live status map that overrides WPDx.
5. **The flywheel:** the next herder to text `BULA` hears the
   *herder-verified* status, not the 2012 status.
6. **Why this scales:** each verified report improves the value
   of every subsequent call in the same ward for 90 days. Value
   grows super-linearly with cohort size.
7. **Call to action:** if you're building a "wisdom of crowds"
   layer on top of stale open data, we'd love to compare notes.

**Proof to weave in:**
- `wpdx.ts::interpretHerderStatus` — the free-text parser
- Mermaid diagram (sequence) showing the overlay in action
- Screenshot of a test herder's brief with the overlay

### Draft 3 — "The three data pipes behind a Kiswahili drought SMS"

**Target channel:** dev.to (engineering)
**Word count target:** 1200–1500
**Audience:** engineers curious about the architecture

**Structure:**
1. **Hook** — quote a real (test) SMS from the system. Break it
   apart phrase by phrase.
2. **Phrase 1 — "malisho ni ya kadri"** — where does this
   severity word come from? Trace to `severityFromCtx()`,
   which reads `vciDerived`, which comes from
   `computeVci(current_ndvi, historical_baseline)`, which reads
   `satellite_indices` (Sentinel-2 monthly composite).
3. **Phrase 2 — "mvua ni ndogo sana mwezi huu"** — where does the
   rain framing come from? Trace to `wardRainfall30dMm` from
   `weather_data`, and note the upcoming 14-day forecast overlay
   from `weather_forecast`.
4. **Phrase 3 — "bwawa la Burat ilikuwa mbovu"** — where does the
   water point come from? Trace to WPDx snapshot +
   ground-truth overlay.
5. **Phrase 4 — "Habari Mohamed, ArdaLink hapa"** — where does
   personalisation come from? Trace to Supabase
   `api_call_context` view.
6. **The pipe count:** 4 external providers + 1 in-house overlay,
   composed into 158 chars of natural Kiswahili.
7. **Call to action:** every one of these is open-source or
   free-tier. The repo shows how.

**Proof to weave in:**
- Full system component diagram (from `system-diagrams.md`)
- Actual code snippets from `herderContext.ts`

### Draft 4 — "What it costs to reach 1 500 pastoralists"

**Target channel:** LinkedIn (funders + partners) + Substack
**Word count target:** 700–900
**Audience:** funders, would-be county partners

**Structure:**
1. **Hook** — the number: **$150/month.** That's the pre-launch
   estimate for keeping ArdaLink reaching a 1 500-pastoralist
   cohort with daily SMS drills.
2. **Break it down:** SMS ~$120, cloud ~$30. Everything else is
   free-tier.
3. **The infrastructure story:** we lean hard on free-tier
   providers (Supabase, GEE, Open-Meteo, WPDx). Each is a
   deliberate choice.
4. **The transition to sustainability:** at scale, one county
   government subscription ($200+/mo) covers full opex. Additional
   revenue funds cohort expansion, insurance data pipes, cross-
   county rollout.
5. **What we're NOT doing:** monetising the herder. Value must
   stay free at the point of use. The herder is our user, not
   our customer.
6. **Call to action:** if you're a county drought desk, an
   NDMA-adjacent partner, or an insurance underwriter, we'd love
   to talk about the data-sharing MOU.

**Proof to weave in:**
- Cost math from `business-model-canvas.md §9`
- Chart of scaling economics (needs designer)

### Draft 5 — "Building for the pilot we haven't launched yet"

**Target channel:** ArdaLink blog + LinkedIn (development sector)
**Word count target:** 800–1000
**Audience:** funders + fellow builders

**Structure:**
1. **Hook** — an honest confession: no real herders use ArdaLink
   yet. Every persona in our test data is synthetic.
2. **Why that's on purpose:** launching without the operational
   safety net (verified pastoralists, ops-vetted content, opt-out
   flow) puts the very people we care about at risk. Better slow
   and right than fast and harmful.
3. **What we've built pre-launch:** the entire pipeline, tested
   end-to-end, ready for the day the first field-agent
   introduction happens.
4. **The pilot readiness checklist:** what has to be true before
   the first real pastoralist gets an ArdaLink SMS (voice
   channel, field-agent SOP, MoU with the county).
5. **The invitation:** if you fund pre-launch work, if you're an
   Isiolo cooperative, if you're a field-agent organisation with
   pastoralist relationships, get in touch.

---

## §4 — Content calendar (rolling, 4-week view)

Each row is one deliverable owned by one person. Adjust cadence to
what's actually feasible; don't overpromise.

| Week | Deliverable | Owner | Channel | Status |
|---|---|---|---|---|
| **W28** (this week) | Publish `project-profile.md` as a webpage | Comms | ArdaLink site / Medium | Ready to draft |
| W28 | LinkedIn post: system readiness milestone (technical presentation happens Mon) | Comms | LinkedIn (personal + JHUB) | Post-huddle |
| W28 | Twitter/X thread: system-diagrams walkthrough | Comms + Dev | Twitter/X | Wed |
| W28 | Design brief for 5 visual assets (see §5) | Comms → Designer | — | Thu |
| **W29** | Publish story 1 — "Why we chose SMS over apps" | Comms | Medium + dev.to | Mon |
| W29 | Weekly progress micro-update (250 chars) | Comms | Twitter/X | Wed |
| W29 | Government briefing packet draft | Comms + Team lead | PDF, ready for meeting | Fri |
| **W30** | Publish story 2 — "How a 2012 borehole survey becomes today's ground truth" | Comms | Medium + dev.to | Mon |
| W30 | First public webinar / demo (recorded) | Team | YouTube + LinkedIn | Wed |
| W30 | Update project profile with any new milestones | Comms | site | Fri |
| **W31** | Publish story 3 — "The three data pipes behind a Kiswahili drought SMS" | Comms | dev.to | Mon |
| W31 | Newsletter #1 (partner-facing) | Comms | Substack | Wed |

---

## §5 — Visual asset plan

**Priority order — top of list = do first.**

| # | Asset | Purpose | Format | Notes |
|---|---|---|---|---|
| 1 | **ArdaLink logo** | Repo README, socials, presentation slides | SVG + 512×512 PNG | Simple, mark-driven, works in single colour |
| 2 | **System architecture diagram (visual polish)** | LinkedIn + blog embeds | 1600×900 PNG | Same content as `system-diagrams.md §1` but designed for social sharing |
| 3 | **Herder-facing SMS mockup** | LinkedIn + Medium + pitch decks | Phone screen mockup, 1080×1080 | Show a real (test) SMS in a phone frame; Kiswahili + English side by side |
| 4 | **USSD flow visual** | Blog post about the Jisajili flow | Screen recording GIF or 4-panel PNG | Show what a herder sees on their phone at each of the 4 subscribe screens |
| 5 | **Data-pipe diagram — "one SMS, four data pipes"** | Draft 3 blog post | 1600×900 PNG | Visual of the same content as story draft #3 |
| 6 | Impact-per-KES card | Draft 4 blog post + funder pitches | 1080×1080 social card | Simple: "KES 0.80 per herder-facing decision. KES 40 000 lost per adult cow." |
| 7 | Team headshots + one-liners | Project profile page | 800×800 per person | Everyone in the team + advisors + comms lead |
| 8 | Ward map (Isiolo) with the 5 canonical wards highlighted | Project profile + partner brief | 1200×900 PNG | Same as dashboard WardMap but styled for print |
| 9 | Video: 60-second explainer | LinkedIn, YouTube shorts | Vertical 1080×1920, subtitled Kiswahili + English | Post-launch content |
| 10 | Video: 5-minute demo walkthrough (screen recording) | Investor + partner meetings | Horizontal 1920×1080 | Use `progress-2026-07-13-technical.md §2` as script |

---

## §6 — Social copy library

Ready-to-schedule, thread-ready. Rewrite in the Mass Comm
teammate's voice. The pre-launch qualifier `[pilot pre-launch]`
appears where relevant; drop it once the real cohort starts.

### LinkedIn — long-form post (system readiness milestone)

> This week we shipped Phase A of ArdaLink — the last piece of the
> drought-intelligence pipeline before we open enrollment to
> Isiolo pastoralists.
>
> The system now:
> - Pulls fresh Sentinel-2 NDVI + 14-day rainfall forecast for
>   every ward, every 6 hours
> - Blends satellite anomaly signals with herder-reported ground
>   truth so the answer stays honest as water points fix, break,
>   move
> - Speaks Kiswahili and English natively — the herder picks their
>   language once, the system remembers
> - Reaches any 2G phone via SMS, USSD, and voice; no app to
>   download, no data plan needed
> - Closes every loop with an outbound SMS so nobody dials in and
>   walks away wondering if anything worked
>
> Every claim above is grounded in code and passing tests — 259
> of them — and every metric points at a Supabase table.
>
> Next up: Africa's Talking is provisioning us a live voice number
> so we can dial a herder directly with a personalised drought
> brief in their language. When that lands, we start the field-
> agent onboarding for the first real cohort.
>
> If you're building for East African smallholder or pastoralist
> audiences, or if you're at a county / NGO working on drought
> early warning in ASAL Kenya, we'd love to compare notes. Repo
> in the comments.

### Twitter/X — engineering thread (10 posts)

1. We just shipped the last bit of Phase A of ArdaLink — a drought
   early-warning system for Isiolo pastoralists that reaches any
   2G phone in Kiswahili. Here's what's under the hood 🧵

2. It starts with Sentinel-2. Every month, every one of the 5
   Isiolo Sub-County wards gets a fresh NDVI snapshot pushed to
   Supabase. 11 years of historical baseline. We compute VCI
   (Vegetation Condition Index) per ward per month.

3. That VCI number is meaningless to a herder. So we translate:
   VCI ≤ 25 → "malisho ni mabaya sana mwezi huu" (grass is very
   poor this month). We compose one sentence, not a metric.

4. Every 6 hours we hit Open-Meteo per ward centroid and persist
   14 days of daily rainfall forecast — p5 / p50 / p95 rain
   probability, temp, evapotranspiration. 70 rows per pass, 5
   wards.

5. Water points come from WPDx open data. Isiolo has 10 rows, all
   from a 2012 survey, all marked "Non-Functional". Useless on its
   own. BUT: any herder can update the status via voice/SMS.

6. When a herder texts `MALISHO`, we blend WPDx with fresh
   herder-reported status via `overlayStatusFromGroundTruth()`.
   The next herder to check hears the current status, not the
   2012 status. WPDx becomes wrong; the herder becomes source of
   truth.

7. Voice pipeline: opener → DTMF menu → 20s record → ffmpeg
   transcode to 16kHz mono WAV → Azure Speech STT (sequential
   sw-KE then en-KE) → GPT-5-mini extracts BCS/mortality/water
   status → ground_truth_calls row → summary SMS.

8. Every AT surface writes to lead_interactions. Ops dashboard
   tails it in real time — 30s poll shows every USSD dial + SMS
   keyword + voice stage with tier + ward + keyword filters.

9. Nothing runs on infrastructure that costs more than $50/month
   at pilot scale. Supabase, GEE, Open-Meteo — all free tier.
   Azure Speech + OpenAI + Africa's Talking are the real bills,
   and they scale linearly with call volume.

10. Pilot launches once Africa's Talking activates our voice Test
    Number + we've onboarded the first field-verified cohort.
    Repo: github.com/JHUB-AFRICA/arda-link-ai — issues + PRs
    welcome from anyone building for the same herder.

### Twitter/X — micro-updates (single tweets)

> Just shipped: every AT SMS callback type (delivery report, opt-
> out, subscription notification) has a handler + auto-logs to our
> lead_interactions audit table. Ops dashboard sees every event
> within 30s. #buildinpublic

> If you build for Isiolo pastoralists, WPDx is a decade stale and
> that's a feature. Every herder who tells us "the borehole is
> working" makes the next herder's brief more accurate. Ground
> truth beats bureaucratic truth. #datajournalism #agri

> Kiswahili detail matters. We say "malisho ni ya kadri" (pasture
> is fair), not "VCI 63/100". Herders don't need our metric — they
> need our judgement, in words that mean something to them.

### LinkedIn — funder-facing post

> $150/month.
>
> That's the estimated cost of reaching 1 500 Isiolo pastoralists
> with daily drought-intelligence SMS via ArdaLink. Cloud + LLM
> + STT/TTS included.
>
> One county government subscription (~$200/mo) covers full opex
> at that scale — with room for cohort growth, cross-county rollout,
> and eventual insurance-data-feed partnerships.
>
> We're pre-launch. The system is built and tested against
> synthetic personas; real pastoralist enrollment starts once
> Africa's Talking activates our voice Test Number.
>
> If you fund pre-launch operational infrastructure for climate-
> adaptation projects, or if you're a county-government drought
> desk, or an ASAL-region NGO — get in touch.
>
> Repo: github.com/JHUB-AFRICA/arda-link-ai

---

## §7 — Things NOT to say (guardrails)

- ❌ "Herders use ArdaLink to…" (they don't — pre-launch)
- ❌ Specific claims about drought loss avoided
- ❌ "AI-powered" without context (jargony, tells the reader nothing)
- ❌ "Revolutionary" / "disrupting" / "world-first" (undermines trust)
- ❌ Numbers we didn't measure or don't have a source for
- ❌ Any pastoralist quote we can't attribute (or that we made up)
- ❌ "The perfect solution" — everything is trade-offs; that's what
  makes the design interesting

Every content deliverable gets a quick pass against this list
before it goes out.

---

## §8 — Editorial checklist (per piece)

Before publishing anything, verify:

- [ ] Grounded in something the code actually does (or explicitly
  labelled as future / planned)
- [ ] Pre-launch state honoured (no false-user claims)
- [ ] Kiswahili phrasing checked with a native speaker on the team
  or advisor (for any Kiswahili content that isn't a direct
  quote from the pipeline)
- [ ] Repo linked
- [ ] Project profile linked for the non-technical reader
- [ ] No `Co-Authored-By: Claude` trailer if produced with AI tooling
- [ ] Comms lead + team lead have seen it before it publishes
