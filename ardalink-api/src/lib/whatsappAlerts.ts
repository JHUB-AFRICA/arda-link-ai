/**
 * Proactive drought-alert dispatch over WhatsApp.
 *
 * This repo has no live proactive-outreach cron for any channel today —
 * the only precedent is the manually-triggered "verify a lead" welcome
 * SMS in `routes/ops/leads.ts`. This module matches that pattern: an
 * ops-triggered dispatch, not a cron, so it's trivially wireable to a
 * real scheduler later (the cron would just call
 * `dispatchDroughtAlertsForWard` directly) without any route changes.
 *
 * Candidate selection reads the LOCAL Drizzle `pastoralists` table
 * (channel_tier='whatsapp' AND alerts_enabled=true) rather than
 * Supabase, because `wa_id`/`channel_tier`/`last_tier_check_at` are
 * guaranteed present locally (this repo's own migration) but may not
 * yet be applied to the live Supabase project — see the operational
 * note in migration 0005_add_whatsapp_support. The local `pastoralists`
 * table also has no `ward_id` column (only free-text `location`), so
 * ward filtering happens post-query via `resolveHerderContext()`'s own
 * ward-attachment logic, same as every other channel.
 */

import { eq, and } from "drizzle-orm";
import { db, pastoralistsTable } from "@workspace/db";
import { logger } from "./logger.js";
import { resolveHerderContext } from "./herderContext.js";
import { languageForCaller } from "./voiceCopy.js";
import {
  sendWhatsappTemplate,
  type WaTemplateComponent,
} from "./threeSixtyDialog.js";

const DEFAULT_TENANT_ID = process.env.DETERMINISTIC_TENANT_ID ?? "bula-pesa";
const DROUGHT_ALERT_TEMPLATE = "drought_alert_utility";

export interface DroughtAlertDispatchResult {
  sent: number;
  skipped: number;
  failed: number;
}

/**
 * Compose the drought-alert template's positional body parameters from
 * the herder's context: ward name, NDVI delta, nearest water point.
 */
function composeDroughtAlertComponents(
  ctx: Awaited<ReturnType<typeof resolveHerderContext>>,
): WaTemplateComponent[] {
  const wardName = ctx.wardName ?? "your ward";
  const ndviLine =
    ctx.wardNdviPct != null
      ? `NDVI ${ctx.wardNdviPct.toFixed(0)}% below normal`
      : "drought conditions detected";
  const waterLine = ctx.nearestWaterPointName ?? "the nearest known water point";

  return [
    {
      type: "body",
      parameters: [
        { type: "text", text: wardName },
        { type: "text", text: ndviLine },
        { type: "text", text: waterLine },
      ],
    },
  ];
}

/** Dispatch a single drought-alert template to one herder. */
export async function dispatchDroughtAlertWhatsapp(
  phone: string,
): Promise<{ ok: boolean; reason?: string }> {
  const ctx = await resolveHerderContext(phone, DEFAULT_TENANT_ID);
  if (ctx.tier === "unknown") {
    return { ok: false, reason: "unknown_tier" };
  }
  const lang = languageForCaller(ctx);
  const result = await sendWhatsappTemplate(
    phone,
    DROUGHT_ALERT_TEMPLATE,
    lang,
    composeDroughtAlertComponents(ctx),
    { tier: ctx.tier },
  );
  return { ok: result.ok, reason: result.reason };
}

/**
 * Dispatch drought alerts to every WhatsApp-tier, opted-in pastoralist,
 * optionally restricted to one ward. Rate-limited per-phone by
 * threeSixtyDialog.ts's WA_TEMPLATE_DAILY_CAP — a phone that already
 * got today's template send is skipped, not retried.
 */
export async function dispatchDroughtAlertsForWard(
  wardId?: string,
): Promise<DroughtAlertDispatchResult> {
  const candidates = await db
    .select({ phone: pastoralistsTable.phone })
    .from(pastoralistsTable)
    .where(
      and(
        eq(pastoralistsTable.channelTier, "whatsapp"),
        eq(pastoralistsTable.alertsEnabled, true),
      ),
    );

  let sent = 0;
  let skipped = 0;
  let failed = 0;

  for (const { phone } of candidates) {
    if (wardId) {
      const ctx = await resolveHerderContext(phone, DEFAULT_TENANT_ID);
      if (ctx.wardId !== wardId) {
        continue;
      }
    }
    const result = await dispatchDroughtAlertWhatsapp(phone);
    if (result.ok) {
      sent += 1;
    } else if (result.reason === "rate_limited" || result.reason === "unknown_tier") {
      skipped += 1;
    } else {
      failed += 1;
    }
  }

  logger.info(
    { wardId: wardId ?? "all", sent, skipped, failed, candidates: candidates.length },
    "[WhatsApp Alerts] Drought alert dispatch complete",
  );

  return { sent, skipped, failed };
}
