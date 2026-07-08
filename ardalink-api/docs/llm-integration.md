# LLM Integration — State, Providers, Findings

**Service**: `ardalink-api` (TypeScript, Node 24) + `ardalink-engine` (Python, FastAPI) for ASR / TTS only
**Audience**: API maintainers, ops, partners integrating with our LLM layer
**Scope**: what the LLM stack is doing today, what it can do, what's
broken, what to fix first. Companion to [`data-sources.md`](./data-sources.md)
(which covers weather / satellite feeds).

---

## 1. Live state of the LLM stack (verified 2026-07-06)

Probed against the running dev stack via `GET /api/llm/status`:

```
ROUTING TABLE:                              provider health (live probe):
  multilingual -> primary=azure  fallback=z      azure  : ✓ up   (~1800ms)
  voice_script -> primary=azure  fallback=z      z      : status varies with key
  summarize    -> primary=azure  fallback=z      minimax: status varies with key
  reasoning    -> primary=azure  fallback=z
  code         -> primary=azure  fallback=z
  extract      -> primary=azure  fallback=z
  default      -> primary=azure  fallback=z

RECENT CALLS (verified 2026-07-06):
  task=summarize (intelligence brief)  provider=azure/gpt-5-mini
    tokens=787   latency=6.4s   language=sw   OK
  task=voice_script (demo turn)        provider=azure/gpt-5-mini
    tokens=~250  latency=2.5s   language=sw   OK

BUDGET:
  daily token budget: 100,000 / task (default)
```

**Bottom line today:**

1. **Azure AI Foundry (`gpt-5-mini`) is now the primary LLM provider.**
   The `AzureOpenAIClient` in `providers/azure.ts` is registered in the
   registry, `LLM_PRIMARY_PROVIDER=azure` is the default in
   `docs/local-dev/.env`, and z.ai is the automatic fallback. Verified
   with a real Swahili intelligence brief for tenant `bula-pesa`.
2. The LLM **registry, routing table, cache, cost guard, and audit
   log all work**. Every task now shows `provider=azure` in the audit
   ring.
3. Azure GPT-5 quirks are handled inside the provider (auto-switch to
   `max_completion_tokens`, force `reasoning_effort: minimal`, drop
   `temperature`). See §3.3 below.
4. **Two voice paths, chosen per call by `CALL_PIPELINE_MODE`:**
   - **`deterministic`** (default, herder production path) — no Realtime
     needed. AT `<Say>` + `<GetDigits>` + `<Record>` collect a 20-second
     clip; the server transcribes via Azure Speech, runs the registry's
     `extractIndicators` (Azure GPT-5 Mini) and writes a full
     `ground_truth_reports` row. Every call produces data. See
     `src/lib/voiceDeterministicPipeline.ts`.
   - **`realtime`** (optional, demo + future upgrade) — Azure OpenAI
     Realtime over WebSocket, full-duplex live conversation. Requires a
     `gpt-4o-realtime-preview` deployment on the Foundry resource. Kept
     for browser demos (`/api/demo/voice/simulator`) and reserved as the
     upgrade once herder connections and Realtime pricing improve.
     Lives in `voiceStream.ts` and `voiceStreamBrowser.ts` — still
     separate from the LLM registry because the WS bridge is bidirectional
     audio, not chat completions.
5. Azure Speech (STT/TTS) is also live but is not an LLM provider — see
   `docs/05-OBSERVABILITY.md` or the endpoint list in `RUNBOOK.md`.
   Its `fastTranscribe()` helper auto-falls back to the short-audio REST
   endpoint when the Speech resource's region doesn't host the Fast
   Transcription API (e.g. `southafricanorth`).

---

## 2. What the LLM layer is (architecture)

```
ardalink-api/src/lib/llm/
├── types.ts          Provider-agnostic contract (LlmClient, LlmTask, LlmResponse…)
├── registry.ts       Per-task routing + primary→fallback + cache + timeout
├── cost.ts           Per-task daily token budget guard (LLM_DAILY_TOKEN_BUDGET)
├── audit.ts          Ring buffer (1000 entries) of every LLM call
├── prompts/
│   └── tenant-brief.ts  Brief template (Cite numbers from DATA, never invent…)
├── index.ts          Public surface — routes / features import from here only
└── providers/
    ├── azure.ts      AzureOpenAIClient — POST /openai/deployments/<name>/chat/completions
    ├── zai.ts        ZaiClient — POST /chat/completions, OpenAI-compatible
    ├── minimax.ts    MinimaxClient — POST /chat/completions, OpenAI-compatible
    └── mock.ts       MockClient — used by tests + dev when no key
```

**Public surface (from `index.ts`)** — every business-logic caller imports
from `./llm/index.js`, never from a specific provider:

```ts
import { complete, completeJson, getLlmClient, routingTable,
         providersHealth, costGuard, recentCalls } from "../lib/llm/index.js";
```

The registry's `complete(task, req, ctx)` is the only entry point:

