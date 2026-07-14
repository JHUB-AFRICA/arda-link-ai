/**
 * Ops ward-cells endpoints — expose the ~1 km cell grid we've been
 * carrying in Supabase (`ward_cells` + `satellite_cell_indices`) but
 * not surfacing anywhere. Powers the dashboard heatmap and the
 * per-cell drill for QA.
 *
 * Endpoints (tenant-gated via standard Bearer middleware):
 *   GET /api/ops/wards/:wardId/cells/summary
 *       → { cellCount, cellsWithData, stressedCellCount, stressedFraction,
 *           ndviMin, ndviMax, ndviMedian, vciMedian, anomalyMedian,
 *           latestPeriodEnd }
 *   GET /api/ops/wards/:wardId/cells/latest?limit=N
 *       → { count, cells: [{ ward_cell_id, centroid_lat, centroid_lon,
 *           ndvi_mean, vci_value, ndvi_anomaly, ... }, ...] }
 *
 * Design rules:
 *   - Read-only. Never mutates Supabase.
 *   - Returns `ready: false` when Supabase isn't configured so the
 *     dashboard renders "no data" rather than 500.
 *   - Cell rows are capped at 2000 per response — the largest Isiolo
 *     ward is Oldonyiro at 1287 cells.
 */

import { Router, type IRouter } from "express";
import {
  isSupabaseConfigured,
  latestCellIndicesForWard,
  wardCellStressSummary,
} from "../../lib/supabase.js";

const router: IRouter = Router();

router.get("/ops/wards/:wardId/cells/summary", async (req, res): Promise<void> => {
  if (!isSupabaseConfigured()) {
    res.json({ ready: false, reason: "supabase_not_configured", summary: null });
    return;
  }
  const summary = await wardCellStressSummary(req.params.wardId);
  res.json({ ready: true, summary });
});

router.get("/ops/wards/:wardId/cells/latest", async (req, res): Promise<void> => {
  if (!isSupabaseConfigured()) {
    res.json({ ready: false, reason: "supabase_not_configured", cells: [] });
    return;
  }
  const limit = Math.min(Math.max(Number(req.query.limit) || 500, 1), 2000);
  const rows = await latestCellIndicesForWard(req.params.wardId);
  const trimmed = (rows ?? []).slice(0, limit);
  res.json({ ready: true, count: trimmed.length, cells: trimmed });
});

export default router;
