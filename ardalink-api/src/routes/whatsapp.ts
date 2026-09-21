import { Router, type IRouter } from "express";
import { logger } from "../lib/logger.js";
import {
  processInboundWhatsappMessage,
  type NormalizedWaMessage,
} from "../lib/whatsappTurn.js";

/**
 * 360dialog forwards the Meta Cloud API webhook envelope verbatim.
 * `entry[].changes[].value.messages[]` for inbound messages,
 * `.statuses[]` for delivery/read receipts — both can appear on the
 * same endpoint, sometimes interleaved.
 */
interface WaMessage {
  from?: string;
  id?: string;
  timestamp?: string;
  type?: string;
  text?: { body?: string };
  interactive?: {
    list_reply?: { id?: string; title?: string };
    button_reply?: { id?: string; title?: string };
  };
  location?: { latitude?: number; longitude?: number };
  audio?: { id?: string };
}

interface WaWebhookBody {
  entry?: Array<{
    changes?: Array<{
      value?: {
        contacts?: Array<{ wa_id?: string; profile?: { name?: string } }>;
        messages?: WaMessage[];
        statuses?: Array<{ id?: string; status?: string; recipient_id?: string }>;
      };
    }>;
  }>;
}

const router: IRouter = Router();

/** Meta/360dialog sends `from` as digits-only MSISDN — normalize to E.164. */
function toE164(raw: string): string {
  return raw.startsWith("+") ? raw : `+${raw}`;
}

/** Parses one Meta-Cloud-API-shaped inbound message into the shared normalized shape. */
function fromMetaMessage(message: WaMessage): NormalizedWaMessage | null {
  if (!message.from) return null;
  const from = toE164(message.from);

  if (message.type === "location" && message.location) {
    return {
      from,
      type: "location",
      location: {
        lat: message.location.latitude ?? 0,
        lon: message.location.longitude ?? 0,
      },
      raw: message.location,
    };
  }
  if (message.type === "audio") {
    return { from, type: "audio", audioRef: message.audio, raw: message.audio };
  }
  if (message.type === "interactive") {
    const listId = message.interactive?.list_reply?.id;
    const buttonId = message.interactive?.button_reply?.id;
    if (listId) {
      return { from, type: "list_reply", replyId: listId, raw: message.interactive };
    }
    if (buttonId) {
      return { from, type: "button_reply", replyId: buttonId, raw: message.interactive };
    }
    return null;
  }
  if (message.type === "text" && message.text?.body) {
    return { from, type: "text", text: message.text.body, raw: null };
  }
  return null;
}

router.post("/whatsapp-webhook", async (req, res): Promise<void> => {
  // 360dialog/Meta expects a fast 200 regardless of downstream outcome —
  // slow or non-2xx responses trigger their own retry/backoff.
  res.status(200).json({ received: true });

  const body = (req.body ?? {}) as WaWebhookBody;
  const value = body.entry?.[0]?.changes?.[0]?.value;
  if (!value) return;

  if (value.statuses && value.statuses.length > 0) {
    for (const status of value.statuses) {
      try {
        await processInboundWhatsappMessage({
          from: status.recipient_id ?? "unknown",
          type: "status",
          status: {
            id: status.id,
            status: status.status,
            recipientId: status.recipient_id,
          },
          raw: status,
        });
      } catch (err) {
        logger.error({ err }, "[WhatsApp] status webhook handler error");
      }
    }
    return;
  }

  const message = value.messages?.[0];
  if (!message) return;
  const normalized = fromMetaMessage(message);
  if (!normalized) return;

  try {
    await processInboundWhatsappMessage(normalized);
  } catch (err) {
    logger.error({ err, from: normalized.from }, "[WhatsApp] webhook handler error");
  }
});

export default router;
