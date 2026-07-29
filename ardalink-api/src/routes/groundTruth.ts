import { Router, type IRouter, type Request } from "express";
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

/**
 * Shape of the dashboard's "merged" ground-truth row — sourced solely from
 * Supabase's ground_truth_calls now that the local table has been dropped.
 */
interface MergedReport {
  /** Where the row came from — always 'supabase' now. */
  source: "supabase";
  /** Always null — local Postgres ID no longer exists. */
  localId: null;
  /** The ground_truth_calls uuid. */
  callId: string | null;
  createdAt: string;
  phone: string | null;
  fullName: string | null;
  wardId: string | null;
  actionTag: null;
  bcsScore: number | null;
  bcsSpecies: null;
  bcsConfidence: null;
  mortalityRate: string | null;
  waterPointStatus: string | null;
  waterPointName: null;
  supplementaryFeeding: string | null;
  trustScore: number | null;
  indicatorsCollected: null;
  dataCompletenessPercent: null;
  transcript: string | null;
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
 * Returns rows from Supabase `ground_truth_calls`. The `source` badge is
 * always 'supabase'. When Supabase is unconfigured the endpoint returns an
 * empty array.
 */
router.get("/ground-truth/merged", async (req, res): Promise<void> => {
  const rawLimit = parseInt(String(req.query.limit ?? "20"), 10);
  const limit = Math.min(
    Math.max(Number.isFinite(rawLimit) ? rawLimit : 20, 1),
    100,
  );
  try {
    requireTenant(req);
    const supabaseRows = isSupabaseConfigured()
      ? await recentGroundTruthCalls(limit)
      : null;

    const rows: MergedReport[] = (supabaseRows ?? []).map(supabaseToMerged);

    res.json({
      rows,
      counts: {
        local: 0,
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
 * Returns the most recent ground-truth calls from Supabase.
 */
router.get("/ground-truth/recent", async (req, res): Promise<void> => {
  const rawLimit = parseInt(String(req.query.limit ?? "20"), 10);
  const limit = Math.min(
    Math.max(Number.isFinite(rawLimit) ? rawLimit : 20, 1),
    100,
  );

  try {
    requireTenant(req);
    const rows = isSupabaseConfigured()
      ? ((await recentGroundTruthCalls(limit)) ?? []).map(supabaseToMerged)
      : [];
    res.json(rows);
  } catch (err) {
    req.log.error({ err }, "Failed to list recent ground-truth reports");
    res.status(500).json({ error: "Failed to load ground truth" });
  }
});

interface QuadrantAggregate {
  quadrant: "NW" | "NE" | "SW" | "SE";
  bcsAverage: number | null;
  bcsSampleCount: number;
  ndviAverage: null;
  reportCount: number;
}

interface StressAlert {
  id: string;
  createdAt: string;
  severity: "red" | "yellow";
  kind: "bcs_critical" | "mortality_critical" | "water_point_broken";
  message: string;
  location: null;
  quadrant: null;
}

interface GroundTruthSummary {
  totalReports: number;
  reportsLast7Days: number;
  averageCompletenessPercent: null;
  bcsFollowupCount: null;
  byQuadrant: QuadrantAggregate[];
  alerts: StressAlert[];
}

const QUADRANTS = ["NW", "NE", "SW", "SE"] as const;

/**
 * GET /api/ground-truth/summary
 * Returns BCS aggregates + active stress alerts from Supabase ground_truth_calls.
 * Fields that don't exist on ground_truth_calls (quadrant, ndvi, completeness)
 * are returned as null/empty.
 */
router.get("/ground-truth/summary", async (req, res): Promise<void> => {
  try {
    requireTenant(req);

    const rows = isSupabaseConfigured()
      ? ((await recentGroundTruthCalls(500)) ?? [])
      : [];

    const now = Date.now();
    const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
    const fourteenDaysAgo = now - 14 * 24 * 60 * 60 * 1000;

    // No reportedQuadrant on ground_truth_calls — return empty quadrant breakdown.
    const byQuadrant: QuadrantAggregate[] = QUADRANTS.map((q) => ({
      quadrant: q,
      bcsAverage: null,
      bcsSampleCount: 0,
      ndviAverage: null,
      reportCount: 0,
    }));

    const recentForAlerts = rows.filter(
      (r) => new Date(r.created_at).getTime() >= fourteenDaysAgo,
    );

    const alerts: StressAlert[] = [];
    for (const r of recentForAlerts) {
      if (r.bcs_score != null && r.bcs_score <= 2) {
        alerts.push({
          id: r.call_id,
          createdAt: r.created_at,
          severity: "red",
          kind: "bcs_critical",
          message: `Animals reported emaciated (BCS ${r.bcs_score.toFixed(1)})`,
          location: null,
          quadrant: null,
        });
      }
      // mortality_rate on Supabase is a proportion; "4-plus" maps to ~0.15+
      if (r.mortality_rate != null && r.mortality_rate >= 0.1) {
        alerts.push({
          id: r.call_id,
          createdAt: r.created_at,
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
          id: r.call_id,
          createdAt: r.created_at,
          severity: "yellow",
          kind: "water_point_broken",
          message: `Water point — ${r.water_point_status === "dry" ? "dry" : "not operational"}`,
          location: null,
          quadrant: null,
        });
      }
    }

    const summary: GroundTruthSummary = {
      totalReports: rows.length,
      reportsLast7Days: rows.filter(
        (r) => new Date(r.created_at).getTime() >= sevenDaysAgo,
      ).length,
      averageCompletenessPercent: null,
      bcsFollowupCount: null,
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
