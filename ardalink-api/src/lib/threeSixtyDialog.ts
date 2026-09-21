/**
 * 360dialog outbound client — thin HTTP shim for the WhatsApp Business
 * Platform, via 360dialog's Cloud-API-compatible gateway.
 *
 *   sendWhatsappSessionMessage(phone, text)             → free-form text,
 *                                                          24h session window only
 *   sendWhatsappTemplate(phone, name, lang, components)  → the only way to
 *                                                          reach outside the window
 *   sendWhatsappInteractiveList(phone, ...)              → list menu (welcome screen)
 *   sendWhatsappInteractiveButtons(phone, ...)            → ≤3 quick-reply buttons
 *   sendWhatsappLocation(phone, lat, lon, ...)            → water-point pins
 *
 * All five POST to `${baseUrl}/messages` with a Meta Cloud API-shaped
 * JSON body — 360dialog's whole pitch is being a compatible passthrough,
 * so there's no new envelope grammar to invent here.
 *
 * Design rules baked in (mirrors src/lib/africastalking.ts):
 *
 *   1. Fail soft — every send returns { ok, ... } and NEVER throws.
 *
 *   2. Kill switch — WA_OUTBOUND_ENABLED='false' short-circuits every
 *      dispatch to a { ok:false, skipped:true, reason:'disabled' }
 *      result with a structured log line.
 *
 *   3. Rate limits — in-process caps:
 *          Templates      — 1 per phone per rolling 24h (WA_TEMPLATE_DAILY_CAP)
 *                            Proactive template sends are the riskiest/costliest
 *                            path (Meta per-conversation billing + quality
 *                            rating exposure), so this defaults conservative.
 *          Session msgs   — 20 per phone per rolling 1h (WA_SESSION_MSG_PER_HOUR_CAP)
 *                            Herder-initiated replies, not proactive spam risk,
 *                            so the cap is generous — mainly a runaway-loop guard.
 *
 *   4. Tier gate — sendWhatsappTemplate refuses to send when the caller
 *      passes tier:'unknown' (not in verified pastoralists AND not in
 *      pastoralist_leads), same rule AT's dispatchers apply.
 *
 * No SDK — a few fetch calls. Keeps the dependency graph small and
 * makes mocking in tests trivial (matching africastalking.ts's stated
 * rationale).
 */

import { logger } from "./logger.js";
import type {
  WaSendResult,
  WaTemplateComponent,
  WaListSection,
  WhatsappProvider,
} from "./whatsappProvider.js";
export type { WaSendResult, WaTemplateComponent, WaListSection };

// ── Config ──────────────────────────────────────────────────────────────

interface WaCfg {
  apiKey: string;
  baseUrl: string;
  phoneNumberId: string;
}

function cfg(): WaCfg {
  const apiKey = (process.env.THREESIXTYDIALOG_API_KEY ?? "").trim();
  const phoneNumberId = (
    process.env.THREESIXTYDIALOG_PHONE_NUMBER_ID ?? ""
  ).trim();
  if (!apiKey || !phoneNumberId) {
    throw new Error(
      "360dialog not configured — set THREESIXTYDIALOG_API_KEY + THREESIXTYDIALOG_PHONE_NUMBER_ID",
    );
  }
  const baseUrl = (
    process.env.THREESIXTYDIALOG_BASE_URL ?? "https://waba-v2.360dialog.io"
  )
    .trim()
    .replace(/\/$/, "");
  return { apiKey, baseUrl, phoneNumberId };
}

export function isThreeSixtyDialogConfigured(): boolean {
  return Boolean(
    process.env.THREESIXTYDIALOG_API_KEY &&
      process.env.THREESIXTYDIALOG_PHONE_NUMBER_ID,
  );
}

// ── Kill switch + rate limits ───────────────────────────────────────────

function outboundEnabled(): boolean {
  const v = (process.env.WA_OUTBOUND_ENABLED ?? "true").trim().toLowerCase();
  return v !== "false" && v !== "0" && v !== "no";
}

interface RateBucket {
  ts: number[];
}
const templateBuckets = new Map<string, RateBucket>();
const sessionMsgBuckets = new Map<string, RateBucket>();

const TEMPLATE_WINDOW_MS = 24 * 60 * 60 * 1000;
const TEMPLATE_MAX_PER_WINDOW = Number(
  process.env.WA_TEMPLATE_DAILY_CAP ?? "1",
);
const SESSION_MSG_WINDOW_MS = 60 * 60 * 1000;
const SESSION_MSG_MAX_PER_WINDOW = Number(
  process.env.WA_SESSION_MSG_PER_HOUR_CAP ?? "20",
);

