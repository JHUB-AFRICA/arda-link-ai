# ArdaLink — Communications Vault

**Status:** Pre-launch pilot. Every claim below is grounded in what
the system does *today* (with test personas). Any language that
could be read as "real herders using ArdaLink" is explicitly framed
as "test personas exercising the pipeline pre-launch".

This vault contains what the audit reviewer asks for:
- Non-technical readable **project profile** so a partner or funder
  understands ArdaLink's real-world value in under 3 minutes
- **Content playbook** — editorial calendar, story drafts, social
  copy library, visual asset plan
- **Pitch library** — 30-second / 2-minute / 5-minute versions +
  FAQ

The Mass Comm teammate presents from these materials at the huddle.
Nothing here needs their name — everything is drop-in scaffolding
they own and iterate on.

---

## Index

| File | Purpose | Audience |
|---|---|---|
| [`project-profile.md`](./project-profile.md) | Non-technical one-pager. What ArdaLink is, who it helps, why now. | Partners, funders, visiting stakeholders |
| [`content-playbook.md`](./content-playbook.md) | Editorial calendar, story drafts, social copy, visual asset plan. | Comms lead, designer, whoever handles the socials |
| [`pitch-library.md`](./pitch-library.md) | 30s / 2min / 5min pitches + FAQ. | Anyone talking about ArdaLink to a non-technical audience |
| [`README.md`](./README.md) | This file. Index + comms slot script for the huddle. | Presenter |

---

## Comms slot for the huddle (~15 minutes)

Structure the Mass Comm slot around three questions the audit
brief calls out:

### 1. What are we saying? (5 min)

Open with the project profile in one sentence:

> *ArdaLink puts drought intelligence into the hands of Isiolo
> pastoralists — in the language they speak, on the phones they
> already have, without asking for anything they don't already
> know.*

Then walk one of the story angles from `content-playbook.md §3`:
- **"The satellite that speaks Kiswahili"** — technology-in-service-
  of-culture. Best for tech + development audiences.
- **"Pastoralists teaching AI"** — the ground-truth flywheel. Best
  for AI / policy audiences.
- **"The drought will happen; the loss doesn't have to"** — impact
  framing. Best for funders + insurance partners.

Pick one angle for tomorrow. The other two stay in the playbook for
later channels.

### 2. Who are we saying it to? (5 min)

Show the audience map from `content-playbook.md §2`. Six segments,
each with a channel + a message register:

1. **Development sector** (UNDP, USAID, GIZ) → LinkedIn thought
   leadership, evidence-heavy
2. **Kenyan tech community** (iHub, Techweez, Techmoran) → Twitter
   threads, engineering blog posts
3. **Pastoralist communities** → Radio (Iftin FM, Radio Iman),
   community leaders, WhatsApp groups
4. **Government** (Isiolo County Government, NDMA) → Formal briefs,
   in-person meetings, MoU packets
5. **Academic** (ILRI, IGAD-ICPAC, universities) → Journal papers,
   conference talks
6. **Insurance + agri-fintech** → Executive summaries, data-sample
   demos

### 3. What are we shipping this week? (5 min)

Walk the content calendar from `content-playbook.md §4`. Tomorrow
(Monday) → Friday goals:

- **Mon** — Publish project profile as a public webpage
  (draft in this vault; polish + publish)
- **Tue** — First blog post: *"Why we chose SMS over apps"* (angle:
  accessibility-first design)
- **Wed** — LinkedIn thread: technology stack story
- **Thu** — Design brief handed to visual designer (assets listed
  in `content-playbook.md §5`)
- **Fri** — Twitter/X thread: the ground-truth flywheel

---

## Handoff notes

**For the Mass Comm teammate:**

- Everything in this vault is a *starting point*, not a script.
  Rewrite in your own voice, sharpen the angles, cut what doesn't
  land for the specific audience.
- Never claim numbers we haven't measured. Pre-launch means we
  don't have pastoralist outcomes yet — the story is about the
  *system* we've built to enable those outcomes.
- Use the pitch library variants as a base but rehearse them until
  they sound like you, not like a doc.
- When you write about the team, list actual names and roles —
  none of that is in these drafts.
- Publish channels + posting cadence are for you to pick — the
  playbook is a menu, not a mandate.

**For anyone else reviewing the vault:**

- Files link to code paths + Supabase tables where the claim maps to
  something concrete. That's how we keep the marketing story and the
  engineering story in sync.
- If a marketing claim ever contradicts what the code does, the
  code wins — file a comms revision, don't paper over it.
- Two engineering rules apply to comms content too: (1) never write
  to pilot-data tables from anywhere outside the ops-verified path
  ("two-tier writes" — verified vs lead never confuses which table
  gets what); (2) every action ends with an outbound SMS the caller
  can opt out of ("no open loops"). Nothing goes out via a channel
  the caller can't stop.

---

## Post-presentation compliance checklist

Before dropping the Notion link in the group chat, verify:

- [ ] `project-profile.md` reads cleanly in under 3 minutes
- [ ] `content-playbook.md` has at least 3 story drafts + 5
  social posts + 5 visual assets identified
- [ ] `pitch-library.md` has 30s / 2min / 5min variants
- [ ] The Notion workspace links to this repo's `Arda-link-AI-Docs/`
  folder so all the technical + BMC docs are one click away
- [ ] Permissions on the Notion page allow the JHUB team to read
  (edit permissions optional)
