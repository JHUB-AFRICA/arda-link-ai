/**
 * Channel-tier resolver — decides whether a herder's phone should be
 * treated as WhatsApp-reachable, and re-checks every 30 days per the
 * strategic plan's tiering policy (Arda-link-AI-Docs/whatsapp-first-
 * architecture.md, "Channel tiering strategy").
 *
 * Probing works by attempting to send the always-approved, low-
 * frequency `re_engagement_check` template (the same template the
 * strategy doc calls for) and inspecting the result: a `wa_error`
 * matching Meta's "recipient not on WhatsApp" error class downgrades
 * the tier to `voice`; `ok:true` or a rate-limited/skip result (still
 * presumed reachable, just throttled) keeps `whatsapp`.
 *
 * No user-facing route in Phase 0/1 — this is a library the alert-
 * dispatch loop calls before each send so a stale tier doesn't waste a
 * billed template on a now-unreachable number.
 */

import { eq } from "drizzle-orm";
import { db, pastoralistsTable, type PastoralistChannelTier } from "@workspace/db";
import { logger } from "./logger.js";
import { sendWhatsappTemplate } from "./threeSixtyDialog.js";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const RE_ENGAGEMENT_TEMPLATE = "re_engagement_check";

// Meta error codes indicating the recipient isn't reachable on
// WhatsApp at all (as opposed to a transient/rate-limit failure).
const NOT_ON_WHATSAPP_ERROR_CODES = new Set([131026, 131030]);

export interface ChannelTierResolution {
  tier: PastoralistChannelTier;
  probed: boolean;
}

function isStale(lastCheckAt: Date | null): boolean {
  if (!lastCheckAt) return true;
  return Date.now() - lastCheckAt.getTime() > THIRTY_DAYS_MS;
}

/**
 * Re-check (or set for the first time) a phone's channel tier. Only
 * actually probes WhatsApp when the existing `last_tier_check_at` is
 * null or >30 days old — callers can invoke this liberally without
 * worrying about spamming re-engagement templates.
 */
export async function resolveChannelTier(
  phone: string,
): Promise<ChannelTierResolution> {
  const normalized = phone.replace(/\s+/g, "").trim();
  const existing = await db
    .select({
      channelTier: pastoralistsTable.channelTier,
      lastTierCheckAt: pastoralistsTable.lastTierCheckAt,
    })
    .from(pastoralistsTable)
    .where(eq(pastoralistsTable.phone, normalized))
    .limit(1);

  const current = existing[0];
  const currentTier = (current?.channelTier as PastoralistChannelTier) ?? "sms";

  if (current && !isStale(current.lastTierCheckAt ?? null)) {
    return { tier: currentTier, probed: false };
  }

  const probeResult = await sendWhatsappTemplate(
    normalized,
    RE_ENGAGEMENT_TEMPLATE,
    "sw",
    [],
    { bypassRateLimit: true },
  );

  const errorCode = (probeResult.waResponse as { error?: { code?: number } })
    ?.error?.code;
  const notOnWhatsapp =
    !probeResult.ok &&
    probeResult.reason === "wa_error" &&
    errorCode != null &&
    NOT_ON_WHATSAPP_ERROR_CODES.has(errorCode);

  const newTier: PastoralistChannelTier = notOnWhatsapp ? "voice" : "whatsapp";

  try {
    await db
      .update(pastoralistsTable)
      .set({ channelTier: newTier, lastTierCheckAt: new Date() })
      .where(eq(pastoralistsTable.phone, normalized));
  } catch (err) {
    logger.warn(
      { err: String(err), phone: normalized },
      "[ChannelTier] Failed to persist tier update",
    );
  }

  logger.info(
    { phone: normalized, previousTier: currentTier, newTier, notOnWhatsapp },
    "[ChannelTier] Tier probe complete",
  );

  return { tier: newTier, probed: true };
}

/**
 * Cheap wrapper for callers (e.g. the alert-dispatch loop) that just
 * need to make sure a stale tier gets refreshed before spending a
 * template send on it — doesn't return the result, just ensures the DB
 * row is current.
 */
export async function ensureChannelTierFresh(phone: string): Promise<void> {
  await resolveChannelTier(phone);
}
