/**
 * Ops trigger for the VCI backfill job.
 *
 *   POST /api/ops/vci-backfill  → run the backfill synchronously,
 *                                 return counts. Tenant-gated (admin
 *                                 action, not a herder-facing surface).
 *
 * The job is idempotent — repeat runs no-op on already-filled rows.
 */

import { Router, type IRouter } from "express";
import { logger } from "../../lib/logger.js";
import { runVciBackfill } from "../../jobs/vciBackfillJob.js";

const router: IRouter = Router();

router.post("/ops/vci-backfill", async (_req, res): Promise<void> => {
  try {
    const startedAt = Date.now();
    const result = await runVciBackfill();
    res.json({
      ok: true,
      durationMs: Date.now() - startedAt,
      ...result,
    });
  } catch (err) {
    logger.error({ err }, "[ops/vci-backfill] crashed");
    res.status(500).json({ ok: false, error: String(err) });
  }
});

export default router;