- `costGuard.exceeded(task)` → throws `LlmBudgetError` if daily budget done
- Check cache (key = `sha256(task | messages | temp | maxTokens)`); return on hit
- Try `pickProvider(task, "primary")`; cache + record on success
- On failure, fall through to `pickProvider(task, "fallback")`
- Record every call (success or error) in the audit ring buffer

Cache TTL = `LLM_CACHE_TTL_SECONDS` (default 300s). Each call records
`tenant_id` from `ctx` so a per-tenant cache can be replayed in
`/api/llm/status` without a per-tenant key.

### Routing table (defaults, override via env)

Table shows the **shipped default** (Azure primary, z fallback) — this is
what the `docs/local-dev/.env` template gives you. The registry still
supports `z` and `minimax` as primaries via `LLM_PRIMARY_PROVIDER`.

| Task          | Primary | Fallback | Used by |
|---|---|---|---|
| `multilingual` | `azure` | `z`     | `/api/chat`, `/api/talk-chat` (Swahili/English code-switching) |
| `voice_script` | `azure` | `z`     | `generateScript()` — pre-call bilingual opening |
| `summarize`    | `azure` | `z`     | `/api/intelligence/brief` |
| `extract`      | `azure` | `z`     | `extractIndicators()` — BCS, offtake, mortality, action tag |
| `reasoning`    | `azure` | `z`     | Multi-step / tool use |
| `code`         | `azure` | `z`     | Function-calling synthesis |
| `default`      | `azure` | `z`     | Safe default for new code paths |

The global `LLM_PRIMARY_PROVIDER=azure` env in `docs/local-dev/.env`
puts Azure at the top for every task. To pin one task back to z.ai:
`LLM_TASK_EXTRACT_PRIMARY=z`. To flip the whole stack back to z.ai
primary: `LLM_PRIMARY_PROVIDER=z LLM_FALLBACK_PROVIDER=minimax`.

Per-task env override:
- `LLM_TASK_SUMMARIZE_PRIMARY=azure|z|minimax`
- `LLM_PRIMARY_PROVIDER=azure|z|minimax`
- `LLM_FALLBACK_PROVIDER=azure|z|minimax`
- `LLM_TIMEOUT_MS=90000` (default 90s — GPT-5 non-minimal reasoning can burn this)

---

## 3. Provider research

### 3.1 z.ai (Zhipu / GLM family)

**Endpoint**: `https://api.z.ai/api/paas/v4` — OpenAI-compatible.
**Auth**: Bearer `$ZAI_API_KEY`.
**Default model**: `glm-4.5-flash` (free tier).
**JavaScript client**: OpenAI SDK with `baseURL=https://api.z.ai/api/paas/v4/`.

Available chat models (June 2026):

| Model | Context | Notes |
|---|---|---|
| `glm-5.2`            | 1,000,000 | Latest flagship, 1M context, supports `reasoning_effort` |
| `glm-5.1`            | — | |
| `glm-5-turbo`        | — | |
| `glm-5`              | — | |
| `glm-4.7`            | 200,000 | Thinking cannot be disabled |
| `glm-4.6`            | 200,000 | |
| `glm-4.5`            | 128,000 | |
| `glm-4.5-air`        | — | Cost-effective |
| `glm-4.5-x`          | — | High-speed |
| `glm-4.5-airx`       | — | High-speed Air |
| **`glm-4.5-flash`**  | **128,000** | **Free, fast, default for ArdaLink** |
| `glm-4-32b-0414-128k`| 128,000 | Legacy |

Capabilities confirmed by docs:
- **Swahili support** — multilingual, with code-switched Swahili/English
  prompt handling. Models were pre-trained on multilingual data
  including 26+ languages; Swahili is not separately documented in the
  model spec but the platform lists "low-resource languages and informal
  contexts" support.
- **`thinking` mode** — `type: enabled` or `type: disabled`. The
  ZaiClient explicitly sets `thinking: { type: "disabled" }` on every
  call to avoid the 15–30s "think-then-answer" delay.
- **`response_format: { type: "json_object" }`** — supported.
- **Function calling** — `tools` array, `tool_choice: "auto"`.
- **Vision** — separate model family (`glm-5v-turbo`, `glm-4.5v`,
  `glm-4.6v`) for image and video input.
- **Audio transcription** — `GLM-ASR-2512` (CER 0.0717) at
  `/api/paas/v4/audio/transcriptions`.
- **Text-to-speech** — `CogVideoX-3` and other TTS models.

**Pricing (current public):**
- $0.20 per million input tokens
- $1.10 per million output tokens
- `glm-4.5-flash`: free
- 100+ tokens/second for high-speed models

### 3.2 MiniMax (M-series + Speech + Music + Video)

**Endpoint**: `https://api.minimax.io/v1` (text) /
`https://api-uw.minimax.io/v1/t2a_v2` (low-latency TTS).
**Auth**: Bearer `$MINIMAX_API_KEY`.
**Default model**: `MiniMax-M3`.

