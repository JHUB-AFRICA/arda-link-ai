/**
 * Premium SMS Subscription Notifications callback — AT hits this when
 * a user's subscription state changes (new subscribe, renewal, cancel)
 * on a premium SMS shortcode.
 *
 * We don't run premium billing yet — this endpoint exists so AT
 * doesn't retry-storm on a 404 when the field is populated in the
 * dashboard. Every payload is logged for audit; nothing is mutated.
 *
 * AT payload varies by subscription type but usually includes:
 *   phoneNumber, shortCode, keyword, status ('activated'|'deactivated')
 */

import { Router, type IRouter } from "express";
import { logLeadInteraction } from "../lib/supabase/index.js";

const router: IRouter = Router();

router.post(
  "/sms-subscription-callback",
  async (req, res): Promise<void> => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const phone = String(body.phoneNumber ?? "").trim();
    const status = String(body.status ?? "").trim();
    const shortCode = String(body.shortCode ?? "").trim();
    const keyword = String(body.keyword ?? "").trim();

    req.log.info(
      { phone, status, shortCode, keyword },
      "[SMS-Sub] Subscription notification received",
    );

    if (phone) {
      void logLeadInteraction({
        phone_number: phone,
        tier: "unknown",
        channel: "sms",
        session_id: null,
        keyword: `subscription:${status.toLowerCase() || "event"}`,
        input_text: keyword || null,
        reply_text: null,
        ward_id: null,
        raw_body: { shortCode, ...body },
      });
    }

    res.status(200).json({ ok: true });
  },
);

export default router;
