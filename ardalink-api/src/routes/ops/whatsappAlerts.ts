/**
 * Ops-triggered WhatsApp drought-alert dispatch.
 *
 * Endpoint (tenant-gated via the standard Bearer middleware, same
 * posture as every other /api/ops/* route — deliberately NOT in
 * middlewares/tenant.ts's PUBLIC_PATHS):
 *
 *   POST /api/ops/whatsapp/alerts/dispatch { wardId? }
 *     → fires the drought_alert_utility template to every WhatsApp-tier,
 *       opted-in pastoralist (optionally restricted to one ward).
 *
 * This is a manual trigger for Phase 0/1, matching how the SMS welcome
 * message is dispatched today (ops/leads.ts's verify handler) rather
 * than inventing a live cron — a future scheduler can call
 * `dispatchDroughtAlertsForWard` directly without any route changes.
 */

import { Router, type IRouter } from "express";
import { logger } from "../../lib/logger.js";
import { dispatchDroughtAlertsForWard } from "../../lib/whatsappAlerts.js";

const router: IRouter = Router();

interface DispatchBody {
  wardId?: string;
}

router.post(
  "/ops/whatsapp/alerts/dispatch",
  async (req, res): Promise<void> => {
    const body = (req.body ?? {}) as DispatchBody;
    try {
      const result = await dispatchDroughtAlertsForWard(body.wardId);
      res.json({ ready: true, ...result });
    } catch (err) {
      logger.error(
        { err: String(err), wardId: body.wardId },
        "[ops/whatsapp/alerts] dispatch failed",
      );
      res.status(500).json({ error: "dispatch_failed" });
    }
  },
);

export default router;
