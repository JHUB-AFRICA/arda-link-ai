/**
 * Evolution API outbound client — thin HTTP shim for a self-hosted
 * Evolution API instance (github.com/EvolutionAPI/evolution-api),
 * optionally backed by Meta's Cloud API (`integration: "WHATSAPP-BUSINESS"`
 * on the instance, set up out-of-band via Evolution's own
 * `POST /instance/create`).
 *
 * IMPORTANT — unlike 360dialog, Evolution API is NOT Meta-Cloud-API-shaped
 * on the wire, even when its backend is Cloud API. It has its own
 * simplified JSON envelope for both sending and receiving; the real Meta
 * payload only exists inside Evolution's own process, translated before
 * it talks to graph.facebook.com. Confirmed against Evolution's source
 * (v2.3.7) — see the DTOs referenced per-function below. Payload-building
 * here is intentionally NOT shared with threeSixtyDialog.ts.
 *
 *   sendWhatsappSessionMessage(phone, text)             → POST /message/sendText/:instance
 *   sendWhatsappTemplate(phone, name, lang, components)  → POST /message/sendTemplate/:instance
 *                                                          (Cloud-API-backed instances only)
 *   sendWhatsappInteractiveList(phone, ...)              → POST /message/sendList/:instance
 *   sendWhatsappInteractiveButtons(phone, ...)            → POST /message/sendButtons/:instance
 *   sendWhatsappLocation(phone, lat, lon, ...)            → POST /message/sendLocation/:instance
 *
 * Design rules baked in (mirrors src/lib/threeSixtyDialog.ts /
 * src/lib/africastalking.ts):
 *
 *   1. Fail soft — every send returns { ok, ... } and NEVER throws.
 *
 *   2. Kill switch — WA_OUTBOUND_ENABLED='false' short-circuits every
 *      dispatch, same env var as the 360dialog client (provider-agnostic).
 *
 *   3. Rate limits — same env var names as threeSixtyDialog.ts
 *      (WA_TEMPLATE_DAILY_CAP, WA_SESSION_MSG_PER_HOUR_CAP) so operators
 *      configure one cap regardless of active provider, but this module
 *      keeps its OWN independent in-process buckets — deliberately not
 *      shared/imported from threeSixtyDialog.ts, so the two providers
 *      never accidentally cross-throttle each other and this module has
 *      zero import-time dependency on the other provider. A live
 *      WA_PROVIDER switch therefore doesn't carry over rate-limit
 *      history — acceptable, since provider switches are a deploy-time/
 *      restart event, not a runtime toggle.
 *
 *   4. Tier gate — sendWhatsappTemplate refuses to send when the caller
 *      passes tier:'unknown', same rule as threeSixtyDialog.ts.
 *
 * KNOWN GAP: no `outside_session_window` detection. 360dialog's client
 * special-cases Meta's raw error code 131047 because it receives Meta's
 * error body verbatim; Evolution's error-body shape on a session-window
 * violation was not confirmed against source or a live instance, so
 * every non-2xx here maps to the generic `wa_error` reason. This means
 * channelTier.ts's "not on WhatsApp" detection (which inspects
 * `waResponse.error.code`) will NOT correctly downgrade a herder's tier
 * when Evolution is the active provider, until this is verified against
 * a real deployment and special-cased here.
 *
 * No SDK — a few fetch calls, matching the other clients' rationale.
 */

import { logger } from "./logger.js";
import type {
  WaSendResult,
  WaTemplateComponent,
  WaListSection,
  WhatsappProvider,
} from "./whatsappProvider.js";

// ── Config ──────────────────────────────────────────────────────────────

interface EvoCfg {
  apiKey: string;
  baseUrl: string;
  instanceName: string;
}

function cfg(): EvoCfg {
  const apiKey = (process.env.EVOLUTION_API_KEY ?? "").trim();
  const instanceName = (process.env.EVOLUTION_INSTANCE_NAME ?? "").trim();
  if (!apiKey || !instanceName) {
    throw new Error(
      "Evolution API not configured — set EVOLUTION_API_KEY + EVOLUTION_INSTANCE_NAME",
    );
  }
  const baseUrl = (
    process.env.EVOLUTION_API_BASE_URL ?? "http://localhost:8080"
  )
    .trim()
    .replace(/\/$/, "");
  return { apiKey, baseUrl, instanceName };
}

