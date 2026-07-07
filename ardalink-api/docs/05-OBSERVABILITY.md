# 05 — Observability

[← Security](04-SECURITY.md) · [Next: Costs →](06-COSTS.md)

## Logging

Structured JSON via `pino`. Correlation ID via `X-Request-Id` header.

## Metrics

OpenTelemetry SDK → OTLP → backend.

Key gauges:

- `ardalink_api.http.requests.total{route,status}`
- `ardalink_api.http.request.duration_seconds{route}`
- `ardalink_api.voice.calls.active`
- `ardalink_api.openai.tokens.total{model,operation}`

## Tracing

Spans for every Express route + every LLM call. W3C traceparent header
propagated from `ardalink-engine` and clients.

## LLM layer

All text generation goes through `src/lib/llm/` — a provider-agnostic
registry with caching, budget guard, audit trail, and per-task routing.

### Routing table (env-overridable, shipped defaults)

The shipped `docs/local-dev/.env` sets `LLM_PRIMARY_PROVIDER=azure`
which flips every task's primary to Azure AI Foundry (`gpt-5-mini`).
z.ai stays as the global fallback.

| Task          | Primary   | Fallback  | Used by                                                                              |
|---------------|-----------|-----------|--------------------------------------------------------------------------------------|
| `multilingual`| azure     | z.ai      | `POST /api/chat`, `POST /api/talk-chat` — Swahili/English code-switching             |
| `voice_script`| azure     | z.ai      | `generateScript()` in `src/lib/openai.ts` — Realtime opening copy                     |
| `summarize`   | azure     | z.ai      | `GET /api/intelligence/brief` — tenant-scoped brief                                   |
| `extract`     | azure     | z.ai      | `extractIndicators()`, `generateActionTag()` — post-call BCS / classification         |
| `reasoning`   | azure     | z.ai      | Multi-step / tool-use paths                                                          |
| `code`        | azure     | z.ai      | Function-calling synthesis                                                           |
| `default`     | azure     | z.ai      | Safe default for any new code path                                                   |

Env overrides:

- `LLM_PRIMARY_PROVIDER=azure|z|minimax` — change ALL primaries at once
- `LLM_FALLBACK_PROVIDER=azure|z|minimax` — change ALL fallbacks at once
- `LLM_TASK_<NAME>_PRIMARY=azure|z|minimax` — per-task override (e.g. `LLM_TASK_REASONING_PRIMARY=z`)
- `LLM_TASK_<NAME>_FALLBACK=azure|z|minimax` — per-task fallback override

### Why Azure (GPT-5 Mini) is primary today

- **Quality**: multilingual with strong Swahili/English/code-switching
  handling. Verified against a real `bula-pesa` intelligence brief.
- **JSON mode**: `response_format: { type: "json_object" }` works for
  the post-call BCS extractor schema.
- **Latency**: ~2.5 s per voice turn, ~6 s per full brief, with
  `reasoning_effort: minimal` (client sets this automatically for
  every `gpt-5*` deployment).
- **Deployment**: single Foundry resource can also host the Realtime
  voice deployment (`gpt-4o-realtime-preview`) and Whisper — reducing
  vendor sprawl.

**Why z.ai is retained as fallback**: `glm-4.5-flash` is the free
tier — zero per-token cost — and has been battle-tested for Swahili
code-switching. If the Azure Foundry quota trips or the key rotates,
every task falls through to z.ai without a route-level code change.

minimax (M3) is paid with no free tier; it's reserved for tasks where
its cost is justified (multi-step reasoning, function synthesis).

### What does NOT go through the registry

The Azure OpenAI **Realtime** WebSocket path stays hardcoded in
`src/lib/voiceStream.ts` and `src/lib/voiceStreamBrowser.ts`. The
Realtime API is a bidirectional mulaw audio bridge — it's not chat
completions, and neither z.ai nor minimax offer an equivalent product
yet. Realtime stays on Azure (or any future OpenAI Realtime
deployment) until Phase 3 (STATUS.md §5) introduces a
self-hosted VITS + Whisper pipeline.

### Observability surfaces

- `GET /api/llm/status` (trusted-origin only) — returns:
  - `routing` — which provider handles each task right now
  - `health` — live `/models` probe (5 s timeout per provider)
  - `budget` — daily token consumed / remaining per task
  - `recent_calls` — last 50 audit entries (provider / model / latency / cache / fallback)

  ```bash
  curl -H "Authorization: Bearer $TOK" -H "Origin: http://localhost:8080" \
    http://localhost:3000/api/llm/status | jq
  ```

