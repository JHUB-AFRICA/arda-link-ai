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

### Routing table (env-overridable)

| Task          | Primary   | Fallback  | Used by                                                                              |
|---------------|-----------|-----------|--------------------------------------------------------------------------------------|
| `multilingual`| z.ai      | minimax   | `POST /api/chat`, `POST /api/talk-chat` — Swahili/English code-switching             |
| `voice_script`| z.ai      | minimax   | `generateScript()` in `src/lib/openai.ts` — Realtime opening copy                     |
| `summarize`   | z.ai      | minimax   | `GET /api/intelligence/brief` — tenant-scoped brief                                   |
| `extract`     | z.ai      | minimax   | `extractIndicators()`, `generateActionTag()` — post-call BCS / classification         |
| `reasoning`   | minimax   | z.ai      | Multi-step / tool-use paths                                                          |
| `code`        | minimax   | z.ai      | Function-calling synthesis                                                           |
| `default`     | z.ai      | minimax   | Safe default for any new code path                                                   |

Env overrides:

- `LLM_PRIMARY_PROVIDER=z|minimax` — change ALL primaries at once
- `LLM_FALLBACK_PROVIDER=z|minimax` — change ALL fallbacks at once
- `LLM_TASK_<NAME>_PRIMARY=z|minimax` — per-task override (e.g. `LLM_TASK_REASONING_PRIMARY=z`)
- `LLM_TASK_<NAME>_FALLBACK=z|minimax` — per-task fallback override

### Why z.ai is primary for the four text tasks

- **Free**: `glm-4.5-flash` is the free tier — zero per-token cost.
- **Swahili**: native handling of Swahili / English / Borana-flavoured
  Swahili code-switching, which is what every pastoralist surface needs.
- **JSON mode**: `response_format: { type: "json_object" }` works
  correctly for the post-call BCS extractor schema.
- **Latency**: ~3 s on a Swahili prompt (with `thinking: disabled`),
  vs minimax M3's 15–30 s without thinking controls.

minimax (M3) is paid with no free tier; it's reserved for tasks where
its cost is justified (multi-step reasoning, function synthesis).

### What does NOT go through the registry

The Azure OpenAI **Realtime** WebSocket path stays hardcoded in
`src/lib/voiceStream.ts` and `src/lib/voiceStreamBrowser.ts`. The
Realtime API is a bidirectional mulaw audio bridge — it's not chat
completions, and neither z.ai nor minimax offer an equivalent product
yet. Realtime stays on Azure (or any future OpenAI Realtime
deployment) until Phase 3 (ARCHITECTURE-V2 §5.3) introduces a
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
