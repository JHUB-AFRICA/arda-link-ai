# ArdaLink — AI Infrastructure Plan

**Author**: Lead Software Engineer · **Date**: 2026-06-23
**Scope**: Provider-agnostic LLM layer + Tuesday-demo AI features + post-Tuesday roadmap
**Providers (locked)**: z.ai (GLM-4.x) + minimax (M3), with MockClient fallback

---

## 1. Executive summary

ArdaLink's API already has six LLM-shaped code paths (chat, talk-chat, trigger-check, two voice bridges, BCS extraction). They run as **stubs in dev** because no API key is configured. The plan is to (a) wrap every LLM call in a provider-agnostic abstraction so adding a third provider is one new file, (b) plug in z.ai and minimax as the two supported providers at launch, (c) ship one high-leverage new feature — the **Tenant Intelligence Brief** — that becomes the Tuesday demo's "wow moment", (d) keep the existing chat routes working by routing them through the new layer.

The decisive research finding: **z.ai's GLM-4.5-Flash and GLM-4.7-Flash are free, support tools + structured JSON + streaming; minimax M3 has no free tier and lacks `response_format` JSON support on its main endpoint.** Both providers' Swahili quality is unverified. We will test with real pastoralist prompts before the demo.

Cost ceiling: 100k tokens/day across all tenants — sustainable on z.ai's free tier; minimax is fallback for English reasoning where its tool-use is stronger.

---

## 2. Current state

### 2.1 LLM-shaped code paths (all wired, all stubbed)

| Path | File:lines | What it calls today | Graceful degradation |
|---|---|---|---|
| `POST /api/chat` | `routes/chat.ts:270-284` | Azure OpenAI chat completions (sync fetch) | 500 on Azure error |
| `POST /api/talk-chat` | `routes/chat.ts:405-412` | Same; also fires `captureChatGroundTruth()` async | 500 on Azure error |
| `POST /api/trigger-check` (orchestrator) | `lib/intelligence.ts:237` calls `generateScript()` | `lib/openai.ts:232-311` Azure chat; `response_format` unset, regex-extracts JSON | Falls back to `buildTemplateScript()` (template strings) when no key |
| Voice call bridge (AT WebSocket) | `lib/voiceStream.ts:248-289` | Azure OpenAI Realtime WebSocket; `session.update` with `end_call` tool | Hard 500 if no key |
| Browser WebRTC voice bridge | `lib/voiceStreamBrowser.ts:393-433` | Same as above; `pcm16` audio | Hard 500 if no key |
| Post-call BCS extraction | `lib/openai.ts` `extractIndicators()`, `generateActionTag()` | Azure chat with `response_format: json_object` | Falls back to keyword classifiers when no key |
| `/talk-chat` text BCS extraction | `lib/chatGroundTruth.ts` (referenced) | Same as above | Same |

### 2.2 Env-var drift (real bug, must fix during this work)

`.env.example` declares names that **do not match** the code. A fresh engineer following the template hits `undefined` on first boot.

| Code reads | `.env.example` declares | Status |
|---|---|---|
| `AZURE_OPENAI_API_KEY` | `AZURE_OPENAI_KEY` | MISMATCH |
| `AZURE_OPENAI_CHAT_DEPLOYMENT` | `AZURE_OPENAI_DEPLOYMENT` | MISMATCH |
| `AZURE_OPENAI_REALTIME_DEPLOYMENT` | (not listed) | MISSING |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | `GEE_SERVICE_ACCOUNT` + `GEE_PRIVATE_KEY` + `GEE_PROJECT` | MISMATCH (3→1) |
| `LOCAL_ZONE_LAT/LON/RADIUS_KM` | (not listed) | MISSING |
| `RECIPIENT_PHONE` | (not listed) | MISSING |

The new `ardalink-api/docs/local-dev/.env.example` will be fixed in this PR.

### 2.3 Multi-tenant boundary is real