**Two API surfaces:**
- **OpenAI-compatible** (`/v1/chat/completions`) — `baseURL=https://api.minimax.io/v1`
- **Anthropic-compatible** (`/anthropic/v1/messages`) — `baseURL=https://api.minimax.io/anthropic`

Available chat models:

| Model | Context | Description |
|---|---|---|
| **`MiniMax-M3`** | **1,000,000** | **Latest, frontier coding + agentic, native multimodal (text / image / video / tool use / thinking blocks). MSA (MiniMax Sparse Attention).** |
| `MiniMax-M2.7`           | 204,800 | Recursive self-improvement; 60 tps |
| `MiniMax-M2.7-highspeed` | 204,800 | M2.7 faster; 100 tps |
| `MiniMax-M2.5`           | 204,800 | Peak performance / value; 60 tps |
| `MiniMax-M2.5-highspeed` | 204,800 | M2.5 faster; 100 tps |
| `MiniMax-M2.1`           | 204,800 | Multilingual programming; 60 tps |
| `MiniMax-M2.1-highspeed` | 204,800 | 100 tps |
| `MiniMax-M2`             | 200,000 | Agentic, advanced reasoning |

**M3 specifics** (relevant to ArdaLink):
- **1M context window** — matches z.ai glm-5.2.
- **Native multimodal** — images, video, file inputs through
  `image_url` / `video_url` / `file_url` content parts.
  Image token usage: low ~600, default 1k-3k (≤ 5k), high several k (≤ 15k+).
  Video token usage: URL/base64 ≤ 50 MB, or upload through Files API
  and reference `mm_file://{file_id}` (≤ 512 MB).
- **Tool use + interleaved thinking** — supports `thinking` blocks
  that must be preserved and returned unchanged across turns.
  Pattern: `reasoning_content` field in response, then include
  `reasoning_content` in subsequent messages.
- **`reasoning_split` flag** — separates thinking into
  `reasoning_details` field (cleaner multi-turn handling).
- **`thinking` controls** — `disabled` or `adaptive` for M3.
  M2.x models: thinking **cannot** be disabled (silently ignored).
- **Service tiers** — `standard` (default) or `priority` (1.5× price,
  faster admission).

**MiniMax Speech 2.8 / 2.6 — the "sound API" research:**

| Model | Description | ArdaLink fit |
|---|---|---|
| `speech-2.8-hd`     | Ultra-realistic quality, sound tags, 40 languages, 7 emotions, dialects | **Strong fit** for the Talk-app voice bridge (currently uses Azure OpenAI Realtime) |
| `speech-2.8-turbo`  | Speed + natural flow, 40 languages, 7 emotions | **Strong fit** for low-latency voice |
| `speech-2.6-hd`     | Ultimate similarity, ultra-high quality, 40 langs, 7 emotions | |
| `speech-2.6-turbo`  | Ultimate value, low latency, 40 langs, 7 emotions | |

TTS endpoint: `POST https://api.minimax.io/v1/t2a_v2` (synchronous
HTTP) or `https://api-uw.minimax.io/v1/t2a_v2` (low-latency).

TTS request schema:
```json
{
  "model": "speech-2.8-hd",
  "text": "Habari yako, mzee?",
  "stream": false,
  "voice_id": "English_expressive_narrator",
  "voice_setting": {"speed": 1, "vol": 1, "pitch": 0, "emotion": "happy"},
  "audio_setting": {"sample_rate": 32000, "bitrate": 128000, "format": "mp3", "channel": 1},
  "language_boost": "auto",
  "output_format": "hex"
}
```

**MiniMax Speech features relevant to the pastoralist use case:**
- **40 languages + 7 emotions + dialects** — covers Kiswahili +
  English + Borana + Turkana + Samburu + Somali. Realistic prosody
  with controllable speed / vol / pitch.
- **Interjection tags** — `(laughs)`, `(chuckle)`, `(coughs)`,
  `(sighs)`, `(breath)`, `(humming)`, etc. embedded in text. Only
  supported on `speech-2.8-hd` and `speech-2.8-turbo`.
- **Sound effects** — `spacious_echo`, `auditorium_echo`, `lofi_telephone`,
  `robotic`. One at a time.
- **Pause control** — `<#x#>` markers (e.g. `<#2.5#>` for 2.5s pause).
- **Inline pronunciation** — wrap Pinyin / IPA / Jyutping in
  half-width parentheses to override default pronunciation.
- **Voice cloning** — supported via the Voices API (not free).
- **Subtitle generation** — sentence / word / word_streaming
  granularity, JSON timestamps.

**ASR (Speech-to-Text):**
- `asr-2.8-hd` and similar — not explicitly documented in the
  chat-completion reference, but available through the TTS endpoint
  family. (z.ai's `GLM-ASR-2512` is the better documented choice for
  the current ASR path.)

**Music 2.6 / 2.0** — not relevant to the current ArdaLink stack.
Possible future use: herder-voice ringtones, jingle for the dashboard.

### 3.3 Azure AI Foundry (GPT-5 Mini) — the current primary

