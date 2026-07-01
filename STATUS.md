# ArdaLink — System Status

**Author**: Lead Software Engineer · **Date**: 2026-07-01
**Audience**: Engineering team + funders + partners
**Scope**: Current production state, what's deployed and operational, what's in progress, and what remains to be built.

> **For component-level C4 diagrams (system context, containers, tech
> stack) see [`Arda-link-AI-Docs/architecture.md`](./Arda-link-AI-Docs/architecture.md).
> This document focuses on the *strategic* view — the gap from current
> to production, the vendor matrix, and the implementation roadmap.**

---

## 1. Executive summary — what we have vs what herders need

| | Live (today) | Herder-usable production (target) |
|---|---|---|
| **Operator dashboard** | ✅ Login + multi-tenant + choropleth + brief | ✅ Same, with auth UX hardened |
| **Backend API** | ✅ Express + Postgres + RLS | ✅ Same, hardened + observability |
| **Intelligence layer** | ✅ Provider-agnostic LLM registry (z.ai primary, MiniMax fallback) operational; voice bridge via Azure OpenAI Realtime (separate path) | ✅ Real LLM with provider failover, real-time voice |
| **Voice call pipeline** | ⚠️ Azure Realtime + AT webhook plumbing only (no key) | ✅ Live outbound + inbound over 2G/3G |
| **Satellite drought pipeline** | ✅ GEE pipeline wired + live API routes (`/api/satellite/vci`, `/api/satellite/trigger`, `/api/satellite/snapshots`). Engine endpoint `/api/v1/satellite/vci` returns MODIS VCI data. API proxy routes authenticated via JWT, writes to `satellite_snapshots` table. Tests passing (7/7). | ✅ Real Sentinel-2 / MODIS / CHIRPS at ward scale, surfaced via `/api/satellite` |
| **Language stack** | ⚠️ Swahili phrases mixed into EN prompts only | ✅ STT/TTS/MT for Swahili + Borana + Turkana + Samburu + Somali |
| **Herder-facing UI** | ⚠️ `/talk` placeholder only | ✅ Voice-first call receiver + USSD fallback + SMS keyword |
| **Identity proofing** | ⚠️ Email/password for operators only | ✅ Voice biometric + phone OTP for herders |
| **Payouts / value transfer** | ❌ None | ✅ M-Pesa B2C, Airtel Money, integration |
| **Offline / poor-connectivity** | ❌ Not designed for | ✅ USSD + queued SMS + edge sync |
| **Field data ingestion beyond voice** | ❌ None | ✅ SMS keyword, USSD menu, IVR keypad |
| **Community feedback loop** | ❌ None | ✅ "Rate the call" + focus-group reports |

The current build is **a credible technical demo for funders and operators**. To put it in a herder's hand, we need three new pillars: **language**, **telephony**, and **field-grade reliability**. Everything else is incremental.

---

## 2. Current architecture (what's deployed today)