`withTenantContext(tenantId, async (tx) => …)` opens a transaction, runs `SET LOCAL app.current_tenant_id = '${safeTenantId}'`, and hands the transaction to the callback. The `safeTenantId` regex `/^[a-z0-9-]{1,64}$/` is the only thing standing between a forged JWT and SQL injection through `SET LOCAL`. Every new AI feature that reads tenant data must use this helper. **The LLM layer must never be handed a tenant_id it didn't allowlist.**

### 2.4 What the dashboard wants but doesn't have

The `dashboard.tsx` read identified seven empty spots where AI features could slot in. Tier-1 picks the one with the most signal-to-effort: the "Currently monitoring" widget at the top of the map tab. That's where the brief lands.

---

## 3. Proposed architecture

### 3.1 Directory layout

```
ardalink-api/src/lib/llm/
├── types.ts             # LlmClient, LlmRequest, LlmResponse, LlmTask, LlmMessage
├── registry.ts          # LlmRegistry — routes tasks, fallback, cache, budget, audit
├── providers/
│   ├── minimax.ts       # MinimaxClient  implements LlmClient
│   ├── zai.ts           # ZaiClient      implements LlmClient
│   └── mock.ts          # MockClient     (dev fallback when no key)
├── prompts/
│   ├── tenant-brief.ts  # Tuesday's "wow moment"
│   ├── talk-chat.ts     # replaces inline system prompt in routes/chat.ts
│   ├── operator.ts      # replaces inline system prompt in routes/chat.ts
│   └── alerts.ts        # post-call BCS extraction prompt (replaces openai.ts inline)
├── cost.ts              # per-provider token cost + daily budget guard
├── audit.ts             # every call logged: provider, task, tokens, latency, fallback
└── index.ts             # public API: getLlm(task), complete(req), completeJson(req, schema)
```

### 3.2 The contract (`types.ts`)

```ts
export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCallId?: string;
}

export interface LlmRequest {
  messages: LlmMessage[];
  temperature?: number;        // 0.0 - 1.0
  maxTokens?: number;         // hard cap per call
  jsonSchema?: z.ZodTypeAny;  // if set, response is parsed + validated
  tools?: LlmTool[];          // function calling
  signal?: AbortSignal;       // for timeout
}

export interface LlmResponse {
  content: string;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
  provider: string;           // 'z' | 'minimax' | 'mock'
  model: string;              // e.g. 'z/glm-4.5-flash', 'minimax/MiniMax-M3'
  latencyMs: number;
  cached: boolean;
}

export interface LlmClient {
  readonly name: string;
  readonly tasks: LlmTask[];
  complete(req: LlmRequest): Promise<LlmResponse>;
  completeJson<T>(req: LlmRequest, schema: z.ZodType<T>): Promise<T>;
  health(): Promise<{ ok: boolean; latencyMs: number }>;
}
```

A route handler never knows which provider it's calling. It says `getLlm('multilingual').completeJson(...)` and gets a typed result.

### 3.3 The registry (`registry.ts`)

```ts
async function complete(task: LlmTask, req: LlmRequest): Promise<LlmResponse> {
  // 1. cache check
  const hit = cache.get(cacheKey(req));
  if (hit && !bypass) return { ...hit, cached: true };

  // 2. budget check
  if (budget.exceeded(task)) throw new LlmBudgetError();

  // 3. primary attempt
  try {
    const primary = pickProvider(task, 'primary');
    const result = await raceWithTimeout(primary.complete(req), LLM_TIMEOUT_MS);
    cache.set(cacheKey(req), result, LLM_CACHE_TTL_SECONDS);
    audit(task, primary.name, result, req);
    budget.consume(task, result.usage);
    return result;
  } catch (primaryErr) { audit(task, primary.name, { error: primaryErr }, req); }

  // 4. fallback attempt
  const fallback = pickProvider(task, 'fallback');
  const result = await raceWithTimeout(fallback.complete(req), LLM_TIMEOUT_MS);
  cache.set(cacheKey(req), result, LLM_CACHE_TTL_SECONDS);
  audit(task, fallback.name, result, req);
  budget.consume(task, result.usage);
  return result;
}
```