**Added 2026-07-06.** Provider name in the registry: `azure`.

- **Endpoint shape**: classic Azure OpenAI URL served on the AI Foundry
  resource: `POST {AZURE_OPENAI_ENDPOINT}/openai/deployments/{deployment}/chat/completions?api-version={AZURE_OPENAI_CHAT_API_VERSION}`.
  Auth: `api-key: <AZURE_OPENAI_API_KEY>`. Works for both classic
  `*.openai.azure.com` resources and Foundry `*.services.ai.azure.com`
  resources — the `/openai/deployments/...` path is served on both.
- **Deployment name** in env: `AZURE_OPENAI_CHAT_DEPLOYMENT=gpt-5-mini`.
- **API version**: `AZURE_OPENAI_CHAT_API_VERSION=2024-10-21` (default).
- **Known GPT-5-family quirks** — handled inside `providers/azure.ts`:
  - `max_tokens` is rejected. The client auto-detects deployments whose
    name matches `/gpt-5/i` and sends `max_completion_tokens` instead.
  - By default GPT-5 burns the entire completion budget on hidden
    reasoning tokens (visible content = empty, finish_reason = "length").
    The client forces `reasoning_effort: "minimal"` for every request —
    override with env `AZURE_OPENAI_REASONING_EFFORT=low|medium|high`.
  - `temperature` outside 1.0 is rejected. The client drops the field
    for GPT-5 deployments and lets the model default apply.
- **Verified behavior** (2026-07-06):
  - Health probe (1-token completion): `azure ok=True lat=1800ms`.
  - Real Swahili intelligence brief for `bula-pesa`:
    provider=`azure`, model=`gpt-5-mini`, tokens=787, latency=6.4s.
    Output is a full 3-paragraph Swahili summary + 3 recommended actions
    grounded in real satellite + ground-truth data.
  - Demo voice turn (voice_script task): ~250 tokens, 2.5s.
- **Fallback**: when the Azure key is unset, `AzureOpenAIClient.create()`
  returns a `MockClient` tagged `azure` so the registry still works and
  the audit log records which provider was selected.

### 3.4 Which provider handles Swahili better?

**Z.ai (GLM-4.5-Flash + GLM-5.2)**: documented as multilingual with
emphasis on Chinese + English; Swahili is not a primary supported
language in the docs but the GLM family was pre-trained on 15T tokens
of "general-domain data" which includes African languages. Community
reports of GLM handling Swahili are mixed. The `thinking` mode can
be disabled, which is critical for our low-latency chat path
(Swahili turns must complete in < 3s for the Talk-app).

**MiniMax (M3, M2.7)**: documented as "Polyglot code mastery" for
programming languages; not specifically Swahili. However, M3's
interleaved-thinking + 1M context makes it well-suited for
multilingual pastoralist copy where the prompt is a complex
ward-state JSON that needs to be condensed into Bantu-influenced
Swahili pastoralist register.

**Open-Meteo (no LLM)**: the climate feed is multi-lingual by
default — it just returns numbers. The intelligence-brief *prompt*
is the thing that needs Swahili fluency, and that's what we test
manually with seeded `lang="sw"` payloads.

**Recommendation**: keep `z` (GLM-4.5-Flash) as primary for the
fast text tasks (multilingual, voice_script, summarize, extract)
because it has free tier, disables thinking cleanly, and supports
`response_format: json_object` (critical for the BCS extract schema).
Keep `minimax` (M3) as fallback — it has the 1M context for long
briefs, native multimodal for the future screenshot-in-brief use
case, and stronger reasoning for the `reasoning` and `code` tasks.

### 3.5 Which provider for the realtime voice bridge?

Neither z.ai nor minimax offers the bidirectional WebSocket mulaw
audio path that ArdaLink's `/api/browser-voice-stream` needs. That
path uses **Azure OpenAI Realtime** (`gpt-4o-realtime-preview`)
directly via WebSocket — not in the LLM registry. See §5.

The GPT-5 family (the chat primary above) does **not** support the
Realtime API — that's why the Realtime deployment name is a separate
env var (`AZURE_OPENAI_REALTIME_DEPLOYMENT`) and typically points to
`gpt-4o-realtime-preview` on the same Foundry resource.

**Realtime is no longer the herder-facing production path.** Since
2026-07-07, herder phone calls default to the deterministic pipeline
(§5.1 below), which uses the same Azure GPT-5 Mini registry entry that
serves every other text task. Realtime stays wired for browser demos
and is on the roadmap as a Phase-3 upgrade once (a) Kenyan 3G/4G
coverage in the wards makes sub-second turn-taking viable, and (b) our
prompt suite handles code-switched Borana / Turkana / Samburu / Somali
in the same session — see `STATUS.md §5` for the Realtime uplift plan.

### 3.6 MiniMax Speech 2.8 (TTS) — the "sound API" question

If we want to **replace Azure OpenAI Realtime** for the voice bridge,
the candidate is **MiniMax Speech 2.8 HD** (40 languages, 7 emotions,
realistic prosody, embedded interjections, controllable sound
effects). It would require:

