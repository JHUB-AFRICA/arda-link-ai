import { Router, type IRouter } from "express";
import { logger } from "../lib/logger.js";

/**
 * Africa's Talking voice event webhook.
 *
 * AT POSTs form-encoded call lifecycle events to the URL registered
 * in the AT dashboard under Voice → Events. Events we expect:
 *
 *   - queued        call is queued waiting for the herder to pick up
 *   - ringing       the herder's phone is ringing
 *   - answered      the herder picked up
 *   - completed     call hung up cleanly (any direction)
 *   - failed        call could not connect (busy, no answer, network)
 *   - rejected      the herder declined
 *   - busy          the herder's line was busy
 *
 * Field shape (varies slightly by AT plan but the canonical set is):
 *   sessionId, callSessionState, callerNumber, destinationNumber,
 *   durationInSeconds, hangupCause, amount, currencyCode
 *
 * Sandbox note: AT's simulator fires `completed` after the synthetic
 * call ends. We accept ANY field shape and just log the parsed view so
 * a developer can see exactly what AT sent — invaluable when debugging
 * sandbox-vs-prod parity.
 *
 * The data we collect here is purely observability + audit. The actual
 * end-of-call indicator extraction already runs in voiceStream.ts the
 * moment the WebSocket tears down, so this endpoint does NOT need to
 * trigger any business logic — it just needs to ACK fast (200) so AT
 * doesn't retry.
 */
const router: IRouter = Router();

interface VoiceEventBody {
  sessionId?: string;
  callSessionState?: string;
  callerNumber?: string;
  destinationNumber?: string;
  durationInSeconds?: string | number;
  hangupCause?: string;
  amount?: string;
  currencyCode?: string;
}

router.post("/voice-events", (req, res): void => {
  const body = (req.body ?? {}) as VoiceEventBody;
  const state = body.callSessionState ?? "(unknown)";
  const duration =
    typeof body.durationInSeconds === "string"
      ? Number(body.durationInSeconds)
      : body.durationInSeconds ?? null;

  logger.info(
    {
      state,
      sessionId: body.sessionId ?? "(none)",
      caller: body.callerNumber ?? "(?)",
      destination: body.destinationNumber ?? "(?)",
      durationSeconds: duration,
      hangupCause: body.hangupCause ?? null,
      cost: body.amount ?? null,
      currency: body.currencyCode ?? null,
    },
    "[VoiceEvents] AT call lifecycle event",
  );

  // AT expects 200 within a few seconds. Send a minimal OK.
  res.status(200).json({ ok: true });
});

export default router;