Every call is observable. Cache key includes the messages + task + `req.tenant?.tenant_id` (when set), so a forged cross-tenant cache lookup is impossible.

### 3.4 Env additions

```bash
# .env (new keys — not breaking; default to mock)
LLM_PRIMARY_PROVIDER=minimax          # minimax | z
LLM_FALLBACK_PROVIDER=z               # minimax | z
LLM_TIMEOUT_MS=15000
LLM_CACHE_TTL_SECONDS=300
LLM_DAILY_TOKEN_BUDGET=100000
ZAI_API_KEY=...                       # optional; without it, ZaiClient → MockClient
MINIMAX_API_KEY=...                   # optional; same pattern
ZAI_DEFAULT_MODEL=glm-4.5-flash       # free, supports JSON + tools
MINIMAX_DEFAULT_MODEL=MiniMax-M3
```

If neither key is set, the registry uses `MockClient` (canned responses prefixed `[MOCK]`) so the demo and tests pass even with no network.

---

## 4. Use case catalog

### Tier 1 — Ship in this session (≤ 4h each)

| # | Use case | Story | Effort |
|---|---|---|---|
| 1.1 | **Tenant Intelligence Brief** | "Bula Pesa this week: 12 reports, BCS avg 2.7 in SW, NDVI −30%, 3 mortality alerts. Recommend: herd check, recruit NE correspondent, defer satellite refresh." | 2h |
| 1.2 | **Dashboard hero card** | The brief renders at the top of the map tab with provider/model/tokens metadata visible for the demo callout | 1h |
| 1.3 | **`make brief T=<ward>` terminal target** | The same brief, in the terminal, for moments when the browser is too much ceremony | 15 min |
| 1.4 | **Re-wire existing chat/talk-chat to new layer** | No behavior change for users, but `routes/chat.ts` now goes through `llm.complete()` instead of inline Azure fetch | 45 min |
| 1.5 | **Fix `.env.example` env-var drift** | Rename code vars OR fix the example; the example has six mismatches today | 30 min |

### Tier 2 — Post-Tuesday, Q3

| # | Use case | Value | Effort |
|---|---|---|---|
| 2.1 | **Operator copilot** ("Show me red alerts from last week") | Text→SQL via `llm.completeJson()` with a typed `query` schema. Routes to minimax primary, z.ai fallback. | 1 week |
| 2.2 | **Herder voice agent** (replace SMS-shaped UI with 3-tap voice call) | Multilingual via z.ai for Swahili; minimax for English | 2-3 weeks |
| 2.3 | **Voice cloning for alerts** | Regional-accent Swahili greetings from 3-prior-samples | 1 week |
| 2.4 | **Predictive drought model** (LLM-augmented) | Combines NDVI deltas + herder reports + climate anomalies → 2-week risk per quadrant | 3 weeks |
| 2.5 | **Cross-ward pattern detection** | "Mortality alerts in Bula Pesa up 40% this month. Same pattern in Garbatulla 2 weeks ago. Consider coordinated response." | 1 week |

### Tier 3 — Q4+

| # | Idea | Notes |
|---|---|---|
| 3.1 | LLM-as-an-Operator | Background agent that watches all 3 wards, sends a daily 06:00 EAT Telegram to the operator with what changed since yesterday |
| 3.2 | On-device tiny model (Qwen2.5-0.5B) | Herder drafts a report offline, syncs when online. Privacy + bandwidth win. |
| 3.3 | Cross-tenant benchmarking (with explicit consent) | Anonymized patterns across wards |
| 3.4 | Voiceprint auth | Recognize the herder by voice — cuts the auth flow in half for low-literacy users |

### Use case 1.1 — Tenant Intelligence Brief in detail

