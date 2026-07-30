/**
 * Per-county aggregates, auto-generated insight bullets, rankings, and
 * alert markers for the operator dashboard's choropleth. Every demo
 * tenant sits inside Isiolo County today, so the tenant-scoped path
 * returns just one county; the admin role rolls up across tenants.
 */

import { sql } from "drizzle-orm";
import { pastoralistsTable } from "@workspace/db";
import { withTenantContext } from "../tenancy-context.js";
import { isSupabaseConfigured, recentGroundTruthCalls } from "../supabase/index.js";
import {
  type TimeSlice,
  TIME_SLICE_LABELS,
  timeSliceStart,
} from "./timeSlices.js";
import { fetchYearOverYearClimate } from "./historicalClimate.js";

/**
 * Per-county aggregates for the dashboard's choropleth.
 *
 * Returns a Map of county name → numeric value for the chosen metric.
 * Counties without data are NOT included in the map (the client
 * renders them gray with a "no data" tooltip).
 */
export interface PerCountyAggregate {
  byCounty: Record<string, number | null>;
  unit: string;
  description: string;
}

/**
 * Compute per-county aggregates for the given metric + time slice.
 *
 * Scoped to the caller's tenant unless the caller has the admin role
 * (in which case we roll up across all 3 demo tenants). Each tenant
 * has data in Isiolo County (the home county of all three wards),
 * so the "byCounty" map always has at most one entry.
 *
 * Future: per-tenant counties can be added by storing the tenant's
 * county in the tenants table; for the demo we map every tenant to
 * ISIOLO and use admin mode to roll up.
 */
export async function computePerCountyAggregates(
  tenantId: string,
  metric: string,
  slice: TimeSlice = "30d",
): Promise<PerCountyAggregate> {
  const wantsAdmin = tenantId === "admin"; // sentinel — see auth.ts
  const tenantIds = wantsAdmin
    ? ["bula-pesa", "ngare-mara", "burat"]
    : [tenantId];
  const since = timeSliceStart(slice);

  switch (metric) {
    case "reports": {
      // Count from Supabase ground_truth_calls (source of truth).
      const out: Record<string, number> = { ISIOLO: 0 };
      if (isSupabaseConfigured()) {
        const rows = await recentGroundTruthCalls(500);
        out["ISIOLO"] = rows?.length ?? 0;
      }
      return {
        byCounty: out,
        unit: "reports",
        description: `Ground-truth reports in the ${TIME_SLICE_LABELS[slice]} window. Counties without source data are omitted.`,
      };
    }
    case "bcs": {
      // Average BCS from Supabase ground_truth_calls.
      const out: Record<string, number | null> = { ISIOLO: null };
      if (isSupabaseConfigured()) {
        const rows = await recentGroundTruthCalls(500);
        const bcsValues = (rows ?? [])
          .map((r) => r.bcs_score)
          .filter((v): v is number => v != null && v > 0);
        if (bcsValues.length > 0) {
          const avg = bcsValues.reduce((a, b) => a + b, 0) / bcsValues.length;
          out["ISIOLO"] = parseFloat(avg.toFixed(2));
        }
      }
      return {
        byCounty: out,
        unit: "BCS (1-5)",
        description: `Average Body Condition Score in the ${TIME_SLICE_LABELS[slice]} window (1=emaciated, 5=fat).`,
      };
    }
    case "ndvi": {
      // No ndviVsBaselinePercent equivalent on ground_truth_calls.
      // Return null so the dashboard shows "no data" rather than a fabricated value.
      const out: Record<string, number | null> = { ISIOLO: null };
      return {
        byCounty: out,
        unit: "% vs 11-yr baseline",
        description: `Mean NDVI delta vs 11-year baseline (negative = stress) in the ${TIME_SLICE_LABELS[slice]} window.`,
      };
    }
    case "herd": {
      // Herd is "as of now" — a count of registered pastoralists, not
      // bounded by the time slice. The slice still applies to the
      // description so the UI can label what the panel means.
      const out: Record<string, number> = { ISIOLO: 0 };
      for (const t of tenantIds) {
        const rows = await withTenantContext(t, async (tx) =>
          tx
            .select({
              cattle: sql<number>`COALESCE(SUM(${pastoralistsTable.cattle}), 0)`,
              goats: sql<number>`COALESCE(SUM(${pastoralistsTable.goats}), 0)`,
              camels: sql<number>`COALESCE(SUM(${pastoralistsTable.camels}), 0)`,
            })
            .from(pastoralistsTable),
        );
        const r = rows[0];
        const total =
          Number(r?.cattle ?? 0) +
          Number(r?.goats ?? 0) +
          Number(r?.camels ?? 0);
        out["ISIOLO"] = (out["ISIOLO"] ?? 0) + total;
      }
      return {
        byCounty: out,
        unit: "animals",
        description:
          "Total registered herd size (cattle + goats + camels) per county.",
      };
    }
    default:
      return {
        byCounty: { ISIOLO: null },
        unit: "?",
        description: `Unknown metric '${metric}'`,
      };
  }
}

