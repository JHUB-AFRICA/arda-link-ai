/**
 * WhatsApp-specific system prompt builder for the free-form conversation
 * turn ("Ongea na AI" and any follow-up text). Built from the same
 * `HerderContext` every other channel already resolves via
 * `resolveHerderContext()` — no separate data-fetching blocks needed
 * (unlike `chat.ts`'s `/talk` prompt, which pulls its own water-point/
 * landmark/memory blocks — WhatsApp reuses `ctx`'s ward-level fields
 * directly since they're already populated by the same overlay chain).
 *
 * Reuses `indicatorCollectionBlock()` from `openai.ts` verbatim — the
 * PRIMARY/SECONDARY indicator-collection rules are channel-agnostic and
 * already shared with the realtime voice system prompt.
 */

import type { HerderContext } from "./herderContext.js";
import { indicatorCollectionBlock } from "./openai.js";

/**
 * Build the system prompt for a WhatsApp turn-by-turn conversation.
 * Framed explicitly as turn-based text (no DTMF, no audio streaming) —
 * the model should feel free to suggest tapping a button/list reply
 * where natural, but must also handle plain typed replies.
 */
export function buildWhatsappSystemPrompt(
  ctx: HerderContext,
  lang: "sw" | "en",
): string {
  const wardLine = ctx.wardName
    ? `Ward: ${ctx.wardName}${ctx.wardMonth ? ` (${ctx.wardMonth})` : ""}`
    : "Ward: unknown — ask where the herder is grazing if it becomes relevant.";

  const droughtLine =
    ctx.wardNdviPct != null || ctx.wardDroughtSeverity
      ? `Drought signal: NDVI ${ctx.wardNdviPct != null ? `${ctx.wardNdviPct.toFixed(0)}% vs normal` : "unknown"}, severity ${ctx.wardDroughtSeverity ?? "unknown"}, VCI ${ctx.wardVci ?? "unknown"}.`
      : "";

  const waterLine = ctx.nearestWaterPointName
    ? `Nearest known water point: ${ctx.nearestWaterPointName}${ctx.nearestWaterPointDistanceKm != null ? `, ~${ctx.nearestWaterPointDistanceKm.toFixed(1)}km away` : ""}, status ${ctx.nearestWaterPointStatus ?? "unknown"}.`
    : "";

  const peerLine =
    ctx.peerCallerCount != null && ctx.peerCallerCount > 0
      ? `${ctx.peerCallerCount} other herders nearby reported this week${ctx.peerThinAnimalsCount ? ` (${ctx.peerThinAnimalsCount} noted thin animals)` : ""}.`
      : "";

  const languagePolicy =
    lang === "sw"
      ? "Reply in Swahili, mixing in English words the way Isiolo herders naturally do. If the herder switches to English, follow them."
      : "Reply in English, mixing in Swahili words the way Isiolo herders naturally do. If the herder switches to Swahili, follow them.";

  return `You are ArdaLink, a respected veteran range management expert helping a pastoralist in Isiolo, Kenya over WhatsApp text chat.

CHANNEL: This is WhatsApp — turn-based typed messages, not a phone call. Keep replies short (2-4 sentences, WhatsApp-length, not a wall of text). You may suggest the herder tap a button/list option where one exists, but always handle plain typed replies too.

${languagePolicy}

${wardLine}
${droughtLine}
${waterLine}
${peerLine}

${indicatorCollectionBlock()}

Never invent data you don't have. If asked something outside livestock/drought/water advisory, gently steer back — you are a livestock advisory assistant, not a general-purpose assistant.`;
}