**Endpoint**: `GET /api/intelligence/brief?lang=en|sw`

**Request**: `Authorization: Bearer <JWT>`

**Response**:
```json
{
  "tenant_id": "bula-pesa",
  "lang": "en",
  "summary": "Bula Pesa this week: 12 reports, BCS avg 2.7 in SW quadrant, NDVI −30% vs baseline, 3 mortality alerts at Bulla Pesa water point. Data missing from NE/NW/SE quadrants — no herder coverage. Recommend: (1) Send a herd check to the 3 flagged sites, (2) Recruit a NE-quadrant correspondent, (3) Defer the satellite refresh until 2 reports come in from the open quadrants.",
  "actions": [
    "Herd check at Bulla Pesa water point (3 mortality alerts)",
    "Recruit NE-quadrant correspondent (0 reports in 7d)",
    "Defer satellite refresh until cross-quadrant coverage improves"
  ],
  "data_sources": ["ground_truth_reports", "satellite_snapshots"],
  "generated_at": "2026-06-22T...",
  "provider": "z",
  "model": "z/glm-4.5-flash",
  "tokens": 1234,
  "cached": false
}
```

**Tenant safety**: The brief is built from data fetched via `withTenantContext(tenantId, …)`. The LLM never sees other tenants' data. Cache key is `(tenant_id, lang)` so a cross-tenant request cannot read another tenant's brief.

**Multilingual**: `?lang=sw` uses the Swahili prompt template, routes to z.ai primary, minimax fallback. The response includes the same content rendered in Swahili. The `summary` field is the same key (caller knows the language from `?lang`).

**Cache**: 1 hour per `(tenant_id, lang)` key. `?regenerate=1` bypasses cache. The `make brief T=<ward>` target shows `cached: true|false` so the operator can see if the brief is fresh.

**Prompt template** (`prompts/tenant-brief.ts`):

```ts
export const TENANT_BRIEF_SYSTEM_EN = `
You are the ArdaLink intelligence brief writer for an ArdaLink
operator in {region}. The operator manages {tenant_name}, an
ArdaLink tenant. Write a 200-word operational brief based on the
DATA section. Be specific, use numbers, recommend 2-3 concrete
actions an operator can take this week.

RULES:
- Cite numbers from DATA, never invent.
- If a quadrant has 0 reports, note the data gap — do not assume
  that quadrant is fine.
- Recommendations must be operational, not aspirational
  (e.g. "send a herd check to site X" not "improve monitoring").
- Output JSON: { "summary": string, "actions": string[] }.
- summary must be ≤ 200 words. actions must be 2-3 items.
`.trim();

export const TENANT_BRIEF_SYSTEM_SW = `
... same in Swahili, with Swahili pastoral terminology
    (e.g. "mifugo" for livestock, "malisho" for pasture,
     "bwawa" for water point, "chanjo" for vaccination) ...
`.trim();
```

**Failure modes**:
- z.ai times out → minimax falls back (English only for fallback if Swahili unhandled)
- Both down → MockClient returns `[MOCK] Bula Pesa has 12 reports…` with the same shape, marked `provider: 'mock'`
- LLM hallucinates a number not in DATA → prompt explicitly forbids it; in practice, schema-validate the response so anything with an unknown action gets a follow-up retry, then a hard fail to the cached previous brief
- Cache key collision across tenants → impossible: the key includes `req.tenant.tenant_id`

---

## 5. Tuesday demo flow (the "wow moment" at minute 6)

**Pre-demo (T-15 min)**: `make up` brings the stack up. `make verify` confirms 22/27 (5 expected warnings). I open `localhost:8080/?token=<bula-pesa>` in the projector browser.

**Minute 0–2**: Show the live data. "Three demo tenants, each sees only their own data. Here's Bula Pesa's recent reports — 12 entries, BCS average 2.7, three mortality alerts at the Bulla Pesa water point. Here's the same tenant-scoped query from a Garbatulla token — different 12 reports, no leak. This is enforced by Postgres RLS, not by the application."