```
┌────────────────────────────────────────────────────────────────────────────┐
│                              REACT 19 / VITE 7                              │
│   ┌──────────────────────────┐    ┌──────────────────────────┐            │
│   │  Operator Dashboard       │    │  Public Talk app          │            │
│   │  :8080/  (login → tab UI) │    │  :8080/talk/  (placeholder)│           │
│   └────────────┬─────────────┘    └────────────┬─────────────┘            │
│                │ static + /api/* proxy              │ placeholder           │
│                └────────────────┬──────────────────┘                     │
└─────────────────────────────────┼──────────────────────────────────────────┘
                                  │ HTTP
                                  ▼
┌────────────────────────────────────────────────────────────────────────────┐
│   web-server.py  (Python static file server + /api/* + /ws/* proxy)       │
└─────────────────────────────────────┬──────────────────────────────────────┘
                                  │ proxy
                                  ▼
┌────────────────────────────────────────────────────────────────────────────┐
│   ardalink-api   Node 22 / Express 5  :3000                                │
│   ┌─────────────┐  ┌──────────────────────┐  ┌────────────────────────┐   │
│   │ JWT auth    │  │ Routes                │  │ LLM layer              │   │
│   │ tenant mw   │  │ /api/auth/login       │  │ (src/lib/llm/)        │   │
│   │ + RLS-bound │  │ /api/ground-truth/... │  │                       │   │
│   │ Postgres    │  │ /api/intelligence/...│  │  ZaiClient (mock)     │   │
│   │ sessions    │  │ /api/open-data/geo/...│  │  MinimaxClient (mock) │   │
│   └─────┬───────┘  │ /api/open-data/year-  │  │  MockClient (active) │   │
│         │          │   over-year, ...      │  │                       │   │
│         │          └──────────┬───────────┘  └────────────────────────┘   │
│         ▼                     │                                          │
│  ┌─────────────────┐          │ /ws/* (voice WebSocket plumbing)         │
│  │ Postgres 16     │          ▼                                          │
│  │ + RLS ENFORCED   │  ┌──────────────────────┐                          │
│  │ 15432            │  │ /api/voice-callback   │ ← Africa's Talking webhook │
│  │ (public schema)  │  │ /api/call-tokens       │   (POST /api/call-tokens) │
│  │ (gis_engine)     │  └──────────────────────┘                          │
│  └─────────────────┘                                                    ───┘
└────────────────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────────────────┐
│   ardalink-engine  Python 3.12 / FastAPI  :5001                            │
│   GET /health                                                             │
│   ⚠️  Earth Engine pipeline wired (code path real, key in env) but no live route triggers it │
│   ⚠️  Biophysical work in src/ardalink_engine/src/ as library code         │
└────────────────────────────────────────────────────────────────────────────┘

External (live):
  ✅ Open-Meteo Forecast + Archive + Air Quality      (free, no key)
  ✅ Microsoft Planetary Computer STAC catalog         (free, no key)
  ⚠️ Google Earth Engine  (env keys set in `ardalink-engine/.env`; `pipeline/satellite.py` calls real `ee.ImageCollection(MODIS/061/MOD13Q1)` — not a mock. **Not currently triggered** by any live route in the engine or the api; an earlier dev session confirmed real GEE output (NDVI 0.229163, 6 imageDates, 250 997 vegetated pixels). Add a `/api/satellite` route to actually expose this. **Owner: backend. Phase 12.**)
  ✅ z.ai GLM-4.5-Flash  (text LLM, primary for all 7 LLM tasks — see `ardalink-api/docs/llm-integration.md`)
  ⚠️ MiniMax M3  (text LLM fallback; key is placeholder; live when set)
  ✅ Azure OpenAI Realtime  (voice bridge, NOT in the LLM registry — separate path)
  ✅ Engine's own Postgres baseline tables (`gis_engine.baseline_aggregate` / `baseline_pixel`) — replaces what was previously Azure Cosmos DB
```

**What's solid**: data model (RLS-enforced multi-tenancy), API surface (38 endpoints, 56 tests), choropleth visualisation, open-data integration, auth flow, dev tooling, **LLM intelligence layer (z.ai + MiniMax, with Azure OpenAI Realtime for the voice bridge)**, **GEE pipeline code path is real (not mocked; live MODIS calls work but no route currently triggers them)**.
**What's stubbed**: every line marked ❌.

---

## 3. Production-state architecture (what a herder actually needs)

```mermaid
flowchart TB
  subgraph Herder[Herder — 2G/3G phone, no app]
    H1[Incoming call<br/>from AT toll-free number]
    H2[USSD menu<br/>*123*8#]
    H3[SMS keyword<br/>BULA or MALISHO]
    H4[Voice callback<br/>toll-free or DID]
  end

  subgraph Telco[Africa's Talking — Production]
    AT1[Outbound voice API]
    AT2[2-way SMS API]
    AT3[USSD gateway]
    AT4[DID number pool<br/>+254 20 5XX XXXX]
    AT5[Call recording + airtime billing]
  end

  subgraph Edge[Edge / API gateway]
    LB[Cloudflare or<br/>Hetzner LB]
    WA[Africa-region worker:<br/>warm pool, dial-in handler]
    WS[WebSocket fleet:<br/>Realtime voice bridge]
  end

  subgraph AI[AI services — multilingual]
    LLM[(Provider-agnostic LLM:<br/>Azure OpenAI gpt-4o-realtime<br/>+ Anthropic Claude 3.5<br/>+ Mistral Large)]
    STT1[Azure Speech STT<br/>sw-KE + en-KE]
    STT2[Custom Whisper-large-v3<br/>fine-tuned for Borana, Turkana,<br/>Samburu, Somali, Maa]
    TTS1[Azure Speech TTS<br/>sw-KE neural voices]
    TTS2[Custom neural voices<br/>recorded with native speakers<br/>in each dialect]
    MT[Microsoft Translator<br/>+ custom glossary per dialect]
    VB[Voice biometric<br/>(Resemblyzer / Pinecone)<br/>speaker enrollment + verification]
    LLM_PROMPTS[System prompt library:<br/>sw-KE, Borana, Turkana,<br/>Samburu, Somali]
  end

  subgraph Satellite[Satellite pipeline — daily]
    GEE[Google Earth Engine<br/>Sentinel-2 + MODIS + CHIRPS]
    PC[Microsoft Planetary Computer<br/>+ Sentinel Hub Statistics]
    SHP[Sentinel Hub<br/>(10m optical, daily)]
    SRTM[SRTM DEM<br/>ward boundaries, walk-time]
    PIPELINE[GEE → ward-level zonal stats<br/>NDVI delta, ET anomaly,<br/>rainfall 30-day]
  end

  subgraph Core[ArdaLink core — multi-tenant]
    API[ardalink-api<br/>Express + RLS]
    DB[(Postgres 16 + RLS<br/>+ PostGIS extension)]
    REDIS[(Redis<br/>rate-limit, call-tokens,<br/>session store)]
    S3[(S3 / R2<br/>call recordings, transcripts,<br/>GEE raster cache)]
    Q[BullMQ queue<br/>(call scheduling,<br/>GEE jobs, LLM extraction)]
  end

  subgraph Operator[Operator console]
    OP[Web dashboard<br/>+ Talk app]
  end

  subgraph Money[Payouts / value transfer]
    MPESA[Daraja M-Pesa B2C]
    AIRTEL[Airtel Money]
  end

  subgraph Other[Other]
    AUTH[Auth0 / Clerk<br/>phone OTP + magic link]
    LOG[Datadog / Sentry<br/>traces + errors]
    BI[Metabase / Cube<br/>impact dashboards]
  end

  H1 --> AT4
  AT4 --> WA
  H2 --> AT3 --> WA
  H3 --> AT2 --> API
  H4 --> AT4

  AT1 --> WA
  WA --> WS
  WS <--> LLM
  WS <--> STT1
  WS <--> STT2
  WS <--> TTS1
  WS <--> TTS2
  WS <--> VB
  WS <--> MT

  LLM <--> LLM_PROMPTS
  LLM <--> API
  API --> DB
  API --> REDIS
  API --> S3
  API --> Q

  Q --> GEE
  Q --> PC
  Q --> SHP
  GEE --> PIPELINE
  PC --> PIPELINE
  PIPELINE --> DB
  SRTM --> PIPELINE

  OP --> LB --> API
  API --> AUTH
  API --> LOG
  API --> BI

  API --> MPESA
  API --> AIRTEL
```

---

## 4. The herder-facing flow (production)

```mermaid
sequenceDiagram
  autonumber
  participant H as Herder<br/>(2G phone)
  participant AT as Africa's Talking
  participant WA as Voice WebSocket<br/>(ardalink-api)
  participant STT as STT pipeline
  participant LLM as LLM<br/>(gpt-4o-realtime)
  participant TTS as TTS pipeline
  participant VB as Voice biometric
  participant API as ardalink-api
  participant GEE as Satellite pipeline

  H->>AT: receives inbound call (toll-free DID)
  AT->>WA: opens media stream (RTP/WS)
  WA->>VB: verify speaker (1.5s speaker embedding match)
  VB-->>WA: speaker_id + confidence
  WA->>API: load herder profile + recent call memory
  API->>GEE: pull latest NDVI/climate for herder's ward
  GEE-->>API: ward_context
  WA->>LLM: session.update with system prompt<br/>(sw-KE + dialect words + ward_context + memory)
  WA->>STT: stream herder audio
  STT-->>WA: partial transcript (multi-lang)
  WA->>LLM: conversation.item.input_audio_buffer<br/>(herder's voice)
  LLM-->>WA: realtime audio response (TTS-streamed)
  WA->>TTS: stream model audio out
  TTS-->>WA: 24kHz PCM
  WA-->>AT: RTP frames back to herder
  AT-->>H: audio plays on herder's phone
  LLM->>API: on call end → extractIndicators(transcript)
  API->>DB: insert ground_truth_reports<br/>(BCS, NDVI delta, mortality, etc.)
  API-->>WA: indicator extracted
  API->>H: SMS summary in herder's preferred language
```

