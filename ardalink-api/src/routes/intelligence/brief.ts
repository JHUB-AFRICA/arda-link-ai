import { Router, type IRouter, type Request } from "express";
import { z } from "zod";
import { completeJson } from "../../lib/llm/index.js";
import { logger } from "../../lib/logger.js";
import {
  buildBriefSystemPrompt,
  type BriefData,
} from "../../lib/llm/prompts/tenant-brief.js";
import {
  isSupabaseConfigured,
  recentGroundTruthCalls,
  type SbGroundTruthCallRead,
} from "../../lib/supabase/index.js";

const router: IRouter = Router();

function requireTenant(req: Request): string {
  const tenantId = req.tenant?.tenant_id;
  if (!tenantId) {
    throw new Error("tenant_id missing from request context");
  }
  return tenantId;
}

/**
 * Parse the LLM response content as JSON, tolerating trailing prose
 * or markdown code fences. Returns the first valid JSON object that
 * validates against the schema. Falls back to a synthetic safe value
 * if nothing parses — the operator always gets a usable brief.
 */
function parseLooseJson<T>(
  raw: string,
  schema: { parse: (s: unknown) => T },
): T {
  // 1. Try direct parse
  try {
    return schema.parse(JSON.parse(raw));
  } catch {
    // fall through
  }
  // 2. Strip markdown fences
  const stripped = raw
    .replace(/^```(?:json)?\s*\n?/m, "")
    .replace(/\n?```\s*$/m, "")
    .trim();
  try {
    return schema.parse(JSON.parse(stripped));
  } catch {
    // fall through
  }
  // 3. Extract the first {...} block
  const match = raw.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      return schema.parse(JSON.parse(match[0]));
    } catch {
      // fall through
    }
  }
  // 4. Last resort: synthetic safe value
  return schema.parse({
    summary: `Brief generation returned non-JSON. Raw response: ${raw.slice(0, 200)}`,
    actions: [
      "Verify the LLM provider is returning JSON in the expected format",
      "Re-run with ?regenerate=1 to retry",
    ],
  });
}

const briefResponseSchema = z.object({
  summary: z.string().max(2000),
  actions: z.array(z.string()).min(2).max(3),
});

type BriefResponse = z.infer<typeof briefResponseSchema>;

/**
 * GET /api/intelligence/brief?lang=en|sw&regenerate=1
 *
 * Tenant-scoped intelligence brief generated from Supabase ground_truth_calls.
 * Fields not available on ground_truth_calls (ndviVsBaseline, quadrant
 * breakdown, completeness) are omitted or set to zero/empty.
 */
router.get("/intelligence/brief", async (req, res): Promise<void> => {
  try {
    const tenantId = requireTenant(req);
    const langRaw = String(req.query.lang ?? "en").toLowerCase();
    const lang: "en" | "sw" = langRaw === "sw" ? "sw" : "en";
    const bypassCache = req.query.regenerate === "1";

    // ── 1. Fetch data from Supabase ──────────────────────────────────
    const rows: SbGroundTruthCallRead[] = isSupabaseConfigured()
      ? ((await recentGroundTruthCalls(500)) ?? [])
      : [];

    const now = Date.now();
    const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
    const fourteenDaysAgo = now - 14 * 24 * 60 * 60 * 1000;

    const totalReports = rows.length;
    const reportsLast7Days = rows.filter(
      (r) => new Date(r.created_at).getTime() >= sevenDaysAgo,
    ).length;

    // No dataCompletenessPercent on ground_truth_calls
    const averageCompletenessPercent = 0;
    // No bcsFlagFollowup on ground_truth_calls
    const bcsFollowupCount = 0;

    // No reportedQuadrant on ground_truth_calls — return empty quadrant breakdown.
    const byQuadrant = (["NW", "NE", "SW", "SE"] as const).map((q) => ({
      quadrant: q,
      reportCount: 0,
      bcsAverage: null,
      ndviAverage: null,
    }));

    // Alerts (last 14 days)
    const recentForAlerts = rows.filter(
      (r) => new Date(r.created_at).getTime() >= fourteenDaysAgo,
    );
    const alerts: BriefData["alerts"] = [];
    for (const r of recentForAlerts) {
      if (r.bcs_score != null && r.bcs_score <= 2) {
        alerts.push({
          id: 0, // no integer id on Supabase rows
          severity: "red",
          kind: "bcs_critical",
          message: `Animals reported emaciated (BCS ${r.bcs_score.toFixed(1)})`,
          location: null,
          quadrant: null,
        });
      }
      // mortality_rate on Supabase is a proportion; >= 0.1 maps to "4-plus"
      if (r.mortality_rate != null && r.mortality_rate >= 0.1) {
        alerts.push({
          id: 0,
          severity: "red",
          kind: "mortality_critical",
          message: "4+ animal deaths reported in the last 2 weeks",
          location: null,
          quadrant: null,
        });
      }
      if (
        r.water_point_status === "not_operational" ||
        r.water_point_status === "dry"
      ) {
        alerts.push({
          id: 0,
          severity: "yellow",
          kind: "water_point_broken",
          message: `Water point — ${r.water_point_status === "dry" ? "dry" : "not operational"}`,
          location: null,
          quadrant: null,
        });
      }
    }

    const briefData: BriefData = {
      tenant_id: tenantId,
      display_name: tenantId,
      region: "Isiolo County",
      totalReports,
      reportsLast7Days,
      averageCompletenessPercent,
      bcsFollowupCount,
      byQuadrant,
      alerts,
    };

    // ── 2. Generate brief via LLM layer ─────────────────────────────
    const systemPrompt = buildBriefSystemPrompt(briefData, lang);
    const { complete } = await import("../../lib/llm/index.js");
    const response = await complete(
      "summarize",
      {
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: "Generate the brief." },
        ],
        temperature: 0.2,
        maxTokens: 800,
        bypassCache,
      },
      { tenantId },
    );
    const parsed = parseLooseJson<BriefResponse>(response.content, briefResponseSchema);

    // ── 3. Respond ──────────────────────────────────────────────────
    res.json({
      tenant_id: tenantId,
      lang,
      summary: parsed.summary,
      actions: parsed.actions,
      data_sources: ["ground_truth_calls", "tenants"],
      generated_at: new Date().toISOString(),
      provider: response.provider,
      model: response.model,
      cached: response.cached,
      tokens: response.usage.totalTokens,
      latency_ms: response.latencyMs,
    });
  } catch (err: unknown) {
    req.log.error({ err }, "Failed to generate intelligence brief");
    res.status(500).json({ error: "Failed to generate brief" });
  }
});

export default router;