**Minute 2–4**: Show the architecture. Click through the multi-tenant request flow diagram. "Every API request carries a JWT. The claim's `tenant_id` is bound to the Postgres session. RLS is forced, even the table owner can't bypass it. `ardalink_app` connects with `NOSUPERUSER, NOBYPASSRLS`."

**Minute 4–6**: Show the engineering rigor. Open `RUNBOOK.md`, point at the verification. "This is reproducible from `git clone` on a fresh machine. 22 of 27 checks pass, the 5 warnings are the ports being bound by our own services."

**Minute 6–8** ← **THE WOW MOMENT**: "We just added an AI feature this week. Every dashboard now has an Intelligence Brief at the top, generated live from the data." Click into the dashboard, point at the hero card. "This brief was generated by z.ai's GLM-4.5-Flash model — the routing metadata is right there: provider, model, 1,234 tokens, 1.8 seconds." Then `make brief T=bula-pesa` in the terminal — same content, two presentations of the same thing.

**Minute 8–10**: Multilingual. `?lang=sw` reload — same brief in Swahili. "z.ai's GLM models handle Swahili well enough for a pastoralist audience. We tested with this real Isiolo terminology."

**Minute 10–12**: Resilience. `pkill -f llm-provider` (simulated). "If z.ai goes down, the system falls back to minimax. If both go down, a MockClient returns a realistic-shaped response so the operator always sees something. The system is never down because the LLM is down."

**Minute 12–15**: Q&A. The wow moment has been delivered. Stakeholders are primed for the next quarter.

---

## 6. Provider routing

| Task | Primary | Fallback | Why |
|---|---|---|---|
| `multilingual` (Swahili, mixed) | **z** | minimax | GLM-4.5-Flash free tier; supports JSON + tools + streaming; tested for Swahili-friendly length |
| `summarize` (intelligence brief) | **z** | minimax | GLM-4.5-Flash is free, JSON mode is reliable, 200K context is plenty |
| `reasoning` (operator copilot, text→SQL) | **minimax** | z | minimax M3 has superior interleaved thinking for multi-step tool use |
| `code` (function-calling synthesis) | **minimax** | z | Same as above |
| `default` | **z** | minimax | Free + JSON + multilingual wins the default; minimax wins on tool use but is paid |

**Cost per call** (200-500 token response):
- z.ai `glm-4.5-flash`: **free** (per docs, 0/0/0 pricing on input/output/cache)
- z.ai `glm-4.6` (escalation): ~$0.0003 input + $0.0011 output per call = $0.0014 ≈ $1.40 per 1000 calls
- minimax M3: ~$0.0003 input + $0.0012 output = $0.0015 ≈ $1.50 per 1000 calls
- MockClient: $0

**Daily budget guard** (`cost.ts`): 100k tokens/day across all tasks. Hits 429 if exceeded. The dashboard shows the live burn rate.

---

