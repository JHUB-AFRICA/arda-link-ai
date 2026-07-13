/**
 * SMS Delivery Reports callback — AT hits this when an outbound SMS
 * we sent completes (Success / Sent) or fails (Rejected / Failed).
 *
 * AT posts form-encoded:
 *   id            → the messageId we got back from POST /messaging
 *   status        → 'Success' | 'Sent' | 'Failed' | 'Rejected' | 'Buffered'
 *   phoneNumber   → recipient (+254…)
 *   networkCode   → carrier (optional)
 *   failureReason → present when status is Failed / Rejected
 *   retryCount    → present when AT retried before failing
 *
 * We log every report into `lead_interactions` as a `voice_event`-style
 * observability row (channel='sms', keyword='delivery:<status>') so the
 * ops CallbackLog panel can show whether outbound SMS actually landed.
 * Also updates trust weighting downstream — a phone that repeatedly
 * fails delivery signals a stale number ops should follow up on.
 */

import { Router, type IRouter } from "express";
import { logger } from "../lib/logger.js";
import { logLeadInteraction, identityForPhone } from "../lib/supabase.js";

interface DeliveryBody {
  id?: string;
  status?: string;
  phoneNumber?: string;
  networkCode?: string;
  failureReason?: string;
  retryCount?: string;
}

const router: IRouter = Router();

router.post("/sms-delivery-callback", async (req, res): Promise<void> => {
  const body = (req.body ?? {}) as DeliveryBody;
  const phone = String(body.phoneNumber ?? "").trim();
  const status = String(body.status ?? "").trim();
  const messageId = String(body.id ?? "").trim();

  req.log.info(
    {
      phone,
      status,
      messageId,
      failureReason: body.failureReason,
      retryCount: body.retryCount,
    },
    "[SMS-Delivery] Report received",
  );

  // Resolve tier best-effort so ops sees whether the failure is for
  // a lead or a verified pastoralist. Never blocks — falls back to
  // 'unknown' when Supabase lookup fails.
  let tier: "verified" | "lead" | "unknown" = "unknown";
  let wardId: string | null = null;
  try {
    if (phone) {
      const id = await identityForPhone(phone);
      tier = id?.tier ?? "unknown";
      wardId = id?.ward_id ?? null;
    }
  } catch (err) {
    logger.warn({ err: String(err) }, "[SMS-Delivery] identity lookup failed");
  }

  if (phone) {
    void logLeadInteraction({
      phone_number: phone,
      tier,
      channel: "sms",
      session_id: messageId || null,
      keyword: `delivery:${status.toLowerCase() || "unknown"}`,
      input_text: null,
      reply_text: body.failureReason ?? null,
      ward_id: wardId,
      raw_body: {
        status,
        networkCode: body.networkCode ?? null,
        retryCount: body.retryCount ?? null,
      },
    });
  }

  // AT wants a 200 acknowledgement. Body is ignored.
  res.status(200).json({ ok: true });
});

export default router;
