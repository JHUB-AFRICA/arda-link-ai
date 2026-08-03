/**
 * whatsapp_messages — append-only thread/audit log for the WhatsApp
 * channel, plus the conversation-memory reads (`hasPriorWhatsappMessages`,
 * `recentWhatsappMessages`) that whatsappTurn.ts's handleFreeText()
 * uses to give the LLM real history instead of a single isolated turn.
 */

import { desc, eq } from "drizzle-orm";
import { logger } from "../logger.js";
import { mirrorWhatsappMessage } from "../localMirror.js";
import {
  db,
  whatsappMessagesTable,
  type InsertWhatsappMessage,
} from "@workspace/db";
import { sbFetch, sbGet } from "./client.js";

/**
 * WhatsApp thread/audit log — the append-only analogue of
 * lead_interactions, but with two rows per conversational turn ('in'
 * and 'out' logged separately) since WhatsApp's message_type/
 * template_name/session_expires_at fields are richer and direction-
 * specific. `tier` is snapshot at send time, same convention as
 * lead_interactions.
 */
export interface SbWhatsappMessageInsert {
  phone_number: string;
  wa_id?: string | null;
  tier?: "verified" | "lead" | "unknown" | null;
  direction: "in" | "out" | "status";
  message_type:
    | "text"
    | "template"
    | "interactive_list"
    | "interactive_buttons"
    | "list_reply"
    | "button_reply"
    | "location"
    | "audio"
    | "status";
  template_name?: string | null;
  body_text?: string | null;
  session_expires_at?: string | null;
  ward_id?: string | null;
  raw_payload?: unknown;
}

/**
 * Fire-and-forget log write, same dual-write shape as
 * logLeadInteraction: Supabase primary + local Postgres mirror
 * (best-effort). Both failures are warn-logged and swallowed — never
 * blocks the caller's reply.
 */
export const logWhatsappMessage = async (
  row: SbWhatsappMessageInsert,
): Promise<void> => {
  try {
    const res = await sbFetch("whatsapp_messages", {
      method: "POST",
      body: JSON.stringify(row),
      headers: { Prefer: "return=minimal" },
      sbMode: "batch",
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logger.warn(
        { status: res.status, body: body.slice(0, 200), direction: row.direction },
        "[Supabase] whatsapp_messages insert non-2xx",
      );
    }
  } catch (err) {
    logger.warn(
      { err, direction: row.direction },
      "[Supabase] whatsapp_messages insert crashed",
    );
  }
  await mirrorWhatsappMessage({
    phoneNumber: row.phone_number,
    waId: row.wa_id ?? null,
    tier: row.tier ?? null,
    direction: row.direction,
    messageType: row.message_type,
    templateName: row.template_name ?? null,
    bodyText: row.body_text ?? null,
    sessionExpiresAt: row.session_expires_at
      ? new Date(row.session_expires_at)
      : null,
    wardId: row.ward_id ?? null,
    rawPayload: (row.raw_payload ?? null) as InsertWhatsappMessage["rawPayload"],
    tenantId: null,
  });
};

/**
 * Whether the phone has any prior whatsapp_messages row — used to
 * decide whether an inbound text is a genuinely first contact (send
 * the welcome interactive list) or a returning conversation.
 */
export const hasPriorWhatsappMessages = async (
  phone: string,
): Promise<boolean> => {
  const rows = await sbGet<{ message_id: string }>(
    `whatsapp_messages?select=message_id&phone_number=eq.${encodeURIComponent(phone)}&limit=1`,
    { mode: "interactive" },
  );
  if (rows) return rows.length > 0;
  // Supabase unreachable/unconfigured — fall back to the local mirror
  // rather than defaulting to false, which would otherwise treat every
  // message as first contact and re-send the welcome menu forever.
  try {
    const local = await db
      .select({ messageId: whatsappMessagesTable.messageId })
      .from(whatsappMessagesTable)
      .where(eq(whatsappMessagesTable.phoneNumber, phone))
      .limit(1);
    return local.length > 0;
  } catch (err) {
    logger.warn(
      { err: String(err), phone },
      "[Supabase] hasPriorWhatsappMessages local fallback failed",
    );
    // Fail toward "yes, seen before" — same reasoning as the comment
    // above this function: on total failure (both Supabase and the
    // local mirror unreachable) we cannot tell first-contact from an
    // ongoing thread, and defaulting to false re-sends the welcome
    // menu into a live conversation. Observed for real: one tester got
    // welcome_list 6 times across an active thread. Worst case of
    // defaulting true instead is a genuine first-time sender occasionally
    // not getting the welcome menu — recoverable any time via
    // MSAADA/HELP/MENU — which is a smaller failure than repeatedly
    // interrupting an ongoing conversation.
    return true;
  }
};

/**
 * Recent whatsapp_messages for a phone, oldest-first — feeds the
 * conversation history handleFreeText() gives the LLM (so it stops
 * re-asking answered questions) and the fuller transcript passed to
 * extractIndicators(). Same Supabase-primary + local-mirror-fallback
 * shape as hasPriorWhatsappMessages above.
 */
export interface SbRecentWhatsappMessage {
  direction: "in" | "out" | "status";
  message_type: SbWhatsappMessageInsert["message_type"];
  body_text: string | null;
  occurred_at: string;
}

export const recentWhatsappMessages = async (
  phone: string,
  limit = 12,
): Promise<SbRecentWhatsappMessage[]> => {
  const safeLimit = Math.min(Math.max(limit, 1), 50);
  const rows = await sbGet<SbRecentWhatsappMessage>(
    `whatsapp_messages?select=direction,message_type,body_text,occurred_at` +
      `&phone_number=eq.${encodeURIComponent(phone)}` +
      `&order=occurred_at.desc&limit=${safeLimit}`,
    { mode: "interactive" },
  );
  if (rows) return rows.slice().reverse();
  try {
    const local = await db
      .select({
        direction: whatsappMessagesTable.direction,
        messageType: whatsappMessagesTable.messageType,
        bodyText: whatsappMessagesTable.bodyText,
        occurredAt: whatsappMessagesTable.occurredAt,
      })
      .from(whatsappMessagesTable)
      .where(eq(whatsappMessagesTable.phoneNumber, phone))
      .orderBy(desc(whatsappMessagesTable.occurredAt))
      .limit(safeLimit);
    return local
      .slice()
      .reverse()
      .map((r) => ({
        direction: r.direction as SbRecentWhatsappMessage["direction"],
        message_type: r.messageType as SbWhatsappMessageInsert["message_type"],
        body_text: r.bodyText,
        occurred_at: r.occurredAt.toISOString(),
      }));
  } catch (err) {
    logger.warn(
      { err: String(err), phone },
      "[Supabase] recentWhatsappMessages local fallback failed",
    );
    return [];
  }
};