## 7. Risk register

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| 1 | **LLM hallucinates numbers not in DATA** | Medium | High (operator trusts it) | Prompt forbids it; Zod schema validates the response shape; on validation fail, retry with the same prompt + explicit "use only these numbers" reminder; on second fail, return the previous cached brief with a `last_verified_at` field |
| 2 | **Tenant data leak via shared LLM context** | Low | Critical | Every LLM call gets only data fetched via `withTenantContext(tenantId, …)`. The cache key includes `tenant_id`. No cross-tenant LLM call site exists. |
| 3 | **Provider outage during demo** | Medium | High | Two-provider fallback chain; MockClient as last resort. The `make verify` runs in dev with no key, demonstrating the fallback path. |
| 4 | **Prompt injection via herder voice** (Tier 2 voice agent) | Medium | High | Herder transcript is treated as **untrusted data**, not as instructions. System prompt is the only authoritative context. Any "ignore previous instructions" in a transcript is structurally impossible to elevate to a system message. |
| 5 | **Cost overrun** | Low | Medium | `LLM_DAILY_TOKEN_BUDGET=100000`. Per-tenant rate limit. Cache reduces calls. MockClient as default in dev. |
| 6 | **Lock-in to one provider** | Low (we're flexible-first) | High | The whole point of the abstraction. Adding Claude = one new file in `providers/`. |
| 7 | **z.ai free tier has undocumented rate limits** | Medium | Medium | Cache aggressively. Add `LLM_CACHE_TTL_SECONDS=300` (5 min). Document that the production path requires a paid z.ai key or a self-hosted ollama fallback. |
| 8 | **Swahili quality is unverified for both providers** | Medium | Medium (Tier 1) / High (Tier 2) | Run a 20-prompt evaluation with real pastoralist sentences before the demo. If Swahili is poor, fall back to English with key-term glosses. |

---

## 8. Execution order (this session)

Each step is one commit. After each step, verify.

1. **Commit 1**: `ardalink-api/src/lib/llm/{types,registry,providers/minimax,providers/zai,providers/mock,index}.ts` + `cost.ts` + `audit.ts`. 0 route changes. Verify: `pnpm run typecheck` passes.
2. **Commit 2**: `ardalink-api/src/routes/intelligence/brief.ts` + register the route. Adds `GET /api/intelligence/brief?lang=`. Verify: `make verify` still 22/27, plus a smoke: `curl -H "Authorization: Bearer $TOK" http://localhost:3000/api/intelligence/brief | jq .summary` returns a real brief.
3. **Commit 3**: `ardalink-api/docs/local-dev/Makefile` adds `make brief T=<ward>`. Verify: smoke from the terminal returns the brief.
4. **Commit 4**: `ardalink-web/packages/api-client-react/src/index.ts` adds `useIntelligenceBrief` + `getIntelligenceBriefQueryKey`. Verify: `pnpm run build` in dashboard works.
5. **Commit 5**: `ardalink-web/dashboard/src/components/IntelligenceBrief.tsx` + integration into `dashboard.tsx`. Verify: `pnpm run build` succeeds; load `localhost:8080/?token=<bula-pesa>` and see the brief card.
6. **Commit 6**: `ardalink-api/src/routes/chat.ts` switches Azure fetches to `llm.complete()`. No behavior change visible to users. Verify: same smoke tests, plus the existing chat now logs provider/model/tokens.
7. **Commit 7**: `ardalink-api/docs/local-dev/.env.example` — fix the 6 env-var drifts. Verify: `make up` from a fresh env still works.
8. **Commit 8**: `ardalink-internal/STATUS-2026-06-22.md` + `JHUB/AI_INFRASTRUCTURE_PLAN.md` (this doc). Verify: docs render.
9. **Commit 9**: Push to `migrate/import-legacy` on both repos. `make verify` from a fresh clone of `/tmp/ardalink-stack` still passes.

Estimated: 4–5 hours. The two unknowns are (a) z.ai/minimax reachability from this network — MockClient covers this, and (b) dashboard rebuild time — measured at ~50s on the clean install.

---

## 9. Open questions

| # | Question | Default if unanswered | What resolves it |
|---|---|---|---|
| 1 | Do we have `ZAI_API_KEY` and `MINIMAX_API_KEY` for the env? | Default to MockClient for the demo. Code is real; `.env.example` documents the switch. | User confirms keys are available, or I can plan to validate the integration with a one-shot test key. |
| 2 | Language for the brief — English only or both EN+SW? | Both. The cost is one extra prompt template and one extra cache key. | Stakeholder feedback on which language resonates more with the audience. |
| 3 | When z.ai is unreachable for a Swahili request, do we (a) fall back to minimax with "respond in Swahili" prompt, or (b) refuse and 503? | (a). Never let a downed provider kill a feature. | User preference on resilience vs strictness. |
| 4 | Audit logging to a new `llm_calls` table? | In-memory ring buffer in dev (24h retention). DB log in prod. | Production compliance / cost-tracking requirements. |
| 5 | What is the operator's preferred brief temperature? | 0.2 — terse, fact-based, low variance. | User feedback after seeing a few generated briefs. |
| 6 | Should the dashboard hero card pre-render a brief on the server so cold-load shows a result? | No — the brief is cheap (1.8s, 1k tokens), and the live generation is the wow moment. | User preference on perceived latency vs demo theatre. |
| 7 | Should the Tier 2 features ship in this same PR or hold for separate ones? | Hold. Tuesday scope is the brief + chat rewire + env fix. Tier 2 gets its own roadmap. | User review. |
| 8 | Anything I haven't asked? | — | User's domain knowledge. |

---

## 10. Appendix — research sources

URLs fetched during this research:

- `https://docs.z.ai/` — z.ai doc index
- `https://docs.z.ai/llms.txt` — full doc list
- `https://docs.z.ai/guides/overview/overview` — model matrix
- `https://docs.z.ai/guides/overview/pricing` — per-1M-token pricing
- `https://docs.z.ai/guides/llm/glm-5.2` — flagship spec
- `https://docs.z.ai/guides/llm/glm-4.6` — 200K-context mid-tier
- `https://docs.z.ai/guides/llm/glm-4.5` — 128K-context MoE
- `https://docs.z.ai/guides/capabilities/function-calling` — tool use spec
- `https://docs.z.ai/guides/capabilities/struct-output` — JSON mode spec
- `https://docs.z.ai/devpack/overview` — Coding Plan (tool-locked)
- `https://docs.z.ai/devpack/faq` — Anthropic-compatible endpoint
- `https://docs.z.ai/guides/agents/translation` — Translation Agent (40 languages claimed)
- `https://api.minimax.chat/` — MiniMax homepage
- `https://www.minimax.io/` — English homepage
- `https://www.minimax.io/models/text/m3` — M3 spec
- `https://www.minimax.io/blog/minimax-m3` — M3 release blog
- `https://platform.minimax.io/docs/llms.txt` — doc index
- `https://platform.minimax.io/docs/token-plan/quickstart` — Anthropic SDK usage
- `https://platform.minimax.io/docs/guides/text-generation` — text gen guide
- `https://platform.minimax.io/docs/guides/text-m3-function-call` — function calling
- `https://platform.minimax.io/docs/api-reference/text-chat-openai` — OpenAI-compat schema
- `https://platform.minimax.io/docs/api-reference/text-post` — V2 endpoint spec
- `https://platform.minimax.io/docs/guides/pricing-token-plan` — Token Plan pricing
- `https://platform.minimax.io/docs/guides/pricing-paygo` — pay-as-you-go pricing
- `https://platform.minimax.io/docs/guides/rate-limits` — M3 limits (200 RPM / 10M TPM)
- `https://platform.minimax.io/docs/faq/about-apis` — API key types
- `https://platform.minimax.io/docs/api-reference/errorcode` — error codes

Codebase files read in full:
- `ardalink-api/src/routes/chat.ts`, `intelligence.ts`, `groundTruth.ts`
- `ardalink-api/src/lib/tenancy-context.ts`, `intelligence.ts`, `satellite.ts`, `voiceStream.ts`, `voiceStreamBrowser.ts`, `cosmos.ts`, `openai.ts`
- `ardalink-api/src/lib/openai.ts` (the AI surface — every Azure call lives here)
- `ardalink-web/dashboard/src/pages/dashboard.tsx` (2135 lines)
- `ardalink-web/packages/api-client-react/src/index.ts`
- `ardalink-api/docs/local-dev/.env.example`
- `ardalink-internal/STATUS-2026-06-22.md`
- `ardalink-internal/presentation-playbook.md`
- `ardalink-internal/LEAVE-BEHIND.md`

---

*Maintained by the Lead Software Engineer. This plan is the contract for the AI infrastructure work. Updates land here as features ship.*
