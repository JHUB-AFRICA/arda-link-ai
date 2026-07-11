/**
 * Africa's Talking outbound client — thin HTTP shim for the two REST
 * endpoints ArdaLink needs to close the loop.
 *
 *   sendSmsViaAt(phone, message)     → POST /version1/messaging
 *   initiateOutboundCall(phone)      → POST /call
 *
 * Design rules baked in (per 2026-07-11 pilot decisions):
 *
 *   1. Sandbox aware — when AFRICASTALKING_USERNAME='sandbox' we hit
 *      api.sandbox.africastalking.com so dispatches land in the AT
 *      simulator UI, not real handsets. Production tenants get the
 *      live api.africastalking.com host automatically.
 *
 *   2. Fail soft — every send returns { ok, ... } and NEVER throws.
 *      Callers use the result to decide whether to log, retry, or
 *      surface a warning, but a bad AT response never blocks the
 *      caller's own work (voice call still ends, USSD reply still
 *      goes back).
 *
 *   3. Kill switch — AT_OUTBOUND_ENABLED='false' short-circuits every
 *      dispatch to a { ok:false, skipped:true, reason:'disabled' }
 *      result WITH a structured log line so operators can watch what
 *      WOULD have gone out. Useful during dry-run demos or after an
 *      abuse incident.
 *
 *   4. Rate limits — in-process caps so a runaway loop can't ring a
 *      pastoralist 40 times:
 *          SMS   — 3 per phone per rolling 24 h
 *          Voice — 1 per phone per rolling 15 min
 *      Hitting a cap logs at warn level and returns
 *      { ok:false, skipped:true, reason:'rate_limited' }.
 *
 *   5. Tier gate — dispatchers refuse to send to phones with
 *      `tier='unknown'` (not in verified pastoralists AND not in
 *      pastoralist_leads). Prevents random-number spam if a bug
 *      leaks an unresolved phone into the sender.
 *
 * No SDK — a few fetch calls. Keeps the dependency graph small and
 * makes mocking in tests trivial.
 */

import { logger } from "./logger.js";

// ── Config ──────────────────────────────────────────────────────────────

interface AtCfg {
  username: string;
  apiKey: string;
  senderId: string;
  isSandbox: boolean;
  smsHost: string;
  voiceHost: string;
}

function cfg(): AtCfg {
  const username = (process.env.AFRICASTALKING_USERNAME ?? "").trim();
  const apiKey = (process.env.AFRICASTALKING_API_KEY ?? "").trim();
  const senderId = (process.env.AFRICASTALKING_CALLER_ID ?? "").trim();
  if (!username || !apiKey) {
    throw new Error(
      "Africa's Talking not configured — set AFRICASTALKING_USERNAME + AFRICASTALKING_API_KEY",
    );
  }
  const isSandbox = username.toLowerCase() === "sandbox";
  return {
    username,
    apiKey,
    senderId,
    isSandbox,
    // SMS host is split at sandbox/production. Voice is not — AT
    // uses a single voice.africastalking.com endpoint for both
    // environments and distinguishes them by the api key. There is
    // no voice.sandbox.africastalking.com subdomain (verified 2026-07-11
    // — DNS returns NXDOMAIN).
    smsHost: isSandbox
      ? "https://api.sandbox.africastalking.com"
      : "https://api.africastalking.com",
    voiceHost: "https://voice.africastalking.com",
  };
}

export function isAtConfigured(): boolean {
  return Boolean(
    process.env.AFRICASTALKING_USERNAME && process.env.AFRICASTALKING_API_KEY,
  );
}

// ── Kill switch + rate limits ───────────────────────────────────────────

function outboundEnabled(): boolean {
  const v = (process.env.AT_OUTBOUND_ENABLED ?? "true").trim().toLowerCase();
  return v !== "false" && v !== "0" && v !== "no";
}

interface RateBucket {
  // Array of dispatch epoch-ms timestamps within the window.
  ts: number[];
}
const smsBuckets = new Map<string, RateBucket>();
const voiceBuckets = new Map<string, RateBucket>();

const SMS_WINDOW_MS = 24 * 60 * 60 * 1000;
const SMS_MAX_PER_WINDOW = Number(process.env.AT_SMS_DAILY_CAP ?? "3");
const VOICE_WINDOW_MS = 15 * 60 * 1000;
const VOICE_MAX_PER_WINDOW = Number(process.env.AT_VOICE_15MIN_CAP ?? "1");

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

// Only exported for tests — production callers use sendSmsViaAt.
export function _resetRateLimits(): void {
  smsBuckets.clear();
  voiceBuckets.clear();
}

// ── Public API ──────────────────────────────────────────────────────────

export interface AtSendResult {
  ok: boolean;
  skipped?: boolean;
  reason?:
    | "disabled"
    | "rate_limited"
    | "not_configured"
    | "at_error"
    | "network_error";
  atResponse?: unknown;
  messageId?: string;
  cost?: string;
  status?: string;
}

/**
 * Send a single outbound SMS to `phone` via AT. Message is trimmed to
 * a single 160-char GSM-7 segment (approximately) so the herder isn't
 * billed for multi-part concatenation surprises. Callers that need
 * longer bodies should split themselves.
 */