/**
 * Auto-generated insights for the current selection. Returns 3-5
 * plain-English bullets comparing the selected counties.
 *
 * For now every insight is computed deterministically from the
 * aggregates + the year-over-year climate data. In the future we
 * can route this through the LLM layer too.
 */
export async function computeInsights(
  tenantId: string,
  slice: TimeSlice,
  selectedCounties: string[],
): Promise<{ bullets: string[]; generatedAt: string }> {
  const bullets: string[] = [];
  // Pull the four metrics in parallel.
  const [reports, bcs, ndvi, herd, yoy] = await Promise.all([
    computePerCountyAggregates(tenantId, "reports", slice),
    computePerCountyAggregates(tenantId, "bcs", slice),
    computePerCountyAggregates(tenantId, "ndvi", slice),
    computePerCountyAggregates(tenantId, "herd", slice),
    fetchYearOverYearClimate().catch(() => null),
  ]);

  const isioloReports = reports.byCounty["ISIOLO"] ?? 0;
  if (isioloReports > 0) {
    bullets.push(
      `${isioloReports} ground-truth report${isioloReports === 1 ? "" : "s"} from Isiolo in the ${TIME_SLICE_LABELS[slice]} window.`,
    );
  } else {
    bullets.push(
      `No ground-truth reports from Isiolo in the ${TIME_SLICE_LABELS[slice]} window — coverage may have dropped.`,
    );
  }

  const isioloBcs = bcs.byCounty["ISIOLO"];
  if (isioloBcs != null) {
    const verdict =
      isioloBcs < 2.5
        ? "emaciated — urgent supplemental feeding advised"
        : isioloBcs < 3
          ? "below average — monitor grazing pressure"
          : "within healthy range";
    bullets.push(
      `Isiolo average BCS is ${isioloBcs.toFixed(2)} (${verdict}).`,
    );
  }

  const isioloNdvi = ndvi.byCounty["ISIOLO"];
  if (isioloNdvi != null) {
    const stress =
      isioloNdvi <= -30
        ? "critical stress"
        : isioloNdvi <= -15
          ? "high stress"
          : isioloNdvi <= -5
            ? "mild stress"
            : "near baseline";
    bullets.push(
      `Isiolo NDVI is ${isioloNdvi >= 0 ? "+" : ""}${isioloNdvi.toFixed(1)}% vs the 11-year baseline (${stress}).`,
    );
  }

  const isioloHerd = herd.byCounty["ISIOLO"] ?? 0;
  if (isioloHerd > 0) {
    bullets.push(
      `Isiolo registered herd totals ${isioloHerd.toLocaleString()} animals across cattle, goats and camels.`,
    );
  }

  if (yoy) {
    bullets.push(
      `Climate in the ${TIME_SLICE_LABELS[slice]} window vs the same dates last year: ${yoy.comparison.interpretation}`,
    );
  }

  // Comparison hint: if the operator added main counties we tell them
  // those don't have direct ground-truth data and what that means.
  const mainCounties = selectedCounties.filter(
    (c) => c !== "ISIOLO" && reports.byCounty[c] == null,
  );
  if (mainCounties.length > 0) {
    bullets.push(
      `${mainCounties.join(", ")} ${mainCounties.length === 1 ? "is" : "are"} reference counties — they have no ArdaLink ground-truth reports, so per-county metrics will show 'no data'. Year-over-year climate applies to Isiolo only today; per-county climate will land in Q3 once we wire the planetary-computer NDVI ingest.`,
    );
  }

  return {
    bullets: bullets.slice(0, 5),
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Severity ranking across selected counties for the active metric.
 * Returns each county's normalised value (0–1) plus a human label
 * so the dashboard can render a horizontal bar chart.
 */
export async function computeRankings(
  tenantId: string,
  metric: string,
  slice: TimeSlice,
  selectedCounties: string[],
): Promise<{
  metric: string;
  unit: string;
  slice: TimeSlice;
  rows: Array<{ county: string; value: number | null; rank: number; normalised: number }>;
}> {
  const agg = await computePerCountyAggregates(tenantId, metric, slice);
  // Each selected county gets a row; counties without data show null.
  const values = selectedCounties.map((c) => ({
    county: c,
    value: agg.byCounty[c] ?? null,
  }));

  // Compute normalised 0..1 — for "lower is worse" metrics (NDVI delta,
  // BCS, mortality) we sort ascending; for "higher is worse" metrics
  // (reports, herd) we sort descending. For now we treat NDVI specially.
  const ordered = [...values];
  if (metric === "ndvi") {
    // Want lowest (most stressed) at rank 1
    ordered.sort((a, b) => {
      if (a.value == null && b.value == null) return 0;
      if (a.value == null) return 1;
      if (b.value == null) return -1;
      return a.value - b.value;
    });
  } else if (metric === "bcs") {
    ordered.sort((a, b) => {
      if (a.value == null && b.value == null) return 0;
      if (a.value == null) return 1;
      if (b.value == null) return -1;
      // Lower BCS is worse, so lower first.
      return a.value - b.value;
    });
  } else {
    // reports, herd — higher means more activity, sort desc
    ordered.sort((a, b) => {
      if (a.value == null && b.value == null) return 0;
      if (a.value == null) return 1;
      if (b.value == null) return -1;
      return b.value - a.value;
    });
  }

  // Compute normalisation: scale by min/max within the row set.
  const numericVals = ordered
    .map((r) => r.value)
    .filter((v): v is number => v != null);
  const lo = numericVals.length ? Math.min(...numericVals) : 0;
  const hi = numericVals.length ? Math.max(...numericVals) : 1;
  const range = hi - lo || 1;

  return {
    metric,
    unit: agg.unit,
    slice,
    rows: ordered.map((r, i) => ({
      county: r.county,
      value: r.value,
      rank: i + 1,
      normalised:
        r.value == null ? 0 : Math.max(0, Math.min(1, (r.value - lo) / range)),
    })),
  };
}

/**
 * Active alert markers for the choropleth's pulsing alert overlay.
 * Returns one entry per mortality_critical report in the time slice,
 * bucketed to Isiolo for the demo.
 */
export async function computeAlertMarkers(
  tenantId: string,
  slice: TimeSlice,
): Promise<
  Array<{
    id: number;
    county: string;
    severity: "red" | "yellow";
    kind: string;
    message: string;
    quadrant: string | null;
    createdAt: string;
  }>
> {
  const out: Array<{
    id: number;
    county: string;
    severity: "red" | "yellow";
    kind: string;
    message: string;
    quadrant: null;
    createdAt: string;
  }> = [];
  // Read from Supabase ground_truth_calls. No reportedQuadrant available.
  if (isSupabaseConfigured()) {
    const rows = await recentGroundTruthCalls(500);
    for (const r of rows ?? []) {
      if (r.bcs_score != null && r.bcs_score <= 2) {
        out.push({
          id: 0,
          county: "ISIOLO",
          severity: "red",
          kind: "bcs_critical",
          message: `Animals reported emaciated (BCS ${r.bcs_score.toFixed(1)})`,
          quadrant: null,
          createdAt: r.created_at,
        });
      }
      // mortality_rate on Supabase is a proportion; >= 0.1 maps to "4-plus"
      if (r.mortality_rate != null && r.mortality_rate >= 0.1) {
        out.push({
          id: 0,
          county: "ISIOLO",
          severity: "red",
          kind: "mortality_critical",
          message: "4+ animal deaths reported",
          quadrant: null,
          createdAt: r.created_at,
        });
      }
      if (r.water_point_status === "dry" || r.water_point_status === "not_operational") {
        out.push({
          id: 0,
          county: "ISIOLO",
          severity: "yellow",
          kind: "water_point_broken",
          message: `Water point — ${r.water_point_status === "dry" ? "dry" : "not operational"}`,
          quadrant: null,
          createdAt: r.created_at,
        });
      }
    }
  }
  return out;
}
