import { Router, type IRouter, type Request } from "express";
import { desc } from "drizzle-orm";
import {
  groundTruthReportsTable,
  type GroundTruthReport,
} from "@workspace/db";
import { withTenantContext } from "../lib/tenancy-context.js";

function requireTenant(req: Request): string {
  const tenantId = req.tenant?.tenant_id;
  if (!tenantId) {
    throw new Error("tenant_id missing from request context");
  }
  return tenantId;
}

const router: IRouter = Router();

interface ApiReport {
  id: number;
  createdAt: string;
  phone: string | null;
  month: string;
  reportedQuadrant: string | null;
  reportedLocation: string | null;
  actionTag: string;
  bcsScore: number | null;
  bcsConfidence: string | null;
  bcsSpecies: string | null;
  bcsFlagFollowup: boolean | null;
  offtakeRate: string | null;
  mortalityRate: string | null;
  milkProduction: string | null;
  waterTrekkingDistance: string | null;
  waterPointName: string | null;
  waterPointStatus: string | null;
  supplementaryFeeding: string | null;
  ndviVsBaselinePercent: number | null;
  rainfall30dayMm: number | null;
  indicatorsCollected: number | null;
  dataCompletenessPercent: number | null;
  trustScore: number | null;
  trustFlags: string[] | null;
  userFeedback: string;
}

function toApiReport(r: GroundTruthReport): ApiReport {
  return {
    id: r.id,
    createdAt: r.createdAt.toISOString(),
    phone: r.phone,
    month: r.month,
    reportedQuadrant: r.reportedQuadrant,
    reportedLocation: r.reportedLocation,
    actionTag: r.actionTag,
    bcsScore: r.bcsScore,
    bcsConfidence: r.bcsConfidence,
    bcsSpecies: r.bcsSpecies,
    bcsFlagFollowup: r.bcsFlagFollowup,
    offtakeRate: r.offtakeRate,
    mortalityRate: r.mortalityRate,
    milkProduction: r.milkProduction,
    waterTrekkingDistance: r.waterTrekkingDistance,
    waterPointName: r.waterPointName,
    waterPointStatus: r.waterPointStatus,
    supplementaryFeeding: r.supplementaryFeeding,
    ndviVsBaselinePercent: r.ndviVsBaselinePercent,
    rainfall30dayMm: r.rainfall30dayMm,
    indicatorsCollected: r.indicatorsCollected,
    dataCompletenessPercent: r.dataCompletenessPercent,
    trustScore: r.trustScore,
    trustFlags: Array.isArray(r.trustFlags)
      ? (r.trustFlags as unknown[]).filter(
          (v): v is string => typeof v === "string",
        )
      : null,
    userFeedback: r.userFeedback,
  };
}

/**
 * GET /api/ground-truth/recent?limit=20
 * Returns the most recent ground-truth reports with structured indicators.
 */
router.get("/ground-truth/recent", async (req, res): Promise<void> => {
  const rawLimit = parseInt(String(req.query.limit ?? "20"), 10);
  const limit = Math.min(
    Math.max(Number.isFinite(rawLimit) ? rawLimit : 20, 1),
    100,
  );

  try {
    const tenantId = requireTenant(req);
    const rows = await withTenantContext(tenantId, (tx) =>
      tx
        .select()
        .from(groundTruthReportsTable)
        .orderBy(desc(groundTruthReportsTable.createdAt))
        .limit(limit),
    );
    res.json(rows.map(toApiReport));
  } catch (err) {
    req.log.error({ err }, "Failed to list recent ground-truth reports");
    res.status(500).json({ error: "Failed to load ground truth" });
  }
});

interface QuadrantAggregate {
  quadrant: "NW" | "NE" | "SW" | "SE";
  bcsAverage: number | null;
  bcsSampleCount: number;
  ndviAverage: number | null;
  reportCount: number;
}

interface StressAlert {
  id: number;
  createdAt: string;
  severity: "red" | "yellow";
  kind: "bcs_critical" | "mortality_critical" | "water_point_broken";
  message: string;
  location: string | null;
  quadrant: string | null;
}

interface GroundTruthSummary {
  totalReports: number;
  reportsLast7Days: number;
  averageCompletenessPercent: number | null;
  bcsFollowupCount: number;
  byQuadrant: QuadrantAggregate[];
  alerts: StressAlert[];
}

const QUADRANTS = ["NW", "NE", "SW", "SE"] as const;

/**
 * GET /api/ground-truth/summary
 * Returns per-quadrant BCS/NDVI aggregates + active stress alerts.
 */
router.get("/ground-truth/summary", async (req, res): Promise<void> => {
  try {
    const tenantId = requireTenant(req);
    // Last 90 days of reports keeps the dashboard fresh without scanning everything
    const rows = await withTenantContext(tenantId, (tx) =>
      tx
        .select()
        .from(groundTruthReportsTable)
        .orderBy(desc(groundTruthReportsTable.createdAt))
        .limit(500),
    );

    const now = Date.now();
    const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;

    const completenessSamples = rows
      .map((r) => r.dataCompletenessPercent)
      .filter((v): v is number => v != null);
    const avgCompleteness = completenessSamples.length
      ? completenessSamples.reduce((a, b) => a + b, 0) /
        completenessSamples.length
      : null;

    const byQuadrant: QuadrantAggregate[] = QUADRANTS.map((q) => {
      const inQuad = rows.filter((r) => r.reportedQuadrant === q);
      const bcsValues = inQuad
        .map((r) => r.bcsScore)
        .filter((v): v is number => v != null);
      const ndviValues = inQuad
        .map((r) => r.ndviVsBaselinePercent)
        .filter((v): v is number => v != null);
      return {
        quadrant: q,
        bcsAverage: bcsValues.length
          ? bcsValues.reduce((a, b) => a + b, 0) / bcsValues.length
          : null,
        bcsSampleCount: bcsValues.length,
        ndviAverage: ndviValues.length
          ? ndviValues.reduce((a, b) => a + b, 0) / ndviValues.length
          : null,
        reportCount: inQuad.length,
      };
    });

    // Generate alerts from the last 14 days only (older alerts are stale)
    const fourteenDaysAgo = now - 14 * 24 * 60 * 60 * 1000;
    const recentForAlerts = rows.filter(
      (r) => r.createdAt.getTime() >= fourteenDaysAgo,
    );

    const alerts: StressAlert[] = [];
    for (const r of recentForAlerts) {
      if (r.bcsScore != null && r.bcsScore <= 2) {
        alerts.push({
          id: r.id,
          createdAt: r.createdAt.toISOString(),
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
          createdAt: r.createdAt.toISOString(),
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
          createdAt: r.createdAt.toISOString(),
          severity: "yellow",
          kind: "water_point_broken",
          message: `Water point ${r.waterPointName ?? "(unnamed)"} — ${r.waterPointStatus === "dry" ? "dry" : "not operational"}`,
          location: r.waterPointName ?? r.reportedLocation,
          quadrant: r.reportedQuadrant,
        });
      }
    }

    const summary: GroundTruthSummary = {
      totalReports: rows.length,
      reportsLast7Days: rows.filter(
        (r) => r.createdAt.getTime() >= sevenDaysAgo,
      ).length,
      averageCompletenessPercent: avgCompleteness,
      bcsFollowupCount: rows.filter((r) => r.bcsFlagFollowup === true).length,
      byQuadrant,
      alerts,
    };

    res.json(summary);
  } catch (err) {
    req.log.error({ err }, "Failed to build ground-truth summary");
    res.status(500).json({ error: "Failed to load ground truth summary" });
  }
});

export default router;
