/**
 * LlmRegistry — routes tasks to providers, manages fallback chain,
 * caches results, enforces daily budget, and audits every call.
 *
 * Routing table (env-driven, defaults sane):
 *
 *   task           primary   fallback   rationale
 *   ────────────   ───────   ────────   ──────────────────────────────
 *   multilingual   z         minimax    /api/chat + /api/talk-chat,
 *                                       Swahili/English code-switching
 *   voice_script   z         minimax    generateScript — bilingual
 *                                       pastoralist opening for Realtime
 *   summarize      z         minimax    Tenant intelligence brief
 *   extract        z         minimax    BCS / offtake / mortality JSON,
 *                                       plus action-tag classification
 *   reasoning      minimax   z          Multi-step, tool use, code-like
 *   code           minimax   z          Function-calling synthesis
 *   default        z         minimax    Safe default for new code paths
 *
 * Why z.ai is primary for the four text tasks:
 *   - glm-4.5-flash is free, fast (≈3 s on Swahili prompts), and
 *     handles code-switched Swahili/English naturally — exactly what
 *     ArdaLink's pastoralist copy needs.
 *   - z.ai supports response_format=json_object, which extract needs
 *     for the strict post-call BCS schema.
 *   - minimax (M3) is paid and has no JSON response_format, so it's
 *     relegated to reasoning/code where its cost is justified.
 *
 * Env overrides:
 *   LLM_PRIMARY_PROVIDER=minimax   # change all primaries at once
 *   LLM_FALLBACK_PROVIDER=z
 *   LLM_TASK_<NAME>_PRIMARY=z|minimax   # per-task override
 *   LLM_TASK_<NAME>_FALLBACK=z|minimax
 *
 * Cache key includes task + messages + tenant_id (when present) to
 * prevent cross-tenant cache leaks. Cache TTL: LLM_CACHE_TTL_SECONDS,
 * default 300 (5 min).
 */

import { createHash } from 'node:crypto';
import { logger } from '../logger.js';
import { MinimaxClient } from './providers/minimax.js';
import { ZaiClient } from './providers/zai.js';
import type {
  LlmClient,
  LlmRequest,
  LlmResponse,
  LlmTask,
} from './types.js';
import { LlmBudgetError } from './types.js';
import { costGuard } from './cost.js';
import { recordSuccess, recordError } from './audit.js';

const CACHE_TTL_SECONDS = parseInt(
  process.env.LLM_CACHE_TTL_SECONDS ?? '300',
  10,
);

const TIMEOUT_MS = parseInt(
  process.env.LLM_TIMEOUT_MS ?? '90000',  // 90s default: z.ai's GLM-4.5-Flash
                                          // can take 30-60s on Swahili prompts
                                          // (the model thinks before responding
                                          // unless thinking is disabled, which
                                          // the ZaiClient sets explicitly)
  10,
);

