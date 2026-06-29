# Tuesday Walkthrough — what you will see on the screen

**Duration**: 2 hours. **Audience**: team + stakeholders.
**Presenter**: Denis Munene Ndegwa (Lead Software Engineer).
**You do not need to be technical to follow this.** Everything you see is
described below in plain language.

---

## Before we start (5 minutes)

We open a terminal and run **one command**:

```
bash hardening/scripts/start-local.sh
```

This brings up the whole platform on this machine:
- a database
- the "engine" (the part that processes satellite data)
- the "API" (the part that handles calls and ground-truth)
- the "web" (the dashboard and the Talk app)

It also seeds three "tenants" with realistic data so we are not looking at
empty screens. The whole thing takes about 90 seconds. If anything goes
wrong, the script tells us which step.

Then we run:

```
bash hardening/scripts/verify.sh
```

This is a 15-point health check. It confirms:
- All four services are responding
- The database is up and the migrations are applied
- Three tenants are seeded
- Authentication is enforced (a protected route refuses anonymous traffic)
- A valid JWT identifies the right tenant
- The three test suites pass

The verify script prints a single green "READY" line at the end. If it ever
prints "NOT READY", we stop and fix.

---

## The demo (45 minutes)

### Part 1 — the dashboard, one tenant (10 min)

We open `http://localhost:8080/` in a browser. We see:

- The operator dashboard, with a left panel of drought-stress alerts
- A live "drought status" tile at the top (NDVI, baseline comparison)
- A ward map with a grid overlay (Bula Pesa, our pilot ward)
- A "ground-truth" feed showing the most recent herder reports

We click into the **Bula Pesa Ward** view. This shows:

- 5 pastoralists in the directory
- 12 ground-truth reports from the last 30 days
- The most recent herder report from Hassan Abdi, with a body condition
  score of 2.4 (stress territory)
- A low NDVI value (0.18–0.24) compared to the 11-year baseline

**Plain language**: "Bula Pesa is in trouble. The satellite agrees with the
herders. We can see it on one screen, in real time."

### Part 2 — the multi-tenant boundary (15 min)

This is the part of the demo that matters most for the pilot expansion. We
log out and log in again as the **Garbatulla** operator. The same dashboard
shows:

- Different pastoralists (Yusuf Omar, Ibrahim Noor — Garbatulla, not Bula Pesa)
- Different reports (BCS 2.9–3.5, much milder stress)
- A different NDVI trend (0.32–0.37, near baseline)

We then log in as the **Merti** operator:

- 5 pastoralists, mostly camels (different ward)
- Reports show BCS 3.8, NDVI 0.42, no stress
- The "voice_outbound" feature flag is **off** for Merti — the
  "Place a call" button is hidden in the UI

**Plain language**: "Each operator sees only their own ward. The platform
enforces this at three layers — the login, the API, and the database. A
herder from Bula Pesa cannot accidentally show up in Garbatulla's reports."

### Part 3 — a live voice call (15 min)

We have the demo terminal in one window and the dashboard in another.

The lead engineer triggers a drought-check pipeline for Bula Pesa. The pipeline:

1. Reads the most recent Sentinel-2 satellite data
2. Compares it to the 11-year baseline
3. Sees that NDVI is **28% below baseline**
4. Composes a voice script in Swahili: "Habari yako, kuhusu maji na
   mifugo yako…"
5. (In production) Places a call to Hassan Abdi's phone via Africa's Talking

In the demo environment we won't place a real call (no Africa's Talking
sandbox configured). Instead, we show the composed script, the
question it would ask, and the dashboard tile that says "Call would
have fired at 09:12:34 EAT."

**Plain language**: "This is the part that turns satellite silence into a
herder's voice. The whole loop, from data to a conversation, is one
HTTP call."

### Part 4 — questions (15 min)

Open floor. Likely questions and the prepared answers:

- "What does it cost?" — see `ardalink-api/docs/06-COSTS.md`. Pilot: $131/month.
- "What if the satellite is wrong?" — every call ends with a herder
  ground-truth report, so the model self-corrects. The dashboard
  flags low trust-score reports.
- "What about privacy?" — see `ardalink-api/docs/04-SECURITY.md`.
  Tenant-scoped data, RLS on every table, no cross-tenant leak paths.
- "What about scaling beyond Isiolo?" — see `ardalink-api/docs/05-OBSERVABILITY.md`
  and the multi-tenant design. The same code runs against 1 ward or 50.
- "What's the timeline to production?" — see `ardalink-api/docs/00-EXECUTIVE-INDEX.md`,
  90-day roadmap. Pilot kicks off this quarter.

---

## After the demo (10 min)

- Capture action items in a single doc
- Confirm who owns what by next Tuesday
- Schedule the next verification (post-pilot data ingestion)

---

## If something breaks during the demo

- All services log to `/tmp/ardalink-local/*.log`
- `bash hardening/scripts/verify.sh` is the authoritative health check
- `bash hardening/scripts/stop-local.sh` cleanly stops everything
- `bash hardening/scripts/start-local.sh` restarts cleanly (idempotent)
- The lead engineer has SSH + terminal access; can pivot to terminal-only demo
  if the browser fails