1. Build a WebSocket proxy: AT → MiniMax speech-2.8-hd via HTTP T2A
   (or streaming T2A v2). This is non-trivial — Azure Realtime does
   bidirectional streaming in one connection; MiniMax T2A is a
   request/response model that we'd need to wrap.
2. Build a streaming TTS pipeline that chunks pastoralist copy
   sentence-by-sentence (matches the 30s audio limit per chunk on
   MiniMax) and feeds the audio chunks back over the AT WebSocket
   within the existing `voiceStream.ts` flow.
3. The voice bridge also needs **bidirectional** audio (herder
   speaks → STT → LLM intent → TTS back). MiniMax doesn't have an
   equivalent Realtime ASR+LLM+TTS product on the public API
   surface. The closest is the **OpenAI /v1/realtime** style
   connection which MiniMax does not expose. **Verdict: Azure
   OpenAI Realtime stays the only option for the voice bridge in
   the medium term.**

What MiniMax Speech 2.8 *is* good for, today, without any protocol
work: **replacing the Azure OpenAI TTS in the dashboard's
"Listen to brief" play button** (`<audio src="...">` element in
the intelligence-brief drawer). That's a one-shot HTTP T2A, fits the
MiniMax model exactly, and the cost is negligible. Defer until we
have time to wire it up — currently the dashboard uses the browser's
Web Speech API for read-aloud.

---

## 4. What works, what's broken, what to fix first

### 4.1 What works

- LLM registry, routing, fallback, cache, cost guard, audit log
- All 4 consumer call-sites (`/api/chat`, `/api/talk-chat`,
  `/api/intelligence/brief`, post-call `extractIndicators`) go
  through the registry
- 32 unit tests in `llmRouting.test.ts` cover routing table,
  per-task override, cache, cost guard, audit ring buffer
- `GET /api/llm/status` exposes routing + health + budget + recent
  calls to the operator dashboard (`requireTrustedOrigin` middleware
  keeps it from being scraped in bulk)

### 4.2 What's broken in dev (June 30, 2026)

| Issue | Symptom | Fix |
|---|---|---|
| `ZAI_API_KEY` is the dev placeholder, not a real key | `z.ai 401: token expired or incorrect` on every call | Set `ZAI_API_KEY=sk-api-...` in `ardalink-engine/.env` (the engine's `set -a` flow sources it into the api's env) — already populated; the key is real but appears expired. **Owner: ops.** |
| `MINIMAX_API_KEY=minimax` (literal string) | `minimax 401` if z.ai fails; routing shows the key is the placeholder | Generate a real key at platform.minimax.io, set in the same env. **Owner: ops.** |
| The 3 tasks `multilingual`/`voice_script`/`summarize` show `provider=z` in the audit but no `cached: true` | Cache key is being computed (not collision) but the response is errored → cache miss + never set | Fix: when primary throws and we're falling through to fallback, the registry should `cache.set(...)` an "error sentinel" with short TTL so we don't hammer the down provider. **Owner: backend. Phase 12.** |
| `lLM_TASK_*_PRIMARY` env override is parsed but not exposed in `/api/llm/status` | Ops can't see the live override | Add `overrides: { multilingual_primary, ... }` to the status response. **Owner: backend. Phase 12.** |
| `LLM_DAILY_TOKEN_BUDGET` is per-process, not per-tenant | In multi-tenant production, one tenant can starve others | Document this and add a per-tenant `LLM_TENANT_DAILY_BUDGET` override. **Owner: backend. Phase 12.** |
| `recentCalls()` returns 1000 entries max | Audit log rolls over after 1000 calls | Document the in-memory nature of the ring buffer; production should persist to a `llm_calls` table (see the comment at the top of `audit.ts`). **Owner: backend. Phase 13 (data layer).** |

### 4.3 What's not wired (deferred)

- **Voice bridge → MiniMax Speech 2.8 TTS** — possible but needs a
  WebSocket-to-HTTP proxy. Skip until ops can spare 1 sprint.
- **Multimodal brief (image in prompt)** — both z.ai glm-5v and
  MiniMax M3 support it. Skip until the dashboard has a feature
  that needs a screenshot-in-brief.
- **MiniMax Music 2.6** — not relevant to the current product.
- **Per-tenant cache keys** — the cache key currently includes
  message role + content + tenant, so per-tenant cache hits work,
  but eviction is global LRU. Skip until the audit log is persisted.

---

## 5. The voice pipeline — two modes, chosen per call

Since 2026-07-07 the voice call path has **two modes** selected by the
`CALL_PIPELINE_MODE` env (default `deterministic`) or a per-request
`?mode=` query on the AT webhook:

### 5.1 Deterministic mode (herder production path)

**Default. What every real herder call runs today.** Lives in
`src/lib/voiceDeterministicPipeline.ts` and the dual-mode route
`src/routes/voice.ts`. The AT call is entirely scripted; the LLM only
runs *after* the call, on the recorded transcript.