function underRateLimit(
  buckets: Map<string, RateBucket>,
  phone: string,
  windowMs: number,
  maxPerWindow: number,
): boolean {
  const now = Date.now();
  const bucket = buckets.get(phone) ?? { ts: [] };
  bucket.ts = bucket.ts.filter((t) => now - t < windowMs);
  if (bucket.ts.length >= maxPerWindow) return false;
  bucket.ts.push(now);
  buckets.set(phone, bucket);
  return true;
}

// Only exported for tests — production callers use the send functions.
export function _resetRateLimits(): void {
  templateBuckets.clear();
  sessionMsgBuckets.clear();
}

// ── Public API ──────────────────────────────────────────────────────────

interface MetaErrorBody {
  error?: {
    message?: string;
    code?: number;
    error_subcode?: number;
  };
}

// Meta's "message outside the 24h customer service window" error code.
const OUTSIDE_WINDOW_ERROR_CODE = 131047;

/**
 * Shared POST + timeout + error-mapping + logging for all five message
 * shapes. Factored once here (unlike africastalking.ts's two near-
 * duplicate dispatchers) because this client has five, so the shared
 * scaffold pays for itself.
 */
async function postToGateway(
  payload: Record<string, unknown>,
  logCtx: Record<string, unknown>,
): Promise<WaSendResult> {
  const c = cfg();
  try {
    const res = await fetch(`${c.baseUrl}/messages`, {
      method: "POST",
      headers: {
        "D360-API-KEY": c.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
    const data = (await res.json().catch(() => ({}))) as MetaErrorBody & {
      messages?: Array<{ id?: string }>;
    };
    if (!res.ok) {
      const errorCode = data.error?.code;
      if (errorCode === OUTSIDE_WINDOW_ERROR_CODE) {
        logger.info(
          { ...logCtx, status: res.status, errorCode },
          "[360dialog] send rejected — outside 24h session window",
        );
        return {
          ok: false,
          reason: "outside_session_window",
          waResponse: data,
        };
      }
      logger.error(
        { ...logCtx, status: res.status, waResponse: data },
        "[360dialog] send failed with non-2xx",
      );
      return { ok: false, reason: "wa_error", waResponse: data };
    }
    const messageId = data.messages?.[0]?.id;
    logger.info({ ...logCtx, messageId }, "[360dialog] message dispatched");
    return { ok: true, waResponse: data, messageId, status: "sent" };
  } catch (err) {
    logger.error(
      { ...logCtx, err: String(err) },
      "[360dialog] send crashed",
    );
    return { ok: false, reason: "network_error" };
  }
}

/**
 * Free-form text reply. Only deliverable while the 24h customer-service
 * session window is open (i.e. in reply to an inbound message) — sends
 * outside the window come back with reason:'outside_session_window'.
 */
export async function sendWhatsappSessionMessage(
  phone: string,
  text: string,
  opts: { bypassRateLimit?: boolean } = {},
): Promise<WaSendResult> {
  if (!isThreeSixtyDialogConfigured()) {
    logger.warn(
      { phone },
      "[360dialog] sendWhatsappSessionMessage called but not configured — skipping",
    );
    return { ok: false, skipped: true, reason: "not_configured" };
  }
  if (!outboundEnabled()) {
    logger.info(
      { phone, wouldSend: text.slice(0, 60) },
      "[360dialog] outbound disabled — logging intended message only",
    );
    return { ok: false, skipped: true, reason: "disabled" };
  }
  if (
    !opts.bypassRateLimit &&
    !underRateLimit(
      sessionMsgBuckets,
      phone,
      SESSION_MSG_WINDOW_MS,
      SESSION_MSG_MAX_PER_WINDOW,
    )
  ) {
    logger.warn(
      { phone, cap: SESSION_MSG_MAX_PER_WINDOW },
      "[360dialog] session message rate limit hit — skipping",
    );
    return { ok: false, skipped: true, reason: "rate_limited" };
  }

  return postToGateway(
    {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: phone,
      type: "text",
      text: { body: text },
    },
    { phone, kind: "session_text" },
  );
}

/**
 * Approved-template send — the only way to reach a herder outside the
 * 24h session window (proactive drought alerts, opt-in, re-engagement).
 * Refuses to send when `tier==='unknown'`, mirroring AT's tier-gate
 * design rule so a bad phone-resolution bug can't spam random numbers
 * with billed template messages.
 */
export async function sendWhatsappTemplate(
  phone: string,
  templateName: string,
  languageCode: string,
  components: WaTemplateComponent[],
  opts: {
    tier?: "verified" | "lead" | "unknown";
    bypassRateLimit?: boolean;
  } = {},
): Promise<WaSendResult> {
  if (!isThreeSixtyDialogConfigured()) {
    return { ok: false, skipped: true, reason: "not_configured" };
  }
  if (!outboundEnabled()) {
    logger.info(
      { phone, templateName },
      "[360dialog] outbound disabled — logging intended template only",
    );
    return { ok: false, skipped: true, reason: "disabled" };
  }
  if (opts.tier === "unknown") {
    logger.warn(
      { phone, templateName },
      "[360dialog] refusing template send — tier unknown",
    );
    return { ok: false, skipped: true, reason: "unknown_tier" };
  }
  if (
    !opts.bypassRateLimit &&
    !underRateLimit(
      templateBuckets,
      phone,
      TEMPLATE_WINDOW_MS,
      TEMPLATE_MAX_PER_WINDOW,
    )
  ) {
    logger.warn(
      { phone, templateName, cap: TEMPLATE_MAX_PER_WINDOW },
      "[360dialog] template rate limit hit — skipping",
    );
    return { ok: false, skipped: true, reason: "rate_limited" };
  }

  return postToGateway(
    {
      messaging_product: "whatsapp",
      to: phone,
      type: "template",
      template: {
        name: templateName,
        language: { code: languageCode },
        components,
      },
    },
    { phone, kind: "template", templateName },
  );
}

/** Interactive list message — renders the welcome menu (Bula Pesa / Malisho / Ongea na AI). */
export async function sendWhatsappInteractiveList(
  phone: string,
  header: string,
  body: string,
  buttonText: string,
  sections: WaListSection[],
): Promise<WaSendResult> {
  if (!isThreeSixtyDialogConfigured()) {
    return { ok: false, skipped: true, reason: "not_configured" };
  }
  if (!outboundEnabled()) {
    return { ok: false, skipped: true, reason: "disabled" };
  }
  return postToGateway(
    {
      messaging_product: "whatsapp",
      to: phone,
      type: "interactive",
      interactive: {
        type: "list",
        header: { type: "text", text: header },
        body: { text: body },
        action: { button: buttonText, sections },
      },
    },
    { phone, kind: "interactive_list" },
  );
}

/** Interactive reply buttons — up to 3, per Meta's limit. */
export async function sendWhatsappInteractiveButtons(
  phone: string,
  body: string,
  buttons: Array<{ id: string; title: string }>,
): Promise<WaSendResult> {
  if (!isThreeSixtyDialogConfigured()) {
    return { ok: false, skipped: true, reason: "not_configured" };
  }
  if (!outboundEnabled()) {
    return { ok: false, skipped: true, reason: "disabled" };
  }
  return postToGateway(
    {
      messaging_product: "whatsapp",
      to: phone,
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: body },
        action: {
          buttons: buttons
            .slice(0, 3)
            .map((b) => ({ type: "reply", reply: { id: b.id, title: b.title } })),
        },
      },
    },
    { phone, kind: "interactive_buttons" },
  );
}

/**
 * Location pin — used for water points. Phase 0/1 has no herder-GPS
 * capture anywhere in the codebase, so `lat`/`lon` here is always a
 * ward centroid or a WPDx point, never the herder's own position —
 * callers should phrase `name`/`address` accordingly ("near <ward>
 * center"), not claim herder-precision.
 */
export async function sendWhatsappLocation(
  phone: string,
  lat: number,
  lon: number,
  name: string,
  address?: string,
): Promise<WaSendResult> {
  if (!isThreeSixtyDialogConfigured()) {
    return { ok: false, skipped: true, reason: "not_configured" };
  }
  if (!outboundEnabled()) {
    return { ok: false, skipped: true, reason: "disabled" };
  }
  return postToGateway(
    {
      messaging_product: "whatsapp",
      to: phone,
      type: "location",
      location: {
        latitude: lat,
        longitude: lon,
        name,
        address,
      },
    },
    { phone, kind: "location" },
  );
}

// ── WhatsappProvider adapter ────────────────────────────────────────────
// Delegates to the functions above unchanged — added so the registry can
// treat 360dialog and Evolution identically. Every named export above is
// untouched; this is purely additive.
export const threeSixtyDialogProvider: WhatsappProvider = {
  isConfigured: isThreeSixtyDialogConfigured,
  sendWhatsappSessionMessage,
  sendWhatsappTemplate,
  sendWhatsappInteractiveList,
  sendWhatsappInteractiveButtons,
  sendWhatsappLocation,
};
