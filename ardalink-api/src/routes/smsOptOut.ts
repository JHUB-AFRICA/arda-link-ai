/**
 * Bulk SMS Opt-Out callback — AT hits this when a user texts an
 * opt-out keyword (STOP, END, QUIT etc.) to our shortcode, or opts
 * out through AT's aggregation flow.
 *
 * AT posts form-encoded:
 *   senderId     → our shortcode (48910 in sandbox)
 *   phoneNumber  → the number opting out (+254…)
 *
 * On receipt:
 *   1. Flip `alerts_enabled=false` on any matching pastoralists row
 *   2. Flip `status='opted_out'` on any matching pastoralist_leads row
 *   3. Log the event to lead_interactions so ops can see the opt-out
 *      in the CallbackLog
 *
 * The api's own SMS handler already treats inbound `STOP` as an
 * opt-out (returns empty reply). This callback is AT's independent
 * signal for the same event — safe to receive both.
 */

import { Router, type IRouter } from "express";
import { logger } from "../lib/logger.js";
import {
  identityForPhone,
  logLeadInteraction,
  markPastoralistOptedOut,
  setLeadStatus,
} from "../lib/supabase/index.js";

interface OptOutBody {
  senderId?: string;
  phoneNumber?: string;
}

const router: IRouter = Router();

router.post("/sms-optout-callback", async (req, res): Promise<void> => {
  const body = (req.body ?? {}) as OptOutBody;
  const phone = String(body.phoneNumber ?? "").trim();
  const senderId = String(body.senderId ?? "").trim();

  req.log.info(
    { phone, senderId },
    "[SMS-OptOut] Opt-out request received",
  );

  if (!phone) {
    res.status(200).json({ ok: false, reason: "missing phone" });
    return;
  }

  // Flip both sides best-effort. Failures never block AT's ACK.
  const [leadOk, pastOk] = await Promise.all([
    setLeadStatus(phone, "opted_out"),
    markPastoralistOptedOut(phone),
  ]);

  let tier: "verified" | "lead" | "unknown" = "unknown";
  let wardId: string | null = null;
  try {
    const id = await identityForPhone(phone);
    tier = id?.tier ?? "unknown";
    wardId = id?.ward_id ?? null;
  } catch {
    /* swallow */
  }

  void logLeadInteraction({
    phone_number: phone,
    tier,
    channel: "sms",
    session_id: null,
    keyword: "opt_out",
    input_text: null,
    reply_text: null,
    ward_id: wardId,
    raw_body: { senderId, leadOk, pastOk },
  });

  logger.info({ phone, leadOk, pastOk }, "[SMS-OptOut] Applied");
  res.status(200).json({ ok: true, leadOk, pastOk });
});

export default router;
