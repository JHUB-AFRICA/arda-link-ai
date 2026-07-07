# ArdaLink × Africa's Talking — Sandbox Workflow

End-to-end test of the call, USSD, and SMS flows using the AT sandbox.

This document covers **how to validate the full AT integration in the
local sandbox without ngrok, a real AT account, or live telephony**. It
also documents the production-time webhook contract so the live deploy
is just a URL swap.

---

## TL;DR — 30-second smoke

```bash
make up                                    # boots Postgres + Redis + api + engine + web
node scripts/sandbox-simulate.mjs all      # drives USSD + SMS + voice webhooks
```

Expected: every step prints `200 OK` with the right reply shape. If any
step shows `401` or `5xx`, something is mis-wired — see [Troubleshooting](#troubleshooting).

---

## Architecture in one diagram

```
                       Africa's Talking sandbox
                       (no real tunnel needed)
                                │
                ┌───────────────┼───────────────┐
                ▼               ▼               ▼
        /api/voice-callback  /api/voice-events  /api/ussd-callback  /api/sms-callback
                │               │               │               │
                ▼               ▼               ▼               ▼
           <Stream> XML     {ok:true}       text/plain       text/plain
           to AT's WS       (audit only)    "CON ..." /      "Bula Pesa leo:
                                              "END ..."        ..."
                │
                ▼
        /api/voice-stream (WS)  ────►  Azure OpenAI Realtime
                                          │
                                          ▼
                                   mulaw audio frames
                                   relayed back to AT → herder's phone
```

---

## The four webhook endpoints

All four are in `PUBLIC_PATHS` in `src/middlewares/tenant.ts` because AT
cannot sign JWTs. They return 200 fast and the actual business logic
runs in workers/queues.

### 1. `POST /api/voice-callback`

AT calls this when an outbound call **connects** to the herder's phone.
We respond with `<Response><Stream url="wss://…"/></Response>` which
tells AT to open a WebSocket to our media endpoint.

Payload AT sends (form-encoded):
| Field | Example | Notes |
|---|---|---|
| `sessionId` | `AT-voice-…` | AT-internal id; used for logging |
| `direction` | `outbound` | `outbound` for our calls; `inbound` if a herder dials our DID |
| `callerNumber` | `+254711082200` | Our outbound caller ID |
| `destinationNumber` | `+254700000000` | The herder's phone |

Our response:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Stream url="wss://YOUR-HOST/api/voice-stream?phone=PHONE"/>
</Response>
```

The WebSocket at `/api/voice-stream` is bridged to Azure OpenAI Realtime
by `src/lib/voiceStream.ts`. AT sends `mulaw` audio frames, we forward
them to Azure, and Azure's `mulaw` audio response frames go straight
back to AT without any transcoding.

### 2. `POST /api/voice-events`

AT calls this for every call lifecycle event (`queued`, `ringing`,
`answered`, `completed`, `failed`, `busy`). We log and ACK 200.

Payload AT sends:
| Field | Example |
|---|---|
| `sessionId` | `AT-voice-…` |
| `callSessionState` | `completed` |
| `callerNumber` | `+254711082200` |
| `destinationNumber` | `+254700000000` |
| `durationInSeconds` | `182` |
| `hangupCause` | `NORMAL_CLEARING` |
| `amount` | `4.20` |
| `currencyCode` | `KES` |

Response: `200 { "ok": true }`.

### 3. `POST /api/ussd-callback`

AT calls this on every USSD keystroke. Response is **plain text** —
must start with `CON` (continue) or `END` (terminate).

Payload AT sends:
| Field | Example |
|---|---|
| `sessionId` | `AT-ussd-…` |
| `serviceCode` | `*123*8#` |
| `phoneNumber` | `+254711082200` |
| `text` | `1*2` (accumulated input, `*`-separated) |

USSD menu (`*123*8#`):

```
CON ArdaLink — Bula Pesa
1. Bula Pesa (drought brief)
2. Malisho (water points)
3. Ongea na AI (voice call)
4. Toka
```

* `1` → brief sub-menu → `1` (Swahili) / `2` (English) / `0` (back)
* `2` → top-5 nearest water points (END)
* `3` → "Sasa/Now" or "Kesho/Tomorrow" → triggers an outbound voice call
* `4` → END ("Kwaheri")
* Anything > 2 levels deep → END ("Too many steps")

### 4. `POST /api/sms-callback`

AT calls this when an SMS is sent to our short code / DID.

Payload AT sends:
| Field | Example |
|---|---|
| `from` | `+254711082200` |
| `to` | `+254711082200` |
| `text` | `BULA` |
| `id` | `AT-sms-…` |

Keyword table (first word, case-insensitive):

| Keyword | Reply (≤160 chars) | Triggers callback? |
|---|---|---|
| `BULA` | Brief + "ArdaLink itapiga simu hivi karibuni" | yes |
| `MALISHO` | Top-3 nearest water points | no |
| `ONGEA` / `AI` | "ArdaLink will call you shortly" | yes |
| `STOP` / `SITAKI` / `UNDO` | empty (no auto-reply) | no |
| anything else | Help line: BULA / MALISHO / ONGEA / STOP | no |

---

## Running the sandbox simulator

The simulator lives at `scripts/sandbox-simulate.mjs` and POSTs the
exact payload shapes AT sends in production to our own webhooks.
Run it against a live local stack:

```bash
make up                                             # local stack
node scripts/sandbox-simulate.mjs ussd              # walk the USSD menu
node scripts/sandbox-simulate.mjs sms               # send BULA + MALISHO + STOP
node scripts/sandbox-simulate.mjs voice             # outbound call + lifecycle event
node scripts/sandbox-simulate.mjs all               # run all three
```

Environment overrides:

| Var | Default | Notes |
|---|---|---|
| `API_BASE` | `http://127.0.0.1:3000` | API root (no trailing slash) |
| `SANDBOX_PHONE` | `+254711082200` | The herder phone to simulate |
| `OPERATOR_EMAIL` | `bula-pesa@ardalink.test` | For `/api/trigger-check` auth |
| `OPERATOR_PASSWORD` | `bula-pesa` | Same |

### What `simulate voice` does

1. `POST /api/auth/login` as the demo operator to get a JWT
2. `POST /api/trigger-check` (dryRun) — exercises the satellite→AI path
3. `POST /api/voice-callback` — simulates AT asking us what to do when
   the call connects. We respond with `<Stream>` XML pointing to our WS
4. `POST /api/voice-events` — simulates AT posting the lifecycle event
   after the call ends

The trigger-check step will return **500** in local dev because
`GOOGLE_SERVICE_ACCOUNT_JSON` is empty (Earth Engine isn't configured).
That's expected — the rest of the flow still validates the webhook
contract.

---

## Switching to real AT (production)

When you have a real AT account, you only need to:

1. **Set the URL** in the AT dashboard for each webhook:
   - Voice callback: `https://YOUR-HOST/api/voice-callback`
   - Voice events: `https://YOUR-HOST/api/voice-events`
   - USSD: `https://YOUR-HOST/api/ussd-callback`
   - Inbound SMS: `https://YOUR-HOST/api/sms-callback`

2. **Set env vars**:
   ```bash
   AFRICASTALKING_USERNAME=YourProductionUsername
   AFRICASTALKING_API_KEY=at_live_…
   AFRICASTALKING_CALLER_ID=+25420XXXXXXX   # your DID / toll-free number
   REPLIT_DEV_DOMAIN=your-public-host       # public-facing domain for WS URL
   ```

2b. **Set Azure env vars** (required for the deterministic voice
    pipeline that real herder calls now use; without them the STT + LLM
    stack falls back to z.ai and the deterministic pipeline can't
    transcribe):
   ```bash
   # Chat (deterministic pipeline uses gpt-5-mini for indicator extract)
   AZURE_OPENAI_FOUNDRY_ENDPOINT=https://<resource>.services.ai.azure.com/api/projects/<project>
   AZURE_OPENAI_ENDPOINT=https://<resource>.services.ai.azure.com/
   AZURE_OPENAI_API_KEY=<foundry-api-key>
   AZURE_OPENAI_CHAT_DEPLOYMENT=gpt-5-mini
   LLM_PRIMARY_PROVIDER=azure

   # Realtime — OPTIONAL. Only needed if you flip CALL_PIPELINE_MODE
   # back to `realtime` or run the browser realtime demo. Deterministic
   # herder calls work without this deployment.
   AZURE_OPENAI_REALTIME_DEPLOYMENT=gpt-4o-realtime-preview

   # Speech — sw-KE + en-KE STT/TTS. Fast Transcription auto-falls back
   # to the short-audio REST endpoint in regions like southafricanorth.
   AZURE_SPEECH_KEY=<speech-key>
   AZURE_SPEECH_REGION=southafricanorth

   # Voice call flow
   CALL_PIPELINE_MODE=deterministic   # deterministic (default) | realtime
   DETERMINISTIC_TENANT_ID=bula-pesa   # RLS tenant for demo/sandbox rows

   # Supabase — recommended for herder personalization (source of truth
   # for wards / satellite_indices / weather_data / ground_truth_calls
   # since 2026-07-08). Without these the herder context resolver
   # returns source="local" and uses seed data instead of live Supabase.
   SUPABASE_URL=https://<ref>.supabase.co
   SUPABASE_SECRET_KEY=sb_secret_...
   SUPABASE_CACHE_TTL_MS=60000
   ```

3. **Get a short code** (USSD) and register it with Safaricom — 3 weeks
   lead time per STATUS.md §6.1.

Nothing else changes. The webhooks return the exact same XML/text
shapes the simulator drives, so the production flow is byte-identical
to the sandbox flow.

---

## Tests

`tests/voiceAndUssd.test.ts` covers:

* 27 assertions across the four webhook endpoints
* Response shapes match AT's contract (`<Response><Stream/>`, `CON`/`END`,
  single-segment SMS replies)
* Webhooks are reachable without Bearer auth (AT can't sign JWTs)
* Malformed input is handled gracefully (deep menu, bad keyword, etc.)

Run them:

```bash
pnpm test tests/voiceAndUssd.test.ts
```

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `401 Missing Bearer token` from `/api/trigger-check` | No operator token | Set `OPERATOR_EMAIL` + `OPERATOR_PASSWORD` in your env |
| `500 Unexpected end of JSON input` from `/api/trigger-check` | Earth Engine not configured (no `GOOGLE_SERVICE_ACCOUNT_JSON`) | Expected in dev. For real tests, add a GEE service-account JSON. |
| USSD reply shows "Samahani, hatuna ripoti ya satellite leo" | No intelligence cycle has run yet | `POST /api/trigger-check` with `dryRun: true` first |
| Voice-callback returns `<Stream url="wss://undefined/…"/>` | `REPLIT_DEV_DOMAIN` not set | Set it to your public host (Replit gives you this for free; for non-Replit deploys set it to your domain) |
| Sandbox simulator says "API at … is not reachable" | API isn't running | `make up` first |

---

## What's NOT in the sandbox

These will work the moment you provide real credentials — no code changes:

| Capability | Needs | Source |
|---|---|---|
| Live outbound calls | `AFRICASTALKING_API_KEY` (paid) | AT dashboard |
| Deterministic voice pipeline (herder default) | `AZURE_OPENAI_*` (chat) + `AZURE_SPEECH_KEY` + `CALL_PIPELINE_MODE=deterministic` (default) | Azure portal |
| Real Azure chat LLM (`gpt-5-mini`) — now the default primary | Same Foundry resource + `AZURE_OPENAI_CHAT_DEPLOYMENT=gpt-5-mini` + `LLM_PRIMARY_PROVIDER=azure` | Azure portal |
| Real Azure Speech (STT/TTS `sw-KE` + `en-KE`) | `AZURE_SPEECH_KEY` + `AZURE_SPEECH_REGION=southafricanorth` | Azure portal |
| Realtime audio bridge (browser demo + Phase-3 herder upgrade) | Same Foundry resource + `AZURE_OPENAI_REALTIME_DEPLOYMENT=gpt-4o-realtime-preview` + `CALL_PIPELINE_MODE=realtime` if you want it for phone calls too | Azure portal |
| Supabase reference-data plane (source of truth for wards, satellite_indices, weather_data, ground_truth_calls, pastoralists — since 2026-07-08) | `SUPABASE_URL` + `SUPABASE_SECRET_KEY` (`SUPABASE_ANON_KEY` optional, `SUPABASE_CACHE_TTL_MS` optional, default 60000) | Supabase dashboard — see `ardalink-api/docs/llm-integration.md §5.3` |
| Voice biometric enrollment | Custom Whisper fine-tune + Resemblyzer | Phase 3, STATUS.md §5 |
| Dialect STT/TTS (Borana/Turkana/Samburu/Somali) | Recorded corpus + fine-tune | Phase 3 |
| USSD short-code registration | Safaricom | 3-week lead time |
| SMS sender ID | AT KYB + sender-id registration | 1 week |

The webhook contract above is stable across all phases — adding the
real Azure/AT keys lights up the live flow without touching this code.

**Live-in-dev even without AT** — two browser paths:

1. **Deterministic voice** — `/api/demo/voice/deterministic` runs the
   exact production pipeline: 20-second browser MediaRecorder capture →
   POST `/api/demo/voice/record` → Azure Speech → GPT-5 Mini extract →
   `ground_truth_reports` row with BCS / mortality / water / trust
   score. This is what every real herder phone call ends up doing —
   proven without a phone.
2. **Realtime voice** (optional, requires Realtime deployment) —
   `/api/demo/voice/simulator` mints a demo token, opens the same
   `/api/browser-voice-stream` bridge production calls use, does
   full-duplex WS audio, and shows the extracted ground truth after
   hang-up.

Both endpoints write to `ground_truth_reports` under
`DETERMINISTIC_TENANT_ID` (default `bula-pesa`) so RLS accepts the
insert.

**Phase-3 realtime plan:** the roadmap to make Realtime the herder
default is captured in `ardalink-api/docs/llm-integration.md §5.2` —
gate on herder-side 3G/4G coverage, prompt-suite dialect coverage, and
per-minute pricing or a self-hosted alternative. Until then,
deterministic stays the herder default; realtime stays a demo and a
staging ground for the upgrade.