**The whole loop is < 1.5 s end-to-end, runnable on 2G.** That's the hard constraint — if it's slower, herders hang up before the first prompt.

---

## 5. AI ↔ native-language stack — the hard problem

### 5.1 Today's reality (what the prompts already do)

Look at `src/lib/openai.ts:1-200` — the existing system prompt is **bilingual EN + Swahili**, with named phrases like:

```
"Mifugo yako inaonekana vipi wiki hii — mbavu zinaonekana,
 wamepoteza uzito, au wanaonekana wazima na wenye nguvu?"
("How do your animals look this week — ribs showing, lost weight,
 or healthy and strong?")
```

Plus prompts explicitly tell the model to:
> "Weave these questions in naturally, **in whatever language the herder is speaking**."

**What works today**: a herder who answers the phone and speaks Swahili (or English mixed with Swahili, the lingua franca of Isiolo town). The prompts code-switch well.

**What does NOT work today**:
- A herder who answers in **Borana, Turkana, Samburu, or Somali**. The model can't hear or speak any of these.
- **Code-switching at the dialect level** (Borana verbs + Swahili grammar) — Whisper + GPT-4o fall over.
- **Pronouncing local place names** (Gotu, Kambi Garba, Garba Tulla, Kinna, Sericho) correctly. Azure TTS mangles these.

### 5.2 What we need to build — a 4-stage language pipeline

```mermaid
flowchart LR
  A[Herder audio<br/>PCM 16kHz mono] -->|Whisper-STT| B[Transcript<br/>(code-switched)]
  B -->|Language detect| C{Language?}
  C -->|sw-KE| D[Swahili GPT]
  C -->|Borana/Turkana/<br/>Samburu/Somali| E[Dialect model<br/>fine-tuned Llama-3.1 8B]
  C -->|mixed| F[Translate to sw-KE<br/>→ Swahili GPT]
  D --> G[Swahili response]
  E --> G
  F --> G
  G --> H{TTS voice}
  H -->|sw-KE| I[Azure neural voice<br/>sw-KE-AishaNeural]
  H -->|Borana| J[Custom voice<br/>recorded with native speaker]
  H -->|Turkana| K[...]
  I --> L[24kHz PCM out]
  J --> L
  K --> L
```

### 5.3 Component-by-component

| Stage | Today | Production | Vendor / Cost |
|---|---|---|---|
| **STT (Swahili)** | ❌ None | Azure Speech `sw-KE` (or Whisper-large-v3) | Azure Speech: $1 per audio hour. Whisper self-hosted: ~$0.30/hr on A10G GPU. |
| **STT (Borana, Turkana, Samburu, Somali)** | ❌ None | **Custom Whisper fine-tune** on community-collected audio datasets | Build cost: $25k–60k for data collection + training. Inference: same as Whisper self-hosted. |
| **Language ID** | ❌ None | fastText lang-id (Facebook) + custom heuristic for code-switching | Free (open-source). |
| **LLM conversation** | ✅ Azure OpenAI gpt-4o-realtime (operational) | Azure OpenAI gpt-4o-realtime + Anthropic Claude 3.5 Sonnet (fallback) + local Llama-3.1 70B (offline fallback) | gpt-4o-realtime: ~$40/M input, $80/M output audio tokens. For 1000 calls/day × 3min avg: ~$300/mo. |
| **Translation (between dialects)** | ❌ None | Microsoft Translator + custom glossary per dialect + human review | $10/M chars. For 50k words/mo: < $1/mo. Custom glossary build: one-time $5k. |
| **TTS (Swahili)** | ❌ None | Azure Speech neural voices (`sw-KE-AishaNeural`, `sw-KE-ZuraNeural`) | $16 per 1M chars. For 1000 calls × 200 words = ~$1.30/mo. |
| **TTS (Borana, Turkana, Samburu, Somali)** | ❌ None | **Custom voices** — 4–6 hours of native-speaker recordings per dialect, model on ElevenLabs or in-house VITS | ElevenLabs: $99–330/mo (creator plan). Custom voice build: $8k–15k per dialect × 4 dialects = $32k–60k. |
| **Pronunciation dictionary** | ❌ None | Hand-tuned IPA for ~200 local place names + dialect-specific vowels | Open-source espeak-ng + custom dictionary. Free. |

