/**
 * Ops CallbackLog — read-only listing of every AT surface hit.
 *
 * Endpoint (tenant-gated):
 *   GET /api/ops/interactions?channel=&ward_id=&phone=&limit=
 *
 * The dashboard CallbackLog component tails this endpoint. Each row
 * shows: timestamp, channel, tier, phone, keyword, input_text, reply.
 */

import { Router, type IRouter } from "express";
import { logger } from "../../lib/logger.js";
import {
  isSupabaseConfigured,
  recentLeadInteractions,
} from "../../lib/supabase.js";

const router: IRouter = Router();

router.get("/ops/interactions", async (req, res): Promise<void> => {
  if (!isSupabaseConfigured()) {
    res.json({ ready: false, reason: "supabase_not_configured", interactions: [] });
    return;
  }
  const channelRaw = String(req.query.channel ?? "").trim().toLowerCase();
  const channel =
    channelRaw === "ussd" ||
    channelRaw === "sms" ||
    channelRaw === "voice" ||
    channelRaw === "voice_event"
      ? channelRaw
      : undefined;
  const wardId = String(req.query.ward_id ?? "").trim() || undefined;
  const phone = String(req.query.phone ?? "").trim() || undefined;
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);

  try {
    const rows = await recentLeadInteractions({ limit, channel, ward_id: wardId, phone });
    res.json({
      ready: true,
      count: rows?.length ?? 0,
      interactions: rows ?? [],
    });
  } catch (err) {
    logger.error({ err }, "[ops/interactions] fetch failed");
    res.status(500).json({ ready: false, reason: "query_failed", interactions: [] });
  }
});

export default router;