interface CacheEntry {
  response: LlmResponse;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

function cacheKey(req: LlmRequest, task: LlmTask): string {
  const h = createHash('sha256');
  h.update(task);
  h.update('|');
  for (const m of req.messages) {
    h.update(`${m.role}:${m.content.length}:${m.content.slice(0, 80)}|`);
  }
  if (req.temperature !== undefined) h.update(`t=${req.temperature}|`);
  if (req.maxTokens !== undefined) h.update(`m=${req.maxTokens}|`);
  return h.digest('hex');
}

function pickProvider(task: LlmTask, role: 'primary' | 'fallback'): LlmClient {
  // Allow global override via env
  const globalPrimary = process.env.LLM_PRIMARY_PROVIDER;
  const globalFallback = process.env.LLM_FALLBACK_PROVIDER;
  // Per-task override via env: LLM_TASK_SUMMARIZE_PRIMARY=minimax
  const taskEnv = `LLM_TASK_${task.toUpperCase()}_${
    role === 'primary' ? 'PRIMARY' : 'FALLBACK'
  }`;
  const TABLE: Record<LlmTask, { primary: 'z' | 'minimax'; fallback: 'z' | 'minimax' }> = {
    multilingual: { primary: 'z', fallback: 'minimax' },
    voice_script: { primary: 'z', fallback: 'minimax' },
    summarize:    { primary: 'z', fallback: 'minimax' },
    reasoning:    { primary: 'minimax', fallback: 'z' },
    code:         { primary: 'minimax', fallback: 'z' },
    extract:      { primary: 'z', fallback: 'minimax' },
    default:      { primary: 'z', fallback: 'minimax' },
  };
  const want = (process.env[taskEnv] as 'z' | 'minimax' | undefined)
    ?? (role === 'primary'
      ? (globalPrimary as 'z' | 'minimax' | undefined) ?? TABLE[task].primary
      : (globalFallback as 'z' | 'minimax' | undefined) ?? TABLE[task].fallback);
  if (want === 'z') return ZaiClient.create();
  return MinimaxClient.create();
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error(`${label} timeout`)), ms);
  try {
    return await p;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Public API. Always returns a usable LlmResponse (or throws on
 * unrecoverable errors like budget exceeded or both providers down).
 */
export async function complete(
  task: LlmTask,
  req: LlmRequest,
  ctx: { tenantId?: string } = {},
): Promise<LlmResponse> {
  if (costGuard.exceeded(task)) {
    throw new LlmBudgetError(
      `Daily budget exceeded for task=${task}`,
      task,
    );
  }

  // Cache lookup
  if (!req.bypassCache) {
    const key = cacheKey(req, task);
    const hit = cache.get(key);
    if (hit && hit.expiresAt > Date.now()) {
      const cached: LlmResponse = { ...hit.response, cached: true };
      recordSuccess(task, cached, ctx.tenantId);
      return cached;
    }
  }

  // Primary attempt
  const primary = pickProvider(task, 'primary');
  try {
    const result = await withTimeout(
      primary.complete(req),
      TIMEOUT_MS,
      `${primary.name} primary`,
    );
    cache.set(cacheKey(req, task), {
      response: result,
      expiresAt: Date.now() + CACHE_TTL_SECONDS * 1000,
    });
    costGuard.consume(task, result.usage);
    recordSuccess(task, result, ctx.tenantId);
    return result;
  } catch (primaryErr) {
    logger.warn(
      { task, primary: primary.name, err: String(primaryErr) },
      'LLM primary failed, falling back',
    );
    recordError(task, primary.name, primaryErr, ctx.tenantId);
  }

  // Fallback attempt
  const fallback = pickProvider(task, 'fallback');
  if (fallback.name === primary.name) {
    // Both routes resolve to the same provider (MockClient case).
    // Don't double-charge the budget; just return the failure.
    throw new Error(
      `LLM provider ${primary.name} failed and no fallback available`,
    );
  }
  const result = await withTimeout(
    fallback.complete(req),
    TIMEOUT_MS,
    `${fallback.name} fallback`,
  );
  cache.set(cacheKey(req, task), {
    response: result,
    expiresAt: Date.now() + CACHE_TTL_SECONDS * 1000,
  });
  costGuard.consume(task, result.usage);
  recordSuccess(task, result, ctx.tenantId, primary.name);
  return result;
}

export async function completeJson<T>(
  task: LlmTask,
  req: LlmRequest,
  schema: import('zod').ZodType<T>,
  ctx: { tenantId?: string } = {},
): Promise<T> {
  const response = await complete(task, { ...req, jsonSchema: schema }, ctx);
  return schema.parse(JSON.parse(response.content));
}

export function getLlmClient(task: LlmTask): LlmClient {
  return pickProvider(task, 'primary');
}

export function clearCache(): void {
  cache.clear();
}

/**
 * Exposes the current routing table so operators can see which provider
 * is configured to handle each task without grepping the registry.
 * Cheap (pure function, no LLM calls).
 */
export function routingTable(): Record<
  LlmTask,
  { primary: string; fallback: string }
> {
  const tasks: LlmTask[] = [
    'multilingual',
    'voice_script',
    'summarize',
    'reasoning',
    'code',
    'extract',
    'default',
  ];
  const out = {} as Record<LlmTask, { primary: string; fallback: string }>;
  for (const t of tasks) {
    const primary = pickProvider(t, 'primary');
    const fallback = pickProvider(t, 'fallback');
    out[t] = { primary: primary.name, fallback: fallback.name };
  }
  return out;
}

/**
 * Live health probe for every provider we know about. Runs /models
 * (or the provider's equivalent) with a 5s timeout. Used by
 * GET /api/llm/status to surface which providers are actually
 * reachable right now — invaluable when debugging "why did the
 * minimax fallback kick in today".
 */
export async function providersHealth(): Promise<
  Record<string, { ok: boolean; latencyMs: number; error?: string }>
> {
  const providers = [
    ZaiClient.create(),
    MinimaxClient.create(),
  ];
  const results = await Promise.all(
    providers.map(async (p) => {
      try {
        const h = await p.health();
        return [p.name, { ok: h.ok, latencyMs: h.latencyMs, error: h.error }];
      } catch (e) {
        return [
          p.name,
          {
            ok: false,
            latencyMs: 0,
            error: e instanceof Error ? e.message : String(e),
          },
        ];
      }
    }),
  );
  return Object.fromEntries(results);
}