export async function sendSmsViaAt(
  phone: string,
  message: string,
  opts: { bypassRateLimit?: boolean } = {},
): Promise<AtSendResult> {
  if (!isAtConfigured()) {
    logger.warn(
      { phone },
      "[AT] sendSmsViaAt called but AT not configured — skipping",
    );
    return { ok: false, skipped: true, reason: "not_configured" };
  }
  if (!outboundEnabled()) {
    logger.info(
      { phone, wouldSend: message.slice(0, 60) },
      "[AT] outbound disabled — logging intended SMS only",
    );
    return { ok: false, skipped: true, reason: "disabled" };
  }
  if (
    !opts.bypassRateLimit &&
    !underRateLimit(smsBuckets, phone, SMS_WINDOW_MS, SMS_MAX_PER_WINDOW)
  ) {
    logger.warn(
      { phone, cap: SMS_MAX_PER_WINDOW, windowMs: SMS_WINDOW_MS },
      "[AT] SMS rate limit hit — skipping",
    );
    return { ok: false, skipped: true, reason: "rate_limited" };
  }

  const c = cfg();
  const body = new URLSearchParams({
    username: c.username,
    to: phone,
    message: message.slice(0, 160),
  });
  if (c.senderId) body.set("from", c.senderId);

  try {
    const res = await fetch(`${c.smsHost}/version1/messaging`, {
      method: "POST",
      headers: {
        apiKey: c.apiKey,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: body.toString(),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      logger.error(
        { status: res.status, body: text.slice(0, 300), phone },
        "[AT] SMS send failed with non-2xx",
      );
      return {
        ok: false,
        reason: "at_error",
        atResponse: text.slice(0, 300),
      };
    }
    const data = (await res.json()) as {
      SMSMessageData?: {
        Message?: string;
        Recipients?: Array<{
          number?: string;
          status?: string;
          messageId?: string;
          cost?: string;
        }>;
      };
    };
    const recipient = data.SMSMessageData?.Recipients?.[0];
    logger.info(
      {
        phone,
        atStatus: recipient?.status,
        messageId: recipient?.messageId,
        cost: recipient?.cost,
      },
      "[AT] SMS dispatched",
    );
    return {
      ok: recipient?.status === "Success" || recipient?.status === "Sent",
      atResponse: data,
      messageId: recipient?.messageId,
      cost: recipient?.cost,
      status: recipient?.status,
    };
  } catch (err) {
    logger.error({ err: String(err), phone }, "[AT] SMS send crashed");
    return { ok: false, reason: "network_error" };
  }
}

/**
 * Initiate an outbound voice call to `phone`. AT rings the caller,
 * and when they pick up it POSTs to our voice callback URL — the
 * same handler that services inbound calls, so the deterministic
 * pipeline (opener → DTMF → record → extract) runs untouched.
 *
 * The `from` field is the caller ID configured on the AT account
 * (AFRICASTALKING_CALLER_ID) — for sandbox this is the shared
 * virtual number +254711082200.
 */
export async function initiateOutboundCall(
  phone: string,
  opts: { bypassRateLimit?: boolean } = {},
): Promise<AtSendResult> {
  if (!isAtConfigured()) {
    return { ok: false, skipped: true, reason: "not_configured" };
  }
  if (!outboundEnabled()) {
    logger.info({ phone }, "[AT] outbound disabled — logging intended call");
    return { ok: false, skipped: true, reason: "disabled" };
  }
  if (
    !opts.bypassRateLimit &&
    !underRateLimit(
      voiceBuckets,
      phone,
      VOICE_WINDOW_MS,
      VOICE_MAX_PER_WINDOW,
    )
  ) {
    logger.warn(
      { phone, cap: VOICE_MAX_PER_WINDOW, windowMs: VOICE_WINDOW_MS },
      "[AT] Voice rate limit hit — skipping",
    );
    return { ok: false, skipped: true, reason: "rate_limited" };
  }

  const c = cfg();
  if (!c.senderId) {
    logger.error(
      { phone },
      "[AT] AFRICASTALKING_CALLER_ID unset — cannot initiate outbound call",
    );
    return { ok: false, reason: "not_configured" };
  }

  const body = new URLSearchParams({
    username: c.username,
    from: c.senderId,
    to: phone,
  });

  try {
    const res = await fetch(`${c.voiceHost}/call`, {
      method: "POST",
      headers: {
        apiKey: c.apiKey,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: body.toString(),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      logger.error(
        { status: res.status, body: text.slice(0, 300), phone },
        "[AT] outbound call failed with non-2xx",
      );
      return { ok: false, reason: "at_error", atResponse: text.slice(0, 300) };
    }
    const data = (await res.json()) as {
      entries?: Array<{ status?: string; sessionId?: string; phoneNumber?: string }>;
      errorMessage?: string;
    };
    const entry = data.entries?.[0];
    if (data.errorMessage && data.errorMessage !== "None") {
      logger.warn(
        { phone, errorMessage: data.errorMessage },
        "[AT] outbound call returned errorMessage",
      );
      return { ok: false, reason: "at_error", atResponse: data };
    }
    logger.info(
      { phone, atStatus: entry?.status, sessionId: entry?.sessionId },
      "[AT] outbound call initiated",
    );
    return {
      ok: entry?.status === "Queued" || entry?.status === "Success",
      atResponse: data,
      messageId: entry?.sessionId,
      status: entry?.status,
    };
  } catch (err) {
    logger.error({ err: String(err), phone }, "[AT] outbound call crashed");
    return { ok: false, reason: "network_error" };
  }
}
