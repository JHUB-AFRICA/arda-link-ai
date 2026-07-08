# ArdaLink — System Status

**Author**: Lead Software Engineer · **Date**: 2026-07-07
**Audience**: Engineering team + funders + partners
**Scope**: Current production state, what's deployed and operational, what's in progress, and what remains to be built.

> **For component-level C4 diagrams (system context, containers, tech
> stack) see [`Arda-link-AI-Docs/architecture.md`](./Arda-link-AI-Docs/architecture.md).
> This document focuses on the *strategic* view — the gap from current
> to production, the vendor matrix, and the implementation roadmap.**

> **Tenant vs. ward terminology**: Bulla Pesa, Garbatulla, and Merti are the
> three demo *operator tenants*. The satellite VCI demo iterates over three
> *wards* — Bulla Pesa, Garbatulla, and Kinna — because `merti` is a Sub-County
> (its operator's home ward is Sericho). We keep both distinctions because
> both are real: `merti` is a real tenant slug, `kinna` is a real ward.

---

## 1. Executive summary — what we have vs what herders need

| | Live (today) | Herder-usable production (target) |
|---|---|---|
| **Operator dashboard** | ✅ Login + multi-tenant + choropleth + brief | ✅ Same, with auth UX hardened |
| **Backend API** | ✅ Express + Postgres + RLS | ✅ Same, hardened + observability |
| **Intelligence layer** | ✅ Provider-agnostic LLM registry with **Azure AI Foundry (GPT-5 Mini) as primary**, z.ai as fallback, MiniMax as secondary fallback. Verified: `/api/intelligence/brief` returns real Swahili brief from `provider: azure, model: gpt-5-mini` (~6s, 787 tokens). Voice bridge via Azure OpenAI Realtime (`gpt-4o-realtime-preview` deployment). | ✅ Real LLM with provider failover, real-time voice |
| **Voice call pipeline** | ✅ **Two modes, chosen by `CALL_PIPELINE_MODE` env (default `deterministic`)**. Deterministic: value-first opener → DTMF category menu → 20 s AT `<Record>` → Azure Fast Transcription (with auto-fallback to short-audio REST for regions like `southafricanorth` that don't host Fast yet) → GPT-5 Mini indicator extraction → `ground_truth_reports` row per call. Robust on 2G, guaranteed data capture, no Realtime deployment needed. Realtime (optional): Azure OpenAI Realtime WS bridge for full-duplex conversation on `/api/voice-stream` (AT mulaw) and `/api/browser-voice-stream` (PCM16 24 kHz). Kept for the operator/demo path and as the future upgrade once herder connections and Realtime pricing improve. `voiceStream.ts` has TTS fallback via Azure Speech if Realtime WS fails to open — caller hears the pre-generated Swahili script instead of silence. | ✅ Live outbound + inbound over 2G/3G |
| **Satellite drought pipeline** | ✅ **Supabase primary** (ward-level `satellite_indices`, `weather_data`, `api_latest_satellite_indices` / `api_latest_weather_data` views; 1,082 satellite rows + 20 weather rows + 2.24M cell rows for 5 active wards, PostGIS 3.4). Local `satellite_snapshots` retained as per-call cache. GEE pipeline still wired (`/api/satellite/vci`, `/trigger`, `/snapshots`) — engine `/api/v1/satellite/vci` returns MODIS VCI for Bulla Pesa, Garbatulla, Kinna. Tests 14/14. | ✅ Real Sentinel-2 / MODIS / CHIRPS at ward scale, surfaced via `/api/satellite` |
| **Reference data layer** | ✅ **Supabase source of truth** (2026-07-08). `wards` (5 active + 5 dormant), `ward_neighbors` (28), `ward_cells` (26,975), `pastoralists` (upsert-on-first-call), `ground_truth_calls` (thin, dual-written from local rich `ground_truth_reports`). PostgREST client `src/lib/supabase.ts` with 60 s cache; ward-id mapping `src/lib/wardMapping.ts` (Bula Pesa → 242). Local Postgres remains a backup mirror; falls back cleanly when Supabase env unset. Verified 2026-07-08 (Mohamed Ali `+254712000004` upsert + NDVI 0.25272 + 2 real dual-written calls). | ✅ Same, with per-tenant secret rotation |
| **Cross-service tenancy (engine ↔ api)** | ✅ HMAC-SHA256 attestation wired: api's `engine.ts` signs `X-Tenant-ID` with `TENANT_ATTESTATION_SECRET`; engine's `TenantAttestationMiddleware` verifies + calls `set_tenant()` so Postgres RLS on `gis_engine.*` enforces isolation. Dev mode (secret unset) passes through. | ✅ Same, with the secret rotated per environment |
| **Language stack** | ✅ **Azure Speech (STT/TTS) wired end-to-end**, region `southafricanorth`. Neural voices `sw-KE-ZuriNeural`, `en-KE-AsiliaNeural`. Endpoints: `GET /api/speech/status`, `GET /api/speech/token` (browser SDK), `POST /api/speech/tts`, `GET /api/speech/brief.mp3?lang=sw` (Swahili audio brief for callbacks). Borana/Turkana/Samburu/Somali still upstream-only. | ✅ STT/TTS/MT for Swahili + Borana + Turkana + Samburu + Somali |
| **Herder-facing UI** | ✅ **All three channel simulators are now deterministic and herder-personalized**. `/api/demo/voice/simulator` = phone-lookup → localized TTS opener → DTMF category → 20 s recording → Speech + GPT-5 Mini extract → ground truth. `/api/demo/ussd/simulator` = fixed menu screens (no LLM in-loop) that pull ward satellite numbers + the herder's location/last-BCS from `pastoralists` + `ground_truth_reports`. `/api/demo/sms/simulator` = fixed keyword responses (BULA, MALISHO, ONGEA, RIPOTI, STOP) with the same personalization. Realtime WS demo kept at `/simulator-realtime` as a Phase-3 preview. Turn-based sim retained at `/simulator-legacy`. `/talk` React app also live. | ✅ Voice-first call receiver + USSD fallback + SMS keyword |
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
- ✅ Intelligence brief in EN + SW (provider-agnostic LLM registry, operational — **Azure AI Foundry GPT-5 Mini primary**, z.ai fallback, MiniMax secondary fallback; voice bridge via Azure OpenAI Realtime `gpt-4o-realtime-preview`, separate path)
- ✅ Engine's own Postgres baseline tables (`gis_engine.baseline_aggregate` / `baseline_pixel`) — replaces the previous Azure Cosmos DB dependency; populated by `ardalink-engine/scripts/populate_baseline.py`
- ✅ Choropleth with wards, herder pins, report pins, time-travel
- ✅ Open-data integration (Open-Meteo, Planetary Computer)
- ✅ Africa's Talking + Azure Realtime plumbing (wired, no keys)
- ✅ 56 API tests + 23 web tests + 15 engine tests

### 8.2 Phase 2 — Real AI + Real Telephony (IN PROGRESS, 2–4 weeks remaining, ~$2k)

| Week | Work | Cost | Status |
|---|---|---|---|
| 1 | Africa\'s Talking paid plan, toll-free DID, real outbound calls | $200 | ⏳ Pending |
| 1 | Provider-agnostic LLM registry: z.ai (GLM-4.5-Flash) + MiniMax (M3), with cache + cost guard + audit ring buffer. See `ardalink-api/docs/llm-integration.md`. | $0 (free tier) | ✅ **Complete** |
| 1 | **Azure AI Foundry (GPT-5 Mini) added as primary LLM provider** — new `providers/azure.ts`, wired into registry, handles GPT-5 quirks (`max_completion_tokens`, `reasoning_effort: minimal`, no `temperature`). Verified 2026-07-06. | ~$0 (usage-based) | ✅ **Complete** |
| 1 | **Deterministic voice pipeline (herder production path)** — `src/lib/voiceDeterministicPipeline.ts` + dual-mode `routes/voice.ts`. AT `<Record>` → Azure Fast Transcription (region-aware fallback) → GPT-5 Mini extract → RLS-scoped `ground_truth_reports` insert. `CALL_PIPELINE_MODE=deterministic` default. Verified 2026-07-07 end-to-end (row #39: BCS=2, species=goats, mortality=1-3). | dev | ✅ **Complete** |
| 1 | **Supabase reference data plane (source of truth)** — `src/lib/supabase.ts` PostgREST client + `src/lib/wardMapping.ts` + Supabase-first `src/lib/herderContext.ts` + `writeSupabaseMirror()` in `voiceDeterministicPipeline.ts` and `routes/talk.ts`. Dual-write: rich `ground_truth_reports` local + thin `ground_truth_calls` on Supabase; pastoralist upsert on first call. Wards/satellite/weather/views populated. Local Postgres kept as fallback mirror. Verified 2026-07-08 (NDVI 0.25272, temp 29.5°C, rain 2.5 mm for ward 242; Mohamed Ali `+254712000004` upsert; 2 dual-written calls). | ~$0 (Supabase free tier for pilot volume) | ✅ **Complete** |
| 1 | Azure OpenAI Realtime deployment (`gpt-4o-realtime-preview`, voice bridge — kept as demo + future upgrade path) | $300 | ✅ **Complete** |
| 1 | **Azure Speech `sw-KE-ZuriNeural` + `en-KE-AsiliaNeural` STT/TTS** — `src/lib/speech.ts` + `routes/speech.ts`. Endpoints: `/api/speech/status`, `/api/speech/token`, `/api/speech/tts`, `/api/speech/brief.mp3`. `fastTranscribe()` auto-falls back to short-audio REST when Fast Transcription isn't offered in the resource's region (e.g. `southafricanorth`). Verified 2026-07-06 (26 KB MP3 in 2.5 s). | $50 | ✅ **Complete** |
| 2 | End-to-end call test (operator → AT → herder → Azure Realtime → AT → herder) | $200 testing | ⏳ Pending |
| 2 | SMS keyword handler (`/api/sms`) — landed 2026-07-05, awaiting live AT key | $50 | ✅ **Wired**, ⏳ needs live key |
| 3 | USSD gateway handler (`/api/ussd`) — landed 2026-07-05, awaiting short-code registration | $200 | ✅ **Wired**, ⏳ needs short-code |
| 3 | Engine ↔ api tenant attestation + Postgres RLS on `gis_engine.*` — landed 2026-07-05 | dev | ✅ **Complete** |
| 3 | Sentry + Grafana observability | $0 | ⏳ Pending |
| 4 | Herder memory (last-call context) — already exists, harden | dev | ⏳ Pending |
| 5 | Bilingual EN/SW prompt suite (50 real calls, iterate) | $100 in call costs | ⏳ Pending |
| 6 | Buffer for surprise integrations | $4k reserve | ⏳ Reserved |

### 8.2b Phase 2b — Fork alignment + Supabase depth (planned 2026-07-08, ~2 weeks)

**Reference**: MUNENE1212/ardalink-ai fork is treated as the canonical
architecture. The gaps below are what separates our current merge
(`4a8509c`) from the fork's design.

**Ordering** — 0 → 1 → 2, one branch per phase, PRs against `dev`.

#### Phase 0 — Correctness blockers (½ day, blocks nothing else)
| # | Gap | Fix | Owner |
|---|---|---|---|
| 0.1 | `sbFetch` 8 s timeout blocks USSD's ~10 s budget | Two envs: `SUPABASE_TIMEOUT_INTERACTIVE_MS=2500`, `SUPABASE_TIMEOUT_BATCH_MS=8000`. Helper takes `mode: 'interactive'|'batch'`. | Backend |
| 0.2 | Ward model mismatch: `garbatulla` + `merti` default to ward 242 (silent bug) | **Retire both** as tenants. Adopt the fork's 5 Isiolo Sub-County wards as canonical tenants: `wabera` (241), `bula-pesa` (242), `ngare-mara` (245), `burat` (246), `oldonyiro` (247). Reseed local DB. Update `admin_users`, seed data, operator login. Purge from `wardMapping.ts` TODOs. | Backend + dashboard |
| 0.3 | Supabase view 500s (`api_ward_cell_latest_rollup`, `api_latest_cell_satellite_indices`) | Not our bug — flag to Supabase project owner. Meanwhile our client skips them silently. | Supabase owner |
| 0.4 | `mortality_rate`/`offtake_rate`/`trust_score` normalisation is guesswork ([0,1] proportions chosen only to pass CHECK) | Confirm semantics with Supabase project owner. Either change to categorical text columns, or document the real interpretation. | Supabase owner |

#### Phase 1 — Test coverage (1–2 days, blocks nothing but stops regressions)
| # | Target file | Coverage goal |
|---|---|---|
| 1.1 | `src/lib/wardMapping.ts`, `src/lib/pastoralistContact.ts` | Table-driven mapping + no-op on `browser-*` phones |
| 1.2 | `src/lib/supabase.ts` | Cache TTL, non-2xx → null, interactive vs batch timeout, upsert idempotency |
| 1.3 | `src/lib/herderContext.ts` | Supabase-first, local-fallback, merge (name from Supabase + species from local), unknown-phone default |
| 1.4 | `src/lib/voiceDeterministicPipeline.ts` — **priority** | Happy path, region-unsupported fallback, Supabase-down fallback, upsert idempotency, value normalisation |
| 1.5 | `src/lib/speech.ts` fastTranscribe | 400 region-unsupported → short-audio fallback; both fail → null |

#### Phase 2 — Fork feature parity + Supabase depth (3–5 days)
| # | Fork feature we're missing | Our fix |
|---|---|---|
| 2.1 | Fork's `LOCATION_TO_WARD` alias mapping (case-insensitive location → ward_id) | New `wardMapping.ts::wardIdFromLocationText(text)` — used by USSD "where are you?" and voice pipeline extraction to attach a ward_id even when the herder isn't in `pastoralists` yet |
| 2.2 | Fork's ward_neighbors consumption for cross-ward advice | Extend `buildLocalizedVoiceOpener` and the USSD brief: "in your neighbor Wabera, NDVI is higher — consider moving that way" |
| 2.3 | Dashboard consumes Supabase (fork's assumption) | New route `/api/ground-truth/supabase` merges Supabase `ground_truth_calls` with local rich rows; `GroundTruthSection.tsx` renders both with source badge (supabase / local / both) |
| 2.4 | Ward map (Supabase's PostGIS geometry) | New `/api/wards/geometry` returns wards GeoJSON + ward_cells summary + adjacency. Dashboard adds a small choropleth coloured by ward-level NDVI |
| 2.5 | Fork's `voiceFunctionTools.ts` (LLM function calling for realtime) | Import + wire into the (still-optional) realtime path so operators using the demo get the same tools the fork uses |
| 2.6 | Fork's per-ward WPDx water points (`bulaPesaWaterPointsWpdx.ts` already exists locally, unused) | Wire into deterministic voice USSD water-point list; today's list is hard-coded 5 entries |

**Deferred to later** (Phase 3+): Redis-backed rate limits/cache, Supabase Auth for `admin_users`, `ward_cells` per-pixel queries, bidirectional sync worker, SMS `STOP` → pastoralist `alertsEnabled=false` propagation.

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

*Maintained by the Lead Software Engineer. Last updated 2026-07-05.*
*Landed this cycle*:
* Satellite API routes + scheduler (`feature/satellite-api-route`, `feature/satellite-scheduler`).
* Engine ↔ api tenant attestation (HMAC-SHA256 over `TENANT_ATTESTATION_SECRET`) and full Postgres RLS enforcement on `gis_engine.baseline_aggregate`, `gis_engine.baseline_pixel` via `set_tenant()`.
* SMS + USSD route stubs (`/api/sms`, `/api/ussd`) waiting on live Africa's Talking credentials.
* Ward/tenant terminology alignment: Bulla Pesa, Garbatulla, Merti are the three tenants; Bulla Pesa, Garbatulla, Kinna are the three demo wards. Doc drift fixed across README, RUNBOOK, LOCAL_SETUP, and API/UI copy.

*Next*: live Africa's Talking key + short-code registration; Sentry / Grafana observability wiring.