import { Router, type IRouter, type Request } from "express";
import { logger } from "../lib/logger.js";
import { getLastResult } from "../lib/intelligence.js";
import { processDeterministicVoiceRecording } from "../lib/voiceDeterministicPipeline.js";

const router: IRouter = Router();

type CallMode = "realtime" | "deterministic";

/**
 * Dual-mode voice callback.
 *
 * Africa's Talking calls this HTTP endpoint at every stage of an inbound
 * or outbound call. Two flows are supported, selected by
 * `CALL_PIPELINE_MODE` (env, default `deterministic`) or a `?mode=`
 * query parameter on the callback URL:
 *
 * 1) **realtime** — return a `<Stream>` XML instruction so AT opens a
 *    WebSocket to `/api/voice-stream`, which bridges audio to Azure
 *    OpenAI Realtime for a full-duplex conversation. Best voice UX but
 *    depends on a Realtime deployment and good bandwidth. See
 *    `src/lib/voiceStream.ts` for the bridge itself.
 *
 * 2) **deterministic** — a three-stage flow using AT's built-in
 *    `<Say>`, `<GetDigits>`, and `<Record>` primitives:
 *
 *      opener → DTMF category menu → 20s recording → server-side
 *      Azure Speech (fast transcription) → LLM indicator extraction →
 *      ground-truth row in Postgres.
 *
 *    Works on 2G, works with `gpt-5-mini` (no Realtime deployment
 *    needed), and guarantees a ground-truth row per call — the
 *    herder-usable production path.
 */
router.post("/voice-callback", async (req, res): Promise<void> => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const { callerNumber, destinationNumber, sessionId, direction } = body as {
    callerNumber?: string;
    destinationNumber?: string;
    sessionId?: string;
    direction?: string;
  };
  const stage = getParam(req.query.stage).toLowerCase() || "opener";
  const mode = resolveCallMode(req);
  const base = resolvePublicBase(req);

  if (!base && mode === "deterministic") {
    req.log.error(
      { sessionId, direction },
      "voice-callback: cannot determine public host for deterministic callbacks",
    );
    res.status(500).type("text/plain").send("Voice callback host is not configured");
    return;
  }

  if (mode === "deterministic") {
    const callbackBase = `${base}/api/voice-callback?mode=deterministic`;

    // Stage 1 — value-first opener + DTMF menu.
    if (stage === "opener") {
      const opener = xmlEscape(buildValueFirstOpener());
      const xml = asXml(
        `  <Say>${opener}</Say>\n` +
          `  <GetDigits timeout="10" numDigits="1" callbackUrl="${xmlEscape(
            `${callbackBase}&stage=dtmf`,
          )}">\n` +
          `    <Say>Press 1 for body condition, 2 for water point status, 3 for mortality, 4 for feeding, 5 for milk production, 6 for water trek distance, 7 for other drought indicator.</Say>\n` +
          `  </GetDigits>\n` +
          `  <Say>No key was received. Asante, kwaheri.</Say>`,
      );
      req.log.info(
        { sessionId, direction, mode },
        "voice-callback deterministic stage=opener",
      );
      res.type("text/xml").send(xml);
      return;
    }

    // Stage 2 — read DTMF, prompt for a 20s recording, add a category tag
    // to the callback URL so we know what the herder was asked about.
    if (stage === "dtmf") {
      const digits = readBodyValue(body, [
        "dtmfDigits",
        "digits",
        "Digits",
        "dtmf",
      ]);
      const category = mapIndicatorCategory(digits);
      const xml = asXml(
        `  <Say>You selected ${xmlEscape(
          category.label,
        )}. Please speak after the beep. Press hash to finish.</Say>\n` +
          `  <Record maxLength="20" finishOnKey="#" playBeep="true" callbackUrl="${xmlEscape(
            `${callbackBase}&stage=recorded&category=${category.id}`,
          )}"/>`,
      );
      req.log.info(
        { sessionId, digits, category: category.id },
        "voice-callback deterministic stage=dtmf",
      );
      res.type("text/xml").send(xml);
      return;
    }

    // Stage 3 — recording ready. Kick off the async pipeline; respond
    // with a short thank-you immediately so AT can end the call cleanly.
    if (stage === "recorded") {
      const recordingUrl = readBodyValue(body, [
        "recordingUrl",
        "RecordingUrl",
        "recording_url",
        "recording",
      ]);
      const duration = readBodyValue(body, [
        "durationInSeconds",
        "DurationInSeconds",
        "duration",
        "recordingDuration",
      ]);
      const category = getParam(req.query.category) || "unknown";
      const durationSeconds = (() => {
        const parsed = Number.parseInt(duration, 10);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
      })();
      const categoryLabel = indicatorLabelFromId(category);

      req.log.info(
        {
          sessionId,
          category,
          recordingUrl,
          duration: durationSeconds,
          callerNumber,
          destinationNumber,
        },
        "voice-callback deterministic stage=recorded (Speech + LLM pipeline queued)",
      );

      if (recordingUrl) {
        // Africa's Talking POSTs form-encoded bodies where `+` in the
        // phone value is decoded to a space. Canonicalize back to E.164
        // before persistence — the DB uses `+254…` throughout.
        const phone = normalizeAtPhone(destinationNumber || callerNumber || "");
        // Fire-and-forget: AT is waiting for our XML response, we don't
        // hold it while STT + LLM run (can take 5–10 s each).
        void processDeterministicVoiceRecording({
          sessionId: typeof sessionId === "string" ? sessionId : null,
          phone,
          recordingUrl,
          durationSeconds,
          categoryId: category,
          categoryLabel,
        });
      } else {
        req.log.warn(
          { sessionId, category },
          "voice-callback deterministic stage=recorded without recording URL",
        );
      }

      const xml = asXml(
        `  <Say>Thank you. Your report is being transcribed by ArdaLink. Asante sana, kwaheri.</Say>`,
      );
      res.type("text/xml").send(xml);
      return;
    }

    // Unknown stage — reset the flow gracefully.
    const xml = asXml(
      `  <Say>ArdaLink call flow reset. Please call again.</Say>`,
    );
    res.type("text/xml").send(xml);
    return;
  }

  // ── Realtime mode (legacy path) ───────────────────────────────────────
  const herderPhone = normalizeAtPhone(destinationNumber || callerNumber || "") ?? "";
  const encodedPhone = encodeURIComponent(herderPhone);
  const wsProto = base.startsWith("http://") ? "ws" : "wss";
  const host = (base || `http://${req.header("host") ?? "localhost:3000"}`)
    .replace(/^https?:\/\//, "");
  const streamUrl = `${wsProto}://${host}/api/voice-stream?phone=${encodedPhone}`;

  req.log.info(
    { herderPhone, sessionId, direction, streamUrl, mode },
    "voice-callback — returning Stream XML (realtime mode)",
  );
  logger.info(
    { streamUrl },
    "[Call Triggered] Handing off to Realtime stream",
  );

  res.set("Content-Type", "text/xml");
  res.send(
    `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Stream url="${streamUrl}"/>\n</Response>`,
  );
});

