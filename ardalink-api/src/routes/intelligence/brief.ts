import { Router, type IRouter, type Request } from "express";
import { desc } from "drizzle-orm";
import { z } from "zod";
import { groundTruthReportsTable } from "@workspace/db";
import { withTenantContext } from "../../lib/tenancy-context.js";
import { completeJson } from "../../lib/llm/index.js";
import { logger } from "../../lib/logger.js";
import {
  buildBriefSystemPrompt,
  type BriefData,
} from "../../lib/llm/prompts/tenant-brief.js";

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

const QUADRANTS = ["NW", "NE", "SW", "SE"] as const;

const briefResponseSchema = z.object({
  summary: z.string().max(2000),
  actions: z.array(z.string()).min(2).max(3),
});

type BriefResponse = z.infer<typeof briefResponseSchema>;

/**
 * GET /api/intelligence/brief?lang=en|sw&regenerate=1
 *
 * Tenant-scoped intelligence brief generated live from
 * ground_truth_reports via the LLM layer. Cache: 1 hour per
 * (tenant_id, lang). Tenant safety: the LLM only ever sees
 * data fetched inside withTenantContext(tenantId, …) — no
 * cross-tenant data, no shared cache, no shared context.
 */
router.get("/intelligence/brief", async (req, res): Promise<void> => {
  try {
    const tenantId = requireTenant(req);
    const langRaw = String(req.query.lang ?? "en").toLowerCase();
    const lang: "en" | "sw" = langRaw === "sw" ? "sw" : "en";
    const bypassCache = req.query.regenerate === "1";

    // ── 1. Fetch tenant-scoped data ───────────────────────────────────
    const data = await withTenantContext(tenantId, async (tx) => {
      // Last 90 days of reports for the brief
      const rows = await tx
        .select()
        .from(groundTruthReportsTable)
        .orderBy(desc(groundTruthReportsTable.createdAt))
        .limit(500);

      const now = Date.now();
      const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
      const fourteenDaysAgo = now - 14 * 24 * 60 * 60 * 1000;

      const totalReports = rows.length;
      const reportsLast7Days = rows.filter(
        (r) => r.createdAt.getTime() >= sevenDaysAgo,
      ).length;

      const completenessSamples = rows
        .map((r) => r.dataCompletenessPercent)
        .filter((v): v is number => v != null);
      const averageCompletenessPercent = completenessSamples.length
        ? Math.round(
            completenessSamples.reduce((a, b) => a + b, 0) /
              completenessSamples.length,
          )
        : 0;

      const bcsFollowupCount = rows.filter(
        (r) => r.bcsFlagFollowup === true,
      ).length;

      const byQuadrant = QUADRANTS.map((q) => {
        const inQuad = rows.filter((r) => r.reportedQuadrant === q);
        const bcsValues = inQuad
          .map((r) => r.bcsScore)
          .filter((v): v is number => v != null);
        const ndviValues = inQuad
          .map((r) => r.ndviVsBaselinePercent)
          .filter((v): v is number => v != null);
        return {
          quadrant: q,
          reportCount: inQuad.length,
          bcsAverage: bcsValues.length
            ? Math.round((bcsValues.reduce((a, b) => a + b, 0) / bcsValues.length) * 10) / 10
            : null,
          ndviAverage: ndviValues.length
            ? Math.round(ndviValues.reduce((a, b) => a + b, 0) / ndviValues.length)
            : null,
        };
      });

      // Alerts (last 14 days, same rules as /api/ground-truth/summary)
      const recentForAlerts = rows.filter(
        (r) => r.createdAt.getTime() >= fourteenDaysAgo,
      );
      const alerts: BriefData["alerts"] = [];
      for (const r of recentForAlerts) {
        if (r.bcsScore != null && r.bcsScore <= 2) {
          alerts.push({
            id: r.id,
            severity: "red",
            kind: "bcs_critical",
            message: `Animals reported emaciated (BCS ${r.bcsScore.toFixed(1)})`,
            location: r.reportedLocation,
            quadrant: r.reportedQuadrant,
          });
        }
        if (r.mortalityRate === "4-plus") {
          alerts.push({
            id: r.id,
            severity: "red",
            kind: "mortality_critical",
            message: "4+ animal deaths reported in the last 2 weeks",
            location: r.reportedLocation,
            quadrant: r.reportedQuadrant,
          });
        }
        if (
          r.waterPointStatus === "not_operational" ||
          r.waterPointStatus === "dry"
        ) {
          alerts.push({
            id: r.id,
            severity: "yellow",
            kind: "water_point_broken",
            message: `Water point ${r.waterPointName ?? "(unnamed)"} — ${r.waterPointStatus === "dry" ? "dry" : "not operational"}`,
            location: r.waterPointName ?? r.reportedLocation,
            quadrant: r.reportedQuadrant,
          });
        }
      }

      // Note: public.tenants isn't in the Drizzle schema yet; for the
      // brief we surface the tenant_id as the display name. Operators
      // already know their tenant.
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
      return briefData;
    });

    // ── 2. Generate brief via LLM layer ───────────────────────────────
    const systemPrompt = buildBriefSystemPrompt(data, lang);
    const { complete, completeJson } = await import("../../lib/llm/index.js");
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
    // Parse the response content with the schema; tolerate trailing
    // prose by extracting the first JSON object if needed.
    const parsed = parseLooseJson<BriefResponse>(response.content, briefResponseSchema);

    // ── 3. Respond ───────────────────────────────────────────────────
    res.json({
      tenant_id: tenantId,
      lang,
      summary: parsed.summary,
      actions: parsed.actions,
      data_sources: ["ground_truth_reports", "tenants"],
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
