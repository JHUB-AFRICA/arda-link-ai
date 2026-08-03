import { Router, type IRouter } from "express";
import { logger } from "../lib/logger.js";
import {
  processInboundWhatsappMessage,
  type NormalizedWaMessage,
} from "../lib/whatsappTurn.js";

/**
 * Evolution API's own webhook envelope — NOT Meta-Cloud-API-shaped,
 * even for Cloud-API-backed instances (confirmed against Evolution's
 * source, v2.3.7). Meta's raw webhook actually lands on Evolution's own
 * internal /webhook/meta endpoint; Evolution normalizes it into this
 * Baileys-flavored shape before re-emitting to whatever callback URL
 * you configured via `POST /webhook/set/:instanceName`.
 */
interface EvoWebhookBody {
  event?: string;
  instance?: string;
  data?: {
    key?: { id?: string; remoteJid?: string; fromMe?: boolean };
    message?: {
      conversation?: string;
      listResponseMessage?: { singleSelectReply?: { selectedRowId?: string } };
      buttonsResponseMessage?: { selectedButtonId?: string };
      locationMessage?: { degreesLatitude?: number; degreesLongitude?: number };
      audioMessage?: unknown;
    };
    messageType?: string;
    messageTimestamp?: number;
    // messages.update shape — flat on `data`, not nested under `key`:
    messageId?: string;
    keyId?: string;
    remoteJid?: string;
    status?: string;
  };
}

// Strips whichever WhatsApp JID suffix is present — individual chats
// (@s.whatsapp.net), groups (@g.us), and Baileys' privacy-preserving
// "linked ID" used on some status callbacks (@lid) — before prepending
// "+". Previously only @s.whatsapp.net was stripped, so every group
// message's phone_number ended up literally "+<id>@g.us": harmless for
// individual chats but it meant a group's identifier here didn't match
// whatever a status-callback path derived separately (see the fix in
// processInboundWhatsappMessage's status branch below, in
// whatsappTurn.ts — same conversation was ending up split across two
// different phone_number values, observed for real in the local mirror).
function toE164FromJid(jid: string): string {
  return `+${jid.replace(/@(s\.whatsapp\.net|g\.us|lid)$/, "")}`;
}

/**
 * KNOWN GAP: only plain-text `data.message.conversation` is confirmed
 * against Evolution's real source. The list-reply / button-reply /
 * location / audio branches below are inferred from general Baileys
 * protocol knowledge, NOT verified against Evolution's source or a live
 * instance. Do not trust these beyond text until confirmed against a
 * real Evolution deployment.
 */
export function fromEvolutionWebhook(
  body: EvoWebhookBody,
): NormalizedWaMessage | null {
  if (body.event === "messages.update" && body.data) {
    return {
      from: body.data.remoteJid
        ? toE164FromJid(body.data.remoteJid)
        : "unknown",
      type: "status",
      status: {
        id: body.data.keyId,
        status: body.data.status,
        recipientId: body.data.remoteJid,
      },
      raw: body.data,
    };
  }

  if (body.event !== "messages.upsert" || !body.data?.key?.remoteJid) {
    return null;
  }
  if (body.data.key.fromMe) return null; // ignore echoes of our own sends

  const from = toE164FromJid(body.data.key.remoteJid);
  const msg = body.data.message ?? {};

  if (msg.conversation) {
    return { from, type: "text", text: msg.conversation, raw: body.data };
  }

  // Unverified branches — see docstring above.
  const rowId = msg.listResponseMessage?.singleSelectReply?.selectedRowId;
  if (rowId) {
    return { from, type: "list_reply", replyId: rowId, raw: body.data };
  }
  const buttonId = msg.buttonsResponseMessage?.selectedButtonId;
  if (buttonId) {
    return { from, type: "button_reply", replyId: buttonId, raw: body.data };
  }
  if (msg.locationMessage) {
    return {
      from,
      type: "location",
      location: {
        lat: msg.locationMessage.degreesLatitude ?? 0,
        lon: msg.locationMessage.degreesLongitude ?? 0,
      },
      raw: body.data,
    };
  }
  if (msg.audioMessage) {
    return { from, type: "audio", audioRef: msg.audioMessage, raw: body.data };
  }
  return null;
}

const router: IRouter = Router();

router.post("/evolution-whatsapp-webhook", async (req, res): Promise<void> => {
  // Same fast-ack rationale as the 360dialog webhook — Evolution retries
  // non-2xx/slow responses with exponential backoff.
  res.status(200).json({ received: true });

  const normalized = fromEvolutionWebhook((req.body ?? {}) as EvoWebhookBody);
  if (!normalized) return;

  try {
    await processInboundWhatsappMessage(normalized);
  } catch (err) {
    logger.error(
      { err, from: normalized.from },
      "[Evolution] webhook handler error",
    );
  }
});

export default router;