// ── Helpers ────────────────────────────────────────────────────────────────

function resolveCallMode(req: Request): CallMode {
  const explicit = getParam(req.query.mode).toLowerCase();
  if (explicit === "deterministic" || explicit === "realtime") return explicit;
  const envMode = (
    process.env.CALL_PIPELINE_MODE ||
    process.env.ARDALINK_CALL_MODE ||
    "deterministic"
  ).toLowerCase();
  return envMode === "realtime" ? "realtime" : "deterministic";
}

function resolvePublicBase(req: Request): string {
  const envHost =
    process.env.PUBLIC_APP_HOST?.trim() ||
    process.env.REPLIT_DEV_DOMAIN?.trim() ||
    "";
  const headerHost =
    req.header("x-forwarded-host") || req.header("host") || "";
  const host = (envHost || headerHost).replace(/\s/g, "");
  const protoHeader = (
    req.header("x-forwarded-proto") ||
    req.protocol ||
    "https"
  ).toLowerCase();
  const proto = protoHeader === "http" ? "http" : "https";
  return host ? `${proto}://${host}` : "";
}

/**
 * Africa's Talking POSTs application/x-www-form-urlencoded webhooks. The
 * Express urlencoded parser follows the standard and decodes `+` as a
 * literal space — so `phoneNumber=+254712000004` arrives as ` 254712000004`
 * on `req.body`. Recover the leading `+` and drop stray whitespace so the
 * DB always sees canonical E.164.
 */
function normalizeAtPhone(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().replace(/\s+/g, "");
  if (!trimmed) return null;
  if (trimmed.startsWith("+")) return trimmed;
  if (/^\d+$/.test(trimmed)) return "+" + trimmed;
  return trimmed;
}

function getParam(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return "";
}

function readBodyValue(
  body: Record<string, unknown>,
  keys: string[],
): string {
  for (const key of keys) {
    const value = body[key];
    if (typeof value === "string" && value.trim().length > 0)
      return value.trim();
  }
  return "";
}

function asXml(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n${body}\n</Response>`;
}

function xmlEscape(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function buildValueFirstOpener(): string {
  const last = getLastResult();
  const stressedPct = last?.live?.anomaly?.wardStressedPixelPct;
  const month = last?.month_name ?? "this month";
  const risk = last?.forecast?.outlook.riskLevel;
  if (typeof stressedPct === "number") {
    const riskBit = risk ? `, drought risk ${risk}` : "";
    return `Habari. This is ArdaLink calling about pasture conditions in Bula Pesa for ${month}. About ${stressedPct.toFixed(
      0,
    )} percent of grazing land is stressed${riskBit}. We would like your report.`;
  }
  return "Habari. This is ArdaLink calling about pasture conditions. We would like your report.";
}

function mapIndicatorCategory(digits: string): { id: string; label: string } {
  const d = digits.replace(/\D/g, "");
  if (d === "1") return { id: "bcs", label: "body condition score" };
  if (d === "2") return { id: "water_point", label: "water-point status" };
  if (d === "3") return { id: "mortality", label: "mortality" };
  if (d === "4") return { id: "feeding", label: "supplementary feeding" };
  if (d === "5") return { id: "milk", label: "milk production" };
  if (d === "6") return { id: "water_trek", label: "water trek distance" };
  return { id: "drought_signal", label: "drought indicator" };
}

function indicatorLabelFromId(id: string): string {
  switch (id) {
    case "bcs":
      return "body condition score";
    case "water_point":
      return "water-point status";
    case "mortality":
      return "mortality";
    case "feeding":
      return "supplementary feeding";
    case "milk":
      return "milk production";
    case "water_trek":
      return "water trek distance";
    default:
      return "drought indicator";
  }
}

export default router;