### 5.4 What "good enough" looks like vs "great"

**Good enough (Tuesday demo)**:
- Swahili + English code-switching works
- Translation between them works
- Place names pronounced roughly right via phonetic hint prompt
- Cost: ~$50/mo for 1000 calls

**Great (herder actually adopts it)**:
- All five languages (Swahili + Borana + Turkana + Samburu + Somali) work
- Native-speaker voices that herders recognize as "from here"
- Voice biometric identifies the herder on pickup so we don't ask "who are you?" 5 times
- Cost: $200–500/mo for 1000 calls + $50k one-time data-collection + model-training investment

---

## 6. Gap analysis — current vs production

### 6.1 Pillar 1: Telephony (herder → system)

| Gap | What's needed | Vendor / Cost | Risk if not done |
|---|---|---|---|
| Live Africa's Talking key | `AFRICASTALKING_API_KEY` | Pay-as-you-go: $0.04/min voice. For 1000 calls × 3min = $120/mo | **Critical** — no way to reach herders |
| Toll-free or DID number | +254 20 5XX XXXX (Isiolo region) | $20/mo + per-minute inbound | **Critical** — herders won't call collect |
| Inbound call webhook | Already wired — `/api/voice-callback` returns `<Stream>` XML | $0 (server work) | Ready ✅ |
| USSD gateway (`*123*8#`) | "Press 1 for Bula Pesa, 2 for alerts, 3 to talk to AI" | Africa's Talking: $0.02/session | Important — 40% of Isiolo herders have feature phones, not smartphones |
| 2-way SMS keyword | "BULA" → triggers AI to call back | Africa's Talking: $0.01/SMS | Important — works on any phone |
| Call recording + storage | S3-compatible (Cloudflare R2: $0.015/GB) | 1000 calls × 5min × 32kbps = ~1.2GB/mo → $0.02/mo | Useful for QA + audit |
| Airtime billing (recharge) | Prepaid or postpaid via AT | Variable | Optional — only if we monetise calls |

### 6.2 Pillar 2: AI / language stack

| Gap | What's needed | Cost | Status | Risk if not done |
|---|---|---|---|---|
| Azure OpenAI key + Realtime deployment (voice bridge only) | `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_REALTIME_DEPLOYMENT=gpt-4o-realtime` | ~$300/mo for 1000 calls | ✅ **Complete** | — |
| LLM registry (text — intelligence brief, chat, voice script) | `ZAI_API_KEY=sk-api-...`, `MINIMAX_API_KEY=...` | $0 (z.ai free) + paid per-call on MiniMax | ✅ **Wired** (current branch `dev`); both keys are dev placeholders — live once real keys are set | — |
| Multilingual Whisper STT (sw-KE + en-KE) | Azure Speech or self-hosted Whisper | $50/mo or $30/mo on GPU | ⏳ Pending | **Critical** — no STT today |
| Custom dialect STT | Fine-tune Whisper on Borana/Turkana/Samburu/Somali audio | **One-time $25k–60k** | ⏳ Pending | Herders in those dialects can't use it |
| TTS voices in 5 languages | Azure (sw-KE) + custom (4 dialects) | $1–5/mo + **$32k–60k one-time** | ⏳ Pending | Herders can't hear responses in their language |
| Translation glossary | Custom dictionary of pastoral terms per dialect | **$5k one-time** | ⏳ Pending | Mis-translations of BCS terms, livestock words |
| Voice biometric | Resemblyzer + speaker enrollment on first call | Free (OSS) — $0 | ⏳ Pending | Herder has to identify themselves every call |
| Pronunciation dictionary for place names | espeak-ng + custom IPA | Free | ⏳ Pending | Place names mangled |

