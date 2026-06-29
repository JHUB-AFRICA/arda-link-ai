import { Router, type IRouter } from "express";
import {
  routingTable,
  providersHealth,
  costGuard,
  recentCalls,
} from "../lib/llm/index.js";
import { requireTrustedOrigin } from "../lib/originGuard.js";

/**
 * GET /api/llm/status
 *
 * Surfaces the current LLM layer state to the operator dashboard:
 *   - routing table — which provider is configured to handle each task
 *   - provider health — live /models probe (5s timeout per provider)
 *   - daily token budget — consumed + remaining per task
 *   - recent calls — last 50 audit entries (provider/model/latency/cache)
 *
 * Why trusted-origin only: this surface reveals env-derived config
 * (which provider is wired up, latency budgets, etc.) that we don't
 * want scrapers / competitors pulling in bulk. The dashboard is the
 * only first-party caller; if you need to expose it more broadly,
 * drop the requireTrustedOrigin middleware.
 */
const router: IRouter = Router();

const MAX_RECENT = 50;

router.get("/llm/status", requireTrustedOrigin, async (_req, res) => {
  const [health, table, budget, recent] = await Promise.all([
    providersHealth().catch((e) => ({
      _error: e instanceof Error ? e.message : String(e),
    })),
    Promise.resolve(routingTable()),
    Promise.resolve(costGuard.summary()),
    Promise.resolve(recentCalls().slice(-MAX_RECENT).reverse()),
  ]);

  res.json({
    routing: table,
    health,
    budget,
    recent_calls: recent.map((c) => ({
      timestamp: new Date(c.timestamp).toISOString(),
      task: c.task,
      tenantId: c.tenantId ?? null,
      provider: c.provider,
      model: c.model,
      tokens: c.totalTokens,
      latencyMs: c.latencyMs,
      cached: c.cached,
      fallbackFrom: c.fallbackFrom ?? null,
      error: c.error ?? null,
    })),
  });
});

export default router;