- Per-call audit log — every LLM call emits a `llm call` log entry
  with task, provider, model, tokens, latency, cache hit, fallback
  chain, and error (if any). Default sink: pino stdout (JSON).
  Production should add a Postgres-backed `llm_calls` table per the
  schema in `src/lib/llm/audit.ts`.

- Per-route response surfaces — `/api/chat`, `/api/talk-chat`,
  `/api/intelligence/brief` all return `provider`, `model`, `cached`,
  `tokens`, `latency_ms` so the dashboard can render which model
  served each request.

- **Azure Speech status** — `GET /api/speech/status` (public) returns
  `{ configured, region, voiceSw, voiceEn }` so dashboards can show
  whether STT/TTS is live. Useful health probe from the front-end.

- **Demo voice health** — `GET /api/demo/voice/simulator` runs the
  deterministic phone-call sim: phone lookup → personalized TTS opener
  → DTMF category → 20 s recording → Azure Speech → GPT-5 Mini extract
  → RLS-scoped ground truth insert. This is the herder default and the
  fastest way to eyeball "is the deterministic pipeline OK end-to-end".
  Alias: `GET /api/demo/voice/deterministic` (older link).
- **Realtime preview** — `GET /api/demo/voice/simulator-realtime` still
  runs the WS + PCM16 duplex Azure Realtime bridge for the Phase-3
  preview. Requires an active `gpt-4o-realtime-preview` Azure
  deployment; not shown in the demo hub.
- **Herder personalization** — `GET /api/demo/voice/context?phone=+254…`
  returns the full herder context payload the sim uses (pastoralist
  profile + last report + fresh ward intelligence). Cheap to poll; no
  LLM calls involved.

### Failure semantics

- **Both providers down** for a given task → the registry throws,
  and the caller falls back to a template (voice script) or keyword
  classifier (action tag) or returns null (extraction). Calls never
  fail because of an LLM outage — the user gets a worse answer, not
  no answer.
- **Budget exceeded** → `LlmBudgetError` thrown; callers handle the
  same as provider-down (template / null).
- **Cache hit** → registry returns the cached response with
  `cached: true`; the audit entry records the hit.

## Supabase data plane

Reference data (wards, `satellite_indices`, `weather_data`, the
`api_latest_*` views, `pastoralists`, `ground_truth_calls`) is served
by Supabase as of 2026-07-08. Local Postgres is a backup mirror.
Client: `src/lib/supabase.ts` (PostgREST over `SUPABASE_URL` +
`SUPABASE_SECRET_KEY`). Every helper returns `null` on failure and
callers fall back to the local mirror.

### Health probe from the ops side

```bash
# Sanity — should return one ward row
curl -s "$SUPABASE_URL/rest/v1/wards?limit=1" \
  -H "apikey: $SUPABASE_SECRET_KEY" \
  -H "Authorization: Bearer $SUPABASE_SECRET_KEY" | jq .

# Latest satellite indices for ward 242 (Bula Pesa)
curl -s "$SUPABASE_URL/rest/v1/api_latest_satellite_indices?ward_id=eq.242" \
  -H "apikey: $SUPABASE_SECRET_KEY" | jq '.[0] | {ndvi_mean,vci,updated_at}'

# Full schema dump (tables, columns, row counts) → /tmp/supabase-report.json
python3 ardalink-api/scripts/explore-supabase.py
```

### Known-broken views (skip in clients)

- `api_latest_cell_satellite_indices` — HTTP 500
- `api_ward_cell_latest_rollup` — HTTP 500

Flagged to the Supabase project owner; the client library never calls
these two views, so the api stays green.

### Cache behavior

- Reference-table reads (`listWards`, `listActiveWards`,
  `listWardNeighbors`, `latestSatelliteFor`, `latestWeatherFor`)
  cache for `SUPABASE_CACHE_TTL_MS` (default 60 s).
- Per-phone reads (`callContextByPhone`, `pastoralistByPhone`) are
  not cached — always fresh.
- Writes (`upsertPastoralist`, `insertGroundTruthCall`) never touch
  the cache; they invalidate on next read via TTL.

### Fallback semantics

- `resolveHerderContext(phone)` returns a `HerderContext` tagged
  `source: "supabase" | "local" | "none"`. When Supabase is
  unreachable or the env vars are unset, the resolver drops to
  local-only and tags `source: "local"` — no user-visible error.
- The dual-write to `ground_truth_calls` is fire-and-forget: if
  Supabase rejects the insert, the local rich `ground_truth_reports`
  row is already committed and the call is still logged. The failure
  surfaces in `pino` logs, not in the caller's response.
- The env var `SUPABASE_URL` unset ⇒ every helper short-circuits to
  `null`, `resolveHerderContext` returns `source: "local"`, and the
  stack behaves exactly like it did pre-2026-07-08.
