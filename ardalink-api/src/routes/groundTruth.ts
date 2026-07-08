import { Router, type IRouter, type Request } from "express";
import { desc } from "drizzle-orm";
import {
  groundTruthReportsTable,
  type GroundTruthReport,
} from "@workspace/db";
import { withTenantContext } from "../lib/tenancy-context.js";
import {
  isSupabaseConfigured,
  recentGroundTruthCalls,
  type SbGroundTruthCallRead,
} from "../lib/supabase.js";

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
 * Shape of the dashboard's "merged" ground-truth row — the union of what
 * we can render from either the local rich schema or Supabase's thin one.
 */
interface MergedReport {
  /** Where the row came from — badge in the dashboard. */
  source: "local" | "supabase";
  /** Present when source='local' — the local Postgres serial ID. */
  localId: number | null;
  /** Present when source='supabase' — the ground_truth_calls uuid. */
  callId: string | null;
  createdAt: string;
  phone: string | null;
  fullName: string | null;
  wardId: string | null;
  actionTag: string | null;
  bcsScore: number | null;
  bcsSpecies: string | null;
  bcsConfidence: string | null;
  mortalityRate: string | null;
  waterPointStatus: string | null;
  waterPointName: string | null;
  supplementaryFeeding: string | null;
  trustScore: number | null;
  indicatorsCollected: number | null;
  dataCompletenessPercent: number | null;
  transcript: string | null;
}

function localToMerged(r: GroundTruthReport): MergedReport {
  return {
    source: "local",
    localId: r.id,
    callId: null,
    createdAt: r.createdAt.toISOString(),
    phone: r.phone,
    fullName: null,
    wardId: null,
    actionTag: r.actionTag,
    bcsScore: r.bcsScore,
    bcsSpecies: r.bcsSpecies,
    bcsConfidence: r.bcsConfidence,
    mortalityRate: r.mortalityRate,
    waterPointStatus: r.waterPointStatus,
    waterPointName: r.waterPointName,
    supplementaryFeeding: r.supplementaryFeeding,
    trustScore: r.trustScore,
    indicatorsCollected: r.indicatorsCollected,
    dataCompletenessPercent: r.dataCompletenessPercent,
    transcript: r.userFeedback,
  };
}

function supabaseToMerged(r: SbGroundTruthCallRead): MergedReport {
  // Reverse the proportion → categorical mapping the pipeline applied
  // on write, so the dashboard renders a familiar label instead of a
  // fraction. Buckets match the extractor: none / 1-3 / 4-plus.
  const mortalityLabel =
    r.mortality_rate == null
      ? null
      : r.mortality_rate < 0.02
        ? "none"
        : r.mortality_rate < 0.1
          ? "1-3"
          : "4-plus";
  return {
    source: "supabase",
    localId: null,
    callId: r.call_id,
    createdAt: r.created_at,
    phone: r.pastoralists?.phone_number ?? null,
    fullName: r.pastoralists?.full_name ?? null,
    wardId: r.ward_id,
    actionTag: null,
    bcsScore: r.bcs_score,
    bcsSpecies: null,
    bcsConfidence: null,
    mortalityRate: mortalityLabel,
    waterPointStatus: r.water_point_status,
    waterPointName: null,
    supplementaryFeeding:
      r.supplementary_feeding === true
        ? "yes"
        : r.supplementary_feeding === false
          ? "no"
          : null,
    trustScore: r.trust_score != null ? Math.round(r.trust_score * 100) : null,
    indicatorsCollected: null,
    dataCompletenessPercent: null,
    transcript: r.transcript,
  };
}

/**
 * GET /api/ground-truth/merged?limit=20
 *
 * Union view of local `ground_truth_reports` + Supabase `ground_truth_calls`
 * (via the joined pastoralist view). Each row carries a `source` badge so
 * the dashboard can show provenance. Rows are ordered by createdAt DESC.
 *
 * When Supabase is unconfigured we transparently fall back to local-only.
 * When Supabase times out or returns an error we still return the local
 * rows; the operator dashboard never has to wait on Supabase to load.
 */
router.get("/ground-truth/merged", async (req, res): Promise<void> => {
  const rawLimit = parseInt(String(req.query.limit ?? "20"), 10);
  const limit = Math.min(
    Math.max(Number.isFinite(rawLimit) ? rawLimit : 20, 1),
    100,
  );
  try {
    const tenantId = requireTenant(req);
    const localP = withTenantContext(tenantId, (tx) =>
      tx
        .select()
        .from(groundTruthReportsTable)
        .orderBy(desc(groundTruthReportsTable.createdAt))
        .limit(limit),
    );
    const supabaseP = isSupabaseConfigured()
      ? recentGroundTruthCalls(limit)
      : Promise.resolve(null);

    const [locals, supabaseRows] = await Promise.all([localP, supabaseP]);

    const rows: MergedReport[] = [
      ...locals.map(localToMerged),
      ...(supabaseRows ?? []).map(supabaseToMerged),
    ];
    rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

    res.json({
      rows: rows.slice(0, limit),
      counts: {
        local: locals.length,
        supabase: supabaseRows?.length ?? 0,
      },
      supabase: {
        configured: isSupabaseConfigured(),
        reachable: supabaseRows !== null,
      },
    });
  } catch (err) {
    req.log.error({ err }, "Failed to load merged ground-truth");
    res.status(500).json({ error: "Failed to load ground truth" });
  }
});

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
