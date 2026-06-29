import { Router, type IRouter } from "express";
import { logger } from "../lib/logger.js";

const router: IRouter = Router();

/**
 * POST /api/voice-callback
 *
 * Africa's Talking calls this HTTP endpoint when the outbound call connects.
 * We respond with a <Stream> XML instruction that tells AT to open a WebSocket
 * to our server and stream bidirectional audio in real-time.
 *
 * The WebSocket handler (src/lib/voiceStream.ts) bridges that audio directly
 * to the Azure OpenAI Realtime API — no pre-generated script, no recording
 * download, no separate Whisper call. The Realtime model conducts the full
 * conversation live and transcribes as it goes.
 */
router.post("/voice-callback", (req, res): void => {
  const body = req.body as Record<string, string>;
  const { callerNumber, destinationNumber, sessionId, direction } = body;

  // For an AT outbound call: destinationNumber = herder's phone
  const herderPhone = destinationNumber || callerNumber || "";
  const encodedPhone = encodeURIComponent(herderPhone);
  const streamUrl = `wss://${process.env.REPLIT_DEV_DOMAIN}/api/voice-stream?phone=${encodedPhone}`;

  req.log.info(
    { herderPhone, sessionId, direction, streamUrl },
    "Voice callback — returning Stream XML",
  );

  logger.info({ streamUrl }, "[Call Triggered] Handing off to Realtime stream");

  res.set("Content-Type", "text/xml");
  res.send(
    `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Stream url="${streamUrl}"/>\n</Response>`,
  );
});

export default router;