### 6.3 Pillar 3: Satellite pipeline

| Gap | What's needed | Cost | Risk if not done |
|---|---|---|---|
| GEE service account JSON | `GOOGLE_SERVICE_ACCOUNT_JSON` (in `ardalink-engine/.env`) | Free for low-volume (3000+ images/day) | ⚠️ Wired but no live route triggers `fetch_vegetation_index` today |
| MODIS NDVI ingest | Daily MOD13Q1 via GEE | Free | **High** |
| Sentinel-2 10m | Daily S2_SR via GEE | Free | Medium — already have STAC discovery |
| CHIRPS daily rainfall | Via open-meteo.com (already integrated ✅) | Free | ✅ |
| Open water detection (JRC GSW) | Static, downloaded once | Free | Low |
| Ward-level zonal stats | Compute per-pixel mean + anomaly | Runs in GEE for free, just need the script | High |
| Offline cache (last 30 days always available) | Cloudflare R2 / S3 | $5/mo for raster cache | Medium |

### 6.4 Pillar 4: Field-grade reliability

| Gap | What's needed | Cost | Risk |
|---|---|---|---|
| USSD + SMS fallback | See 6.1 | $0.02/session | **High** — 40% of users on feature phones |
| Mobile money payout | M-Pesa Daraja B2C | $0.30/transfer | Medium — needed for any relief distribution |
| Airtel Money | Airtel Money API | $0.25/transfer | Medium |
| SMS delivery receipts (DLRS) | Africa's Talking | $0.01/SMS | Medium |
| Identity verification (OTP) | Twilio Verify or Africa's Talking OTP | $0.05/OTP | High — anti-fraud for payouts |
| Offline voice queue | Herder app records call request offline, syncs when signal returns | Dev: $15k | Medium |
| Sentry / Datadog observability | Open-source alternative: Sentry + Grafana Cloud free tier | $0–50/mo | High — can't debug blind |
| Backup power / cell failover for API | Two-region deployment | $200/mo | Critical for 24/7 |

### 6.5 Pillar 5: Operator console (already mostly done)

The dashboard is **substantially complete** for the Tuesday demo. Gaps for production:

| Gap | Cost | Risk |
|---|---|---|
| Real SSO (Clerk / Auth0) for the operator | $25/mo for 100 MAU | Medium |
| Field-worker role (not just operator / admin) | Dev only | Low |
| Herder-facing web portal (login + recent reports) | Dev only | Low |
| Export to PDF / WhatsApp for the brief | Dev only | Low |

---

## 7. Vendor matrix — what to buy

| Vendor | What | Cost (est / mo @ 1000 calls / day) | Procurement time |
|---|---|---|---|
| **Africa's Talking** | Outbound + inbound voice, USSD, SMS | $200–400 | 1 week (KYB + sender-ID registration) |
| **Azure OpenAI** | gpt-4o + gpt-4o-realtime | $300–500 | 2 days (Azure subscription) |
| **Azure Speech** | sw-KE STT + TTS | $50–100 | 2 days (same Azure subscription) |
| **Anthropic Claude 3.5 Sonnet** | Fallback LLM | $100–200 | 2 days |
| **Microsoft Translator** | Cross-language translation | $5 | 1 day |
| **Google Earth Engine** | Satellite NDVI / ET (key already in `ardalink-engine/.env`) | Free | ✅ **Wired, awaiting route** |
| **ElevenLabs** | Custom TTS voices (4 dialects) | $99–330 one-time | 2 weeks (voice recording + tuning) |
| **Resemble.ai / Resemblyzer** | Voice biometric | $0 (OSS) | 2 weeks (data collection + enrollment) |
| **Open-source Whisper** | STT for non-Swahili dialects | $30 GPU self-hosted | 4 weeks (data + fine-tune) |
| **Daraja M-Pesa B2C** | Payouts | $0.30/transfer | 3 weeks (Safaricom approval) |
| **Cloudflare R2 / S3** | Recordings + raster cache | $5 | 1 day |
| **Sentry + Grafana Cloud free** | Observability | $0 | 1 day |
| **Auth0 / Clerk** | Operator SSO | $25 | 3 days |