export function isEvolutionApiConfigured(): boolean {
  return Boolean(
    process.env.EVOLUTION_API_KEY && process.env.EVOLUTION_INSTANCE_NAME,
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

// ── Payload remapping (Evolution's field names differ from Meta's) ──────

/** Evolution's `number` field is digits-only, no leading '+'. */
function toEvoNumber(phone: string): string {
  return phone.replace(/^\+/, "");
}

/** WaListSection.rows[].id -> Evolution's `rowId`. */
function toEvoSections(sections: WaListSection[]) {
  return sections.map((s) => ({
    title: s.title,
    rows: s.rows.map((r) => ({
      title: r.title,
      description: r.description,
      rowId: r.id,
    })),
  }));
}

/** {id, title} -> Evolution's {type:"reply", displayText, id}. */
function toEvoButtons(buttons: Array<{ id: string; title: string }>) {
  return buttons.slice(0, 3).map((b) => ({
    type: "reply" as const,
    displayText: b.title,
    id: b.id,
  }));
}

// ── Public API ──────────────────────────────────────────────────────────

interface EvoErrorBody {
  message?: string | string[];
  error?: string;
  statusCode?: number;
}

/**
 * Shared POST + timeout + error-mapping + logging for all five message
 * shapes, same role as threeSixtyDialog.ts's postToGateway().
 */
async function postToGateway(
  action: string,
  payload: Record<string, unknown>,
  logCtx: Record<string, unknown>,
): Promise<WaSendResult> {
  const c = cfg();
  try {
    const res = await fetch(`${c.baseUrl}/message/${action}/${c.instanceName}`, {
      method: "POST",
      headers: {
        apikey: c.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
    const data = (await res.json().catch(() => ({}))) as EvoErrorBody & {
      key?: { id?: string };
      status?: string;
    };
    if (!res.ok) {
      // KNOWN GAP: no outside_session_window detection — see file header.
      logger.error(
        { ...logCtx, status: res.status, waResponse: data },
        "[Evolution] send failed with non-2xx",
      );
      return { ok: false, reason: "wa_error", waResponse: data };
    }
    const messageId = data.key?.id;
    logger.info({ ...logCtx, messageId }, "[Evolution] message dispatched");
    return {
      ok: true,
      waResponse: data,
      messageId,
      status: data.status ?? "sent",
    };
  } catch (err) {
    logger.error({ ...logCtx, err: String(err) }, "[Evolution] send crashed");
    return { ok: false, reason: "network_error" };
  }
}

/**
 * Free-form text reply via `POST /message/sendText/:instance`.
 * Evolution doesn't itself enforce the 24h window client-side, but a
 * Cloud-API-backed instance will still be rejected by Meta outside it —
 * see the KNOWN GAP note in the file header re: detecting that failure.
 */
export async function sendWhatsappSessionMessage(
  phone: string,
  text: string,
  opts: { bypassRateLimit?: boolean } = {},
): Promise<WaSendResult> {
  if (!isEvolutionApiConfigured()) {
    logger.warn(
      { phone },
      "[Evolution] sendWhatsappSessionMessage called but not configured — skipping",
    );
    return { ok: false, skipped: true, reason: "not_configured" };
  }
  if (!outboundEnabled()) {
    logger.info(
      { phone, wouldSend: text.slice(0, 60) },
      "[Evolution] outbound disabled — logging intended message only",
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
      "[Evolution] session message rate limit hit — skipping",
    );
    return { ok: false, skipped: true, reason: "rate_limited" };
  }

  return postToGateway(
    "sendText",
    { number: toEvoNumber(phone), text, linkPreview: true },
    { phone, kind: "session_text" },
  );
}

/**
 * Approved-template send. Only meaningful for Cloud-API-backed instances
 * (Baileys-mode instances have no Meta-template concept). Refuses to
 * send when tier==='unknown', same rule as threeSixtyDialog.ts.
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
  if (!isEvolutionApiConfigured()) {
    return { ok: false, skipped: true, reason: "not_configured" };
  }
  if (!outboundEnabled()) {
    logger.info(
      { phone, templateName },
      "[Evolution] outbound disabled — logging intended template only",
    );
    return { ok: false, skipped: true, reason: "disabled" };
  }
  if (opts.tier === "unknown") {
    logger.warn(
      { phone, templateName },
      "[Evolution] refusing template send — tier unknown",
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
      "[Evolution] template rate limit hit — skipping",
    );
    return { ok: false, skipped: true, reason: "rate_limited" };
  }

  return postToGateway(
    "sendTemplate",
    {
      number: toEvoNumber(phone),
      name: templateName,
      language: languageCode,
      components,
    },
    { phone, kind: "template", templateName },
  );
}

/** Interactive list message — renders the welcome menu. */
export async function sendWhatsappInteractiveList(
  phone: string,
  header: string,
  body: string,
  buttonText: string,
  sections: WaListSection[],
): Promise<WaSendResult> {
  if (!isEvolutionApiConfigured()) {
    return { ok: false, skipped: true, reason: "not_configured" };
  }
  if (!outboundEnabled()) {
    return { ok: false, skipped: true, reason: "disabled" };
  }
  return postToGateway(
    "sendList",
    {
      number: toEvoNumber(phone),
      title: header,
      description: body,
      footerText: "",
      buttonText,
      sections: toEvoSections(sections),
    },
    { phone, kind: "interactive_list" },
  );
}

/** Interactive reply buttons — up to 3, same limit as 360dialog's client. */
export async function sendWhatsappInteractiveButtons(
  phone: string,
  body: string,
  buttons: Array<{ id: string; title: string }>,
): Promise<WaSendResult> {
  if (!isEvolutionApiConfigured()) {
    return { ok: false, skipped: true, reason: "not_configured" };
  }
  if (!outboundEnabled()) {
    return { ok: false, skipped: true, reason: "disabled" };
  }
  return postToGateway(
    "sendButtons",
    {
      number: toEvoNumber(phone),
      title: "",
      description: body,
      footer: "",
      buttons: toEvoButtons(buttons),
    },
    { phone, kind: "interactive_buttons" },
  );
}

/** Location pin — used for water points, same caveats as threeSixtyDialog.ts's version. */
export async function sendWhatsappLocation(
  phone: string,
  lat: number,
  lon: number,
  name: string,
  address?: string,
): Promise<WaSendResult> {
  if (!isEvolutionApiConfigured()) {
    return { ok: false, skipped: true, reason: "not_configured" };
  }
  if (!outboundEnabled()) {
    return { ok: false, skipped: true, reason: "disabled" };
  }
  return postToGateway(
    "sendLocation",
    {
      number: toEvoNumber(phone),
      latitude: lat,
      longitude: lon,
      name,
      address,
    },
    { phone, kind: "location" },
  );
}

// ── WhatsappProvider adapter ────────────────────────────────────────────
export const evolutionApiProvider: WhatsappProvider = {
  isConfigured: isEvolutionApiConfigured,
  sendWhatsappSessionMessage,
  sendWhatsappTemplate,
  sendWhatsappInteractiveList,
  sendWhatsappInteractiveButtons,
  sendWhatsappLocation,
};
