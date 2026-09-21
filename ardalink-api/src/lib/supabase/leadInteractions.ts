/**
 * lead_interactions — audit log of every AT-facing surface hit
 * (ussd/sms/voice/whatsapp). The operational audit trail behind the
 * ops CallbackLog dashboard, and feature source for the trust-score
 * model.
 */

import { logger } from "../logger.js";
import { mirrorLeadInteraction } from "../localMirror.js";
import type { InsertLeadInteraction } from "@workspace/db";
import { sbFetch, sbGet, type SupabaseMode } from "./client.js";

/**
 * Row shape for `lead_interactions`. Written from every AT-facing
 * route (ussd/sms/voice) on every hit — the operational audit
 * trail behind the ops CallbackLog dashboard, and feature source
 * for the trust-score model.
 *
 * `tier` is snapshot at the time of the interaction — a lead who
 * later gets verified still shows as tier='lead' on their old rows.
 */
export interface SbLeadInteractionInsert {
  phone_number: string;
  tier: "verified" | "lead" | "unknown";
  channel: "ussd" | "sms" | "voice" | "voice_event" | "whatsapp";
  session_id?: string | null;
  keyword?: string | null;
  input_text?: string | null;
  reply_text?: string | null;
  ward_id?: string | null;
  raw_body?: unknown;
}

/**
 * Fire-and-forget log write. Never blocks — the caller's AT
 * response has already been formulated. Dual-writes: Supabase primary
 * (source of truth) + local Postgres mirror (best-effort, keeps the
 * audit trail alive during a Supabase outage). Both failures are
 * warn-logged and swallowed.
 */
export const logLeadInteraction = async (
  row: SbLeadInteractionInsert,
): Promise<void> => {
  try {
    const res = await sbFetch("lead_interactions", {
      method: "POST",
      body: JSON.stringify(row),
      headers: { Prefer: "return=minimal" },
      sbMode: "batch",
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logger.warn(
        { status: res.status, body: body.slice(0, 200), channel: row.channel },
        "[Supabase] lead_interactions insert non-2xx",
      );
    }
  } catch (err) {
    logger.warn({ err, channel: row.channel }, "[Supabase] lead_interactions insert crashed");
  }
  // Local mirror runs regardless of Supabase outcome — if Supabase is
  // down we still capture the interaction; if the local pool is down
  // Supabase still has the row.
  await mirrorLeadInteraction({
    phoneNumber: row.phone_number,
    tier: row.tier,
    channel: row.channel,
    sessionId: row.session_id ?? null,
    keyword: row.keyword ?? null,
    inputText: row.input_text ?? null,
    replyText: row.reply_text ?? null,
    wardId: row.ward_id ?? null,
    rawBody: (row.raw_body ?? null) as InsertLeadInteraction["rawBody"],
    tenantId: null,
  });
};

/**
 * Recent interactions for the ops CallbackLog panel. Filterable by
 * channel + ward + phone. Sorted newest first.
 */
export interface SbLeadInteractionRead extends SbLeadInteractionInsert {
  interaction_id: string;
  occurred_at: string;
}

export const recentLeadInteractions = (
  opts: {
    limit?: number;
    channel?: "ussd" | "sms" | "voice" | "voice_event" | "whatsapp";
    ward_id?: string;
    phone?: string;
    mode?: SupabaseMode;
  } = {},
) => {
  const safeLimit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const filters: string[] = [];
  if (opts.channel) filters.push(`channel=eq.${opts.channel}`);
  if (opts.ward_id) filters.push(`ward_id=eq.${encodeURIComponent(opts.ward_id)}`);
  if (opts.phone) filters.push(`phone_number=eq.${encodeURIComponent(opts.phone)}`);
  const filterStr = filters.length > 0 ? "&" + filters.join("&") : "";
  return sbGet<SbLeadInteractionRead>(
    `lead_interactions?select=*${filterStr}&order=occurred_at.desc&limit=${safeLimit}`,
    { mode: opts.mode ?? "batch" },
  );
};