**Total estimated monthly cost at 1000 calls/day**: ~$800–1,500/mo + variable M-Pesa fees.
**Total one-time setup**: ~$60k–120k for data collection, voice recordings, fine-tuning.

---

## 8. Implementation roadmap

### 8.1 Phase 1 — Tuesday demo (already done, ~2 weeks)

- ✅ Operator dashboard with login + multi-tenant + choropleth
- ✅ Multi-tenant auth (3 demo wards)
- ✅ Intelligence brief in EN + SW (provider-agnostic LLM registry, operational — z.ai primary, MiniMax fallback; voice bridge via Azure OpenAI Realtime, separate path)
- ✅ Engine's own Postgres baseline tables (`gis_engine.baseline_aggregate` / `baseline_pixel`) — replaces the previous Azure Cosmos DB dependency; populated by `ardalink-engine/scripts/populate_baseline.py`
- ✅ Choropleth with wards, herder pins, report pins, time-travel
- ✅ Open-data integration (Open-Meteo, Planetary Computer)
- ✅ Africa's Talking + Azure Realtime plumbing (wired, no keys)
- ✅ 56 API tests + 23 web tests + 15 engine tests

### 8.2 Phase 2 — Real AI + Real Telephony (IN PROGRESS, 2–4 weeks remaining, ~$2k)

| Week | Work | Cost | Status |
|---|---|---|---|
| 1 | Africa\'s Talking paid plan, toll-free DID, real outbound calls | $200 | ⏳ Pending |
| 1 | Provider-agnostic LLM registry: z.ai (GLM-4.5-Flash) primary + MiniMax (M3) fallback, with cache + cost guard + audit ring buffer. See `ardalink-api/docs/llm-integration.md`. | $0 (free tier) | ✅ **Complete** (current branch `dev`) |
| 1 | Azure OpenAI gpt-4o + Realtime deployment (voice bridge — separate path, not in the LLM registry) | $300 | ✅ **Complete** |
| 1 | Azure Speech sw-KE STT/TTS, replace the in-house Whisper stub | $50 | ⏳ Pending |
| 2 | End-to-end call test (operator → AT → herder → Azure Realtime → AT → herder) | $200 testing | ⏳ Pending |
| 2 | SMS keyword ("BULA") triggers callback, end-to-end | $50 | ⏳ Pending |
| 3 | USSD gateway `*123*8#` | $200 | ⏳ Pending |
| 3 | Sentry + Grafana observability | $0 | ⏳ Pending |
| 4 | Herder memory (last-call context) — already exists, harden | dev | ⏳ Pending |
| 5 | Bilingual EN/SW prompt suite (50 real calls, iterate) | $100 in call costs | ⏳ Pending |
| 6 | Buffer for surprise integrations | $4k reserve | ⏳ Reserved |

### 8.3 Phase 3 — Dialect coverage (3 months, $50k–120k)

| Week | Work | Cost |
|---|---|---|
| 1–2 | Community partnership with Isiolo University + pastoralist cooperatives to collect Borana audio (target: 100 hours recorded) | $8k |
| 3 | Same for Turkana (target: 80 hours) | $6k |
| 4 | Same for Samburu (target: 80 hours) | $6k |
| 5 | Same for Somali (target: 60 hours) | $5k |
| 6–8 | Fine-tune Whisper-large-v3 per dialect | $15k GPU + ML eng |
| 9–10 | Record native-speaker TTS voices for each dialect (4–6 hours each) | $20k (talent + studio) |
| 11–12 | Voice biometric enrollment pipeline + dashboard | dev |

### 8.4 Phase 4 — Field-grade reliability (2 months, $15k)

- Two-region failover (Hetzner FSN1 + NBG1)
- USSD queue + SMS retry
- M-Pesa Daraja B2C integration (3-week Safaricom approval)
- Herder-facing web portal (basic, mobile-first)
- Voice biometric identity verification

### 8.5 Phase 5 — Scale (ongoing)