```
POST /api/voice-callback?stage=opener
  → <Say> value-first opener  (real ward NDVI + risk level from
                               getLastResult(); no LLM in the loop)
  → <GetDigits>                 (DTMF menu: 1=BCS, 2=water, 3=mortality,
                                 4=feeding, 5=milk, 6=trek, 7=other)

POST /api/voice-callback?stage=dtmf
  → <Say> "You selected <category>. Speak after the beep."
  → <Record maxLength=20 finishOnKey=#>

POST /api/voice-callback?stage=recorded&category=<id>
  → <Say> "Asante, kwaheri."   (call ends)
  → fire-and-forget processDeterministicVoiceRecording():
      1. download AT recording
      2. Azure Speech transcription
         (fastTranscribe → auto-falls back to short-audio REST
          when the resource's region doesn't host Fast, e.g.
          southafricanorth)
      3. LLM registry: extractIndicators (Azure GPT-5 Mini)
                     + generateActionTag (same registry entry)
      4. computeTrustScore (server-derived, not model-reported)
      5. withTenantContext('bula-pesa', tx => tx.insert(...))
         inserts ground_truth_reports row with tenant_id set so
         the RLS `tenant_isolation` policy accepts the write
      6. touchPastoralistLastContact(phone)  — dashboard freshness
```

**Why deterministic wins for the herder path:**

- Works with any chat model — no Realtime deployment needed. Our
  Foundry resource ships with `gpt-5-mini` only; that's enough.
- Robust on 2G — no WS latency budget, just plain HTTP callbacks.
- Guaranteed data capture — every completed call writes exactly one
  `ground_truth_reports` row. No "the LLM forgot to ask BCS" failure
  mode.
- Cheap — one short LLM call (~250 tokens) vs. Realtime per-minute.
- Debuggable — the AT recording URL is stored on the row; replay any
  call by re-running the pipeline against the same URL.

**Verified 2026-07-07:** row #39 landed with BCS=2, species=goats,
mortality=1-3, action_tag="Dry Season Stress", trust_score=60 —
extracted from a 9-second WAV recording via the exact production path.

### 5.2 Realtime mode (optional; demo + future upgrade)

Kept wired but no longer the default. Lives in `voiceStream.ts` and
`voiceStreamBrowser.ts`. Uses **Azure OpenAI Realtime** over a raw
WebSocket — not in the LLM registry, because the WS bridge is
bidirectional audio, not chat completions.

Enable per-call with `?mode=realtime` on the AT webhook or globally
with `CALL_PIPELINE_MODE=realtime`. Requires a
`gpt-4o-realtime-preview` deployment on the same Foundry resource
(`AZURE_OPENAI_REALTIME_DEPLOYMENT`); GPT-5 models do not support the
Realtime API.

Call-sites:
- `voiceStream.ts:23-27` — deployment + API version, both env-tunable
- `voiceStream.ts:232` — opens the Azure Realtime WebSocket
- `voiceStream.ts:249` — configures the session (voice, language,
  tools, VAD, turn detection)
- `voiceStream.ts:329` — relays audio deltas back to AT
- `voiceStream.ts:263+` — TTS fallback via Azure Speech if the
  Realtime WS fails to open (caller hears the pre-generated Swahili
  script instead of silence)

**When Realtime becomes the herder default (roadmap):**

- Herder-side 3G/4G coverage in Bula Pesa, Garbatulla, Merti wards
  reliably supports sub-second round-trip latency (target: p95
  < 1.5 s end-to-end)
- Prompt suite handles Borana / Turkana / Samburu / Somali
  code-switching in the same session without dropping quality
- Per-minute Realtime pricing drops below the deterministic total
  cost (STT + one chat call), OR we can run a self-hosted
  VITS + Whisper equivalent in the Africa region
- All three are Phase-3 items in `STATUS.md §5`.

`/api/llm/status` does **not** include the Realtime bridge in its
health probe. To monitor it, use the Azure portal or add a separate
`/api/voice/status` route that pings the Realtime deployment
endpoint. **Owner: backend. Phase 12.**

### 5.3 Supabase as data plane (source of truth since 2026-07-08)

Reference data — wards, satellite indices, weather, and the thin
`ground_truth_calls` audit trail — now lives on **Supabase**. Local
Postgres is a **backup mirror**: it holds the rich per-call schema
(`ground_truth_reports`, 50 cols), pastoralist species breakdown,
`admin_users`, `tenants`, `gis_engine.*`, and takes over when Supabase
is unreachable.

**What's on Supabase** (verified populated 2026-07-08):

- `wards` — 5 active + 5 dormant
- `ward_neighbors` — 28 rows
- `ward_cells` — 26,975 rows
- `satellite_indices` — 1,082 ward-day rows
- `satellite_cell_indices` — 2.24 M cell-day rows
- `weather_data` — 20 rows
- Views `api_latest_satellite_indices`, `api_latest_weather_data`,
  `api_call_context`
- PostGIS 3.4 (`spatial_ref_sys`, `geography_columns`)
- `pastoralists` (uuid PK, upsert-on-first-call — shape differs from
  local, so we mirror only the identity + herd_size fields)
- `ground_truth_calls` (thin, 15 cols)

Two views return HTTP 500 today and are skipped by the client:
`api_latest_cell_satellite_indices`, `api_ward_cell_latest_rollup`.
Flagged to the project owner; not blocking.

**Client** — `ardalink-api/src/lib/supabase.ts` (PostgREST over
`SUPABASE_URL` + `SUPABASE_SECRET_KEY`, server-side only). Typed
helpers: `listWards`, `listActiveWards`, `listWardNeighbors`,
`latestSatelliteFor(wardId)`, `latestWeatherFor(wardId)`,
`callContextByPhone(phone)`, `pastoralistByPhone`, `upsertPastoralist`,
`insertGroundTruthCall`. Reference-table reads are cached
(`SUPABASE_CACHE_TTL_MS`, default 60 s). Every helper returns `null`
on failure so callers can fall back to the local mirror without a
try/catch dance.

**Ward-id mapping** — `src/lib/wardMapping.ts` maps tenant slugs 1:1
to Supabase's active-ward text ids: `wabera→241`, `bula-pesa→242`,
`ngare-mara→245`, `burat→246`, `oldonyiro→247`. The retired demo tenants
`garbatulla` and `merti` were dropped 2026-07-08 because they had no
Supabase equivalent — use `ngare-mara` and `burat` instead.

**Supabase-first herder context** — `resolveHerderContext(phone)` in
`src/lib/herderContext.ts` is now:

1. Try Supabase `api_call_context` view (or the `pastoralists`
   table) by canonical phone.
2. Overlay latest ward reference data from `api_latest_satellite_indices`
   + `api_latest_weather_data`.
3. Enrich from the local mirror (species breakdown cattle/goats/camels,
   extraction detail from `ground_truth_reports`).
4. If Supabase unreachable, drop to local-only.

Returns a `HerderContext` tagged with `source: "supabase" | "local" |
"none"` plus `pastoralistId`, `wardId`, `wardName`, `wardNdviMean`,
`wardVci`, `wardRainfall30dMm`, `wardTemperatureC`, `wardHumidityPct`,
`wardEt0Mm`, `preferredLanguage`, `herdSize`. All voice / USSD / SMS
paths already read this shape.

**Dual-write on every call** — after the local `ground_truth_reports`
insert (preserved rich schema), `writeSupabaseMirror()` runs in the
deterministic pipeline and in `POST /api/talk/record`:

1. Upsert the pastoralist to Supabase if not present (id + phone +
   ward_id + preferred_language + herd_size).
2. Insert a thin `ground_truth_calls` row.

Rate/proportion conversions the Supabase schema requires:

- `mortality_rate`, `offtake_rate` → `[0, 1]` proportions (buckets
  mapped to representative values before insert).
- `trust_score` → `[0, 1]` (local `0–100` divided by 100).

**Env** (added to `docs/local-dev/.env` + `.env.example` + forwarded
by `start-local.sh`):

```
SUPABASE_URL=https://<ref>.supabase.co
SUPABASE_SECRET_KEY=sb_secret_...       # service-role / secret key, server-side only
SUPABASE_ANON_KEY=                       # optional; reserved for future client-side reads
SUPABASE_CACHE_TTL_MS=60000
```

**Verified live 2026-07-08:**

- Herder context pulls NDVI 0.25272, temp 29.5 °C, rain 2.5 mm,
  humidity 30 % from Supabase for ward 242.
- Pastoralist upsert — Mohamed Ali on `+254712000004` synced from
  local to Supabase ward 242 with `herd_size=100`.
- Dual-write — `ground_truth_calls` has 2 real rows on Supabase,
  matching rich `ground_truth_reports` rows locally.
- Fallback — with Supabase env absent, `resolveHerderContext` returns
  `source: "local"`.

Schema discovery: `ardalink-api/scripts/explore-supabase.py` dumps a
full table / column / row-count report to `/tmp/supabase-report.json`.

---

## 6. Files touched in this integration

- `ardalink-api/src/lib/llm/types.ts` — provider-agnostic contract
- `ardalink-api/src/lib/llm/registry.ts` — routing + cache + fallback
- `ardalink-api/src/lib/llm/cost.ts` — per-task daily budget
- `ardalink-api/src/lib/llm/audit.ts` — ring buffer of every call
- `ardalink-api/src/lib/llm/providers/zai.ts` — ZaiClient (OpenAI-compatible)
- `ardalink-api/src/lib/llm/providers/minimax.ts` — MinimaxClient
- `ardalink-api/src/lib/llm/providers/mock.ts` — MockClient for tests
- `ardalink-api/src/lib/llm/providers/azure.ts` — AzureOpenAIClient (GPT-5 Mini primary)
- `ardalink-api/src/lib/speech.ts` — Azure Speech STT + TTS + STS token; `fastTranscribe()` with region-aware fallback
- `ardalink-api/src/lib/voiceDeterministicPipeline.ts` — post-call worker (herder production path)
- `ardalink-api/src/lib/pastoralistContact.ts` — `touchPastoralistLastContact` helper
- `ardalink-api/src/routes/voice.ts` — dual-mode `/api/voice-callback`
- `ardalink-api/src/routes/speech.ts` — `/api/speech/*` public surface
- `ardalink-api/src/lib/herderContext.ts` — Supabase-first `resolveHerderContext(phone)` with local fallback + `buildLocalizedBrief` + `buildLocalizedVoiceOpener` (used by all three deterministic sims)
- `ardalink-api/src/lib/supabase.ts` — PostgREST client (source-of-truth reference data + `ground_truth_calls` mirror), 60 s cache, null-on-failure semantics
- `ardalink-api/src/lib/wardMapping.ts` — tenant-slug ↔ Supabase `ward_id` map
- `ardalink-api/scripts/explore-supabase.py` — schema discovery script (dumps `/tmp/supabase-report.json`)
- `ardalink-api/src/routes/demo/voice.ts` — `/simulator` is now the deterministic phone-call sim; `/deterministic` alias kept; `/simulator-realtime` is the Phase-3 preview
- `ardalink-api/src/routes/demo/ussd.ts` — deterministic USSD (fixed menus, no LLM in-loop; personalized brief + "my last report" screens)
- `ardalink-api/src/routes/demo/sms.ts` — deterministic SMS keyword responses (BULA/MALISHO/ONGEA/RIPOTI/STOP) personalized by phone
- `ardalink-api/src/lib/llm/prompts/tenant-brief.ts` — brief prompt
- `ardalink-api/src/lib/llm/index.ts` — public surface
- `ardalink-api/src/lib/openai.ts` — 3 consumers (generateScript,
  generateActionTag, extractIndicators) — all go through the registry
- `ardalink-api/src/routes/llm.ts` — `GET /api/llm/status` route
- `ardalink-api/src/routes/index.ts:16,34` — registers `llmRouter`
- `ardalink-api/src/routes/chat.ts:5,261,383` — chat endpoints
- `ardalink-api/src/routes/intelligence/brief.ts:6,205-206` — brief
- `ardalink-api/tests/llmRouting.test.ts` — 32 unit tests

---

## 7. Quick reference

### 7.1 Endpoints

```
GET  /api/llm/status              LLM routing + health + budget + recent calls
                                 (requireTrustedOrigin; dashboard-only by default)
POST /api/chat                   LLM 'multilingual' (legacy Azure path — see chat.ts)
POST /api/talk-chat              LLM 'multilingual' (Talk-app)
POST /api/intelligence/brief     LLM 'summarize' (gated by ?regenerate=1 to bypass cache)
```

### 7.2 Env vars

```
# Provider selection
LLM_PRIMARY_PROVIDER=z|minimax               # global default
LLM_FALLBACK_PROVIDER=z|minimax
LLM_TASK_<NAME>_PRIMARY=z|minimax            # per-task override

# Timeouts + cache
LLM_TIMEOUT_MS=90000                         # default 90s (z.ai needs ~30-60s for Swahili)
LLM_CACHE_TTL_SECONDS=300                    # default 5 min

# Budget
LLM_DAILY_TOKEN_BUDGET=100000                # per-task per-process

# Per-provider
ZAI_API_KEY=sk-api-...                       # Bearer for z.ai
ZAI_DEFAULT_MODEL=glm-4.5-flash
MINIMAX_API_KEY=...                          # Bearer for MiniMax
MINIMAX_DEFAULT_MODEL=MiniMax-M3
```

### 7.3 Verifying the live state

```bash
TOKEN=$(curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"email":"bula-pesa@ardalink.test","password":"bula-pesa"}' \
  http://localhost:3000/api/auth/login | jq -r .token)

# Routing + budget + recent calls
curl -s -H "Authorization: Bearer $TOKEN" -H 'Origin: http://localhost:8080' \
  http://localhost:3000/api/llm/status | jq .

# End-to-end (will fail with 401 in dev until real keys are set)
curl -s -H "Authorization: Bearer $TOKEN" -H 'Origin: http://localhost:8080' \
  "http://localhost:3000/api/intelligence/brief?regenerate=1" | jq .
```

### 7.4 Adding a new provider

1. New file `ardalink-api/src/lib/llm/providers/<name>.ts` — must
   implement `LlmClient` (see `types.ts`).
2. Add the new name to the union in `registry.ts:TABLE` for the
   tasks you want to handle.
3. Export the new class from `index.ts` so the audit surface sees it.
4. Add a health probe in `registry.ts:providersHealth()`.
5. Add a test in `tests/llmRouting.test.ts` for the new task/provider
   combo.

No route, no schema, no prompt template change.

---

*Maintained by the ArdaLink engineering team. Last verified 2026-06-30 against the running dev stack. All endpoints, env vars, and code paths above are live and reproducible.*
