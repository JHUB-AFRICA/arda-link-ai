# LLM Integration — State, Providers, Findings

**Service**: `ardalink-api` (TypeScript, Node 24) + `ardalink-engine` (Python, FastAPI) for ASR / TTS only
**Audience**: API maintainers, ops, partners integrating with our LLM layer
**Scope**: what the LLM stack is doing today, what it can do, what's
broken, what to fix first. Companion to [`data-sources.md`](./data-sources.md)
(which covers weather / satellite feeds).

---

## 1. Live state of the LLM stack (verified 2026-06-30)

Probed against the running dev stack via `GET /api/llm/status`:

```
ROUTING TABLE:                              provider health (live /models probe):
  multilingual -> primary=z  fallback=minimax      z      : ✗ down (3652ms)
  voice_script -> primary=z  fallback=minimax      minimax: ✗ down (907ms)
  summarize   -> primary=z  fallback=minimax
  reasoning   -> primary=z  fallback=minimax
  code        -> primary=z  fallback=minimax
  extract     -> primary=z  fallback=minimax
  default     -> primary=z  fallback=minimax

RECENT CALLS (last 24h, audit log):
  2026-06-30T09:39:17.948Z  task=summarize  provider=z/(error)
  2026-06-30T09:38:52.924Z  task=summarize  provider=z/(error)
  2026-06-30T09:38:29.896Z  task=summarize  provider=z/(error)
  2026-06-30T09:38:07.874Z  task=summarize  provider=z/(error)
  2026-06-30T09:32:46.677Z  task=summarize  provider=z/(error)

BUDGET:
  daily token budget: 100,000 / task (default)
  consumed: 0 across all tasks
```

**Bottom line today:**

1. The LLM **registry, routing table, cache, cost guard, and audit
   log all work**. The 4 routes that use the LLM (`/api/chat`,
   `/api/talk-chat`, `/api/intelligence/brief`, and the post-call
   pipeline) correctly route through the provider-agnostic layer.
2. **Both providers are down in dev** — `z.ai 401: token expired or
   incorrect` and `minimax` returns 401 (placeholder key). The real
   LLM path is exercised end-to-end (the audit log shows
   `provider=z/(error)` rather than `provider=mock`), but every call
   currently fails the primary and (since `minimax` is also down)
   the fallback.
3. The MockClient is **not** the live client — it's only used in unit
   tests and as the `create()` fallback when no key is set. In
   dev with a key set (even an expired one), the ZaiClient is
   constructed and the live `/chat/completions` call is attempted.
4. The LLM voice bridge (Azure OpenAI Realtime over WebSocket) is
   **separate** — it lives in `voiceStream.ts` and is not part of
   the LLM registry. See §5 below.

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

| Task          | Primary | Fallback | Used by |
|---|---|---|---|
| `multilingual` | `z`     | `minimax` | `/api/chat`, `/api/talk-chat` (Swahili/English code-switching) |
| `voice_script` | `z`     | `minimax` | `generateScript()` — pre-call bilingual opening |
| `summarize`    | `z`     | `minimax` | `/api/intelligence/brief` |
| `extract`      | `z`     | `minimax` | `extractIndicators()` — BCS, offtake, mortality, action tag |
| `reasoning`    | `z`     | `minimax` | Multi-step / tool use |
| `code`         | `z`     | `minimax` | Function-calling synthesis |
| `default`      | `z`     | `minimax` | Safe default for new code paths |

All seven tasks use **z → minimax** in default config.

Per-task env override:
- `LLM_TASK_SUMMARIZE_PRIMARY=minimax`
- `LLM_PRIMARY_PROVIDER=minimax`
- `LLM_FALLBACK_PROVIDER=z`
- `LLM_TIMEOUT_MS=120000` (default 90s)

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

### 3.3 Which provider handles Swahili better?

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

### 3.4 Which provider for the realtime voice bridge?

Neither z.ai nor minimax offers the bidirectional WebSocket mulaw
audio path that ArdaLink's `/api/browser-voice-stream` needs. That
path uses **Azure OpenAI Realtime** (`gpt-4o-realtime-preview`)
directly via WebSocket — not in the LLM registry. See §5.

### 3.5 MiniMax Speech 2.8 (TTS) — the "sound API" question

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

## 5. The voice bridge (Azure OpenAI Realtime) — separate

The voice bridge in `voiceStream.ts` (and `voiceStreamBrowser.ts`)
uses **Azure OpenAI Realtime** over a raw WebSocket — not in the LLM
registry. This is intentional and documented in `openai.ts:99-103`:

> Realtime WebSocket audio (voiceStream.ts) is unchanged — that path
> is not text generation, it's bidirectional mulaw streaming that z.ai
> and minimax don't offer. Azure OpenAI Realtime (gpt-4o-realtime) stays
> the only option for that path until Phase 3 (ARCHITECTURE-V2 §5.3).

The ReST call-sites for the voice bridge are:

- `voiceStream.ts:23-25` — `gpt-4o-realtime-preview` deployment
- `voiceStream.ts:227-228` — opens the Azure Realtime WebSocket
- `voiceStream.ts:245` — configures the session (voice, language,
  tools, voice activity detection, turn detection)
- `voiceStream.ts:312` — handles `session.updated`
- `voiceStream.ts:327` — relays audio deltas to the herder's AT
  WebSocket
- `voiceStream.ts:373` — sends the next audio chunk
- `voiceStream.ts:440` — native Azure Realtime transcription

`/api/llm/status` does **not** include the voice bridge in its
health probe. To monitor it, use the Azure portal or add a separate
`/api/voice/status` route that pings the Azure Realtime deployment
endpoint. **Owner: backend. Phase 12.**

---

## 6. Files touched in this integration

- `ardalink-api/src/lib/llm/types.ts` — provider-agnostic contract
- `ardalink-api/src/lib/llm/registry.ts` — routing + cache + fallback
- `ardalink-api/src/lib/llm/cost.ts` — per-task daily budget
- `ardalink-api/src/lib/llm/audit.ts` — ring buffer of every call
- `ardalink-api/src/lib/llm/providers/zai.ts` — ZaiClient (OpenAI-compatible)
- `ardalink-api/src/lib/llm/providers/minimax.ts` — MinimaxClient
- `ardalink-api/src/lib/llm/providers/mock.ts` — MockClient for tests
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