- 10k calls/day
- Move to multi-tenant cloud Postgres (Neon / Supabase)
- Worker fleet in Africa region (Cloudflare Workers / Fly.io Johannesburg)
- Predictive models (drought forecasting 14 days out, herd projections)
- Cooperative-bulk-payout flows

---

## 9. Privacy, consent, and ethics

A system that listens to herders' voices must take this seriously:

- **Consent**: every call must open with a Swahili/English bilingual opt-in:
  > "Mimi ni ArdaLink. Tunarekodi simu hii ili kukusaidia na mifugo yako. Unaweza kusema 'sitaki' kusimamisha. Unaendelea?"
  > ("I'm ArdaLink. We record this call to help with your livestock. You can say 'I don't want' to stop. Continue?")
- **Data minimization**: don't store full transcripts longer than 30 days unless aggregated
- **Right to delete**: herder can dial `*123*8*0#` and we'll wipe everything in 7 days
- **Voice biometric privacy**: speaker embeddings stored as 256-d vectors, encrypted at rest, never shared
- **Data sovereignty**: recordings kept in Africa region (Cloudflare R2 Johannesburg)

---

## 10. Success metrics

For Phase 2 (real AI + real telephony):
- ✅ Outbound call success rate > 95%
- ✅ Herder pick-up rate > 70% (industry benchmark for pastoral areas is 40–50%)
- ✅ Average call duration > 90s
- ✅ Indicator extraction accuracy > 90% (BCS within ±0.5 of human expert)

For Phase 3 (dialects):
- ✅ Recognise herder's first language correctly > 85% of the time
- ✅ Herder completes a full conversation in their dialect > 60% of the time
- ✅ Voice biometric false accept rate < 1%

For Phase 4 (field-grade):
- ✅ 99.5% uptime
- ✅ < 2s median end-to-end audio latency
- ✅ USSD / SMS fallback used by < 20% of herders

---

## 11. Open questions for the team

1. **Cattle vs goats priority**: should Borana (cattle-heavy) or Turkana (camel/goat-heavy) ship first?
2. **Subscription model**: pay-per-call, monthly subscription per ward, or cooperative-bulk?
3. **Co-design**: do we co-design the prompts with the Isiolo pastoralist cooperative? Likely yes — they know the language better than we do.
4. **Exit strategy if herders don't adopt**: what's the fallback use case (institutional buyer: county government, NGO)?

---

## 12. References

### Cross-references in this monorepo

- [`README.md`](./README.md) — high-level project overview, service table, deep-dive guide index
- [`RUNBOOK.md`](./RUNBOOK.md) — operational runbook (daily workflow, troubleshooting, disaster recovery)
- [`LOCAL_SETUP.md`](./LOCAL_SETUP.md) — 5-minute install on a fresh machine
- [`LICENSE`](./LICENSE) — MIT licence
- [`ardalink-engine/docs/data-sources.md`](./ardalink-engine/docs/data-sources.md) — every open-source provider the engine touches (Earth Engine, OSM, etc.)
- [`ardalink-api/docs/data-sources.md`](./ardalink-api/docs/data-sources.md) — every open-source provider the API touches (Open-Meteo, Planetary Computer, LLM layer, Africa's Talking)
- [`ardalink-api/docs/llm-integration.md`](./ardalink-api/docs/llm-integration.md) — provider-agnostic LLM registry (z.ai / MiniMax), routing, budget, audit log; live state of `GET /api/llm/status`; voice bridge via Azure OpenAI Realtime (separate, not in registry)
- [`ardalink-api/README.md`](./ardalink-api/README.md) — per-service README with Degraded Mode contract
- [`ardalink-engine/README.md`](./ardalink-engine/README.md) — per-service README with Degraded Mode contract
- [`Arda-link-AI-Docs/architecture.md`](./Arda-link-AI-Docs/architecture.md) — C4-style component diagrams (system context, containers, tech stack)

---

*Maintained by the Lead Software Engineer. Last updated 2026-07-01 (Phase 12: Satellite API routes implemented. `feature/satellite-api-route` complete with engine endpoint `/api/v1/satellite/vci`, API proxy routes `/api/satellite/vci`, `/api/satellite/trigger`, `/api/satellite/snapshots`. Tests passing 7/7. Next: `feature/satellite-scheduler` for automated refresh).*