/**
 * Picks the active WhatsApp provider via WA_PROVIDER — the rest of the
 * app (routes/whatsapp.ts, whatsappAlerts.ts, channelTier.ts) imports
 * ONLY from here, never directly from threeSixtyDialog.ts/evolutionApi.ts,
 * so switching providers is a one-env-var change with zero code changes
 * elsewhere.
 *
 * WA_PROVIDER is read fresh on every call (not cached at module load,
 * unlike the rate-limit caps inside each provider module) so it's fully
 * mockable per-test via vi.stubEnv and safe to flip at process start
 * without any import-order surprises.
 */

import { threeSixtyDialogProvider } from "./threeSixtyDialog.js";
import { evolutionApiProvider } from "./evolutionApi.js";
import type { WhatsappProvider } from "./whatsappProvider.js";

export type WaProviderName = "360dialog" | "evolution";

function providerName(): WaProviderName {
  const v = (process.env.WA_PROVIDER ?? "360dialog").trim().toLowerCase();
  return v === "evolution" ? "evolution" : "360dialog";
}

const providers: Record<WaProviderName, WhatsappProvider> = {
  "360dialog": threeSixtyDialogProvider,
  evolution: evolutionApiProvider,
};

/** The single entry point for anything that needs the whole provider object. */
export function activeWhatsappProvider(): WhatsappProvider {
  return providers[providerName()];
}

// Re-exported as bound functions so call sites read like today's direct
// imports (`sendWhatsappSessionMessage(...)`) instead of always writing
// `activeWhatsappProvider().sendWhatsappSessionMessage(...)`.
export const sendWhatsappSessionMessage: WhatsappProvider["sendWhatsappSessionMessage"] =
  (...args) => activeWhatsappProvider().sendWhatsappSessionMessage(...args);
export const sendWhatsappTemplate: WhatsappProvider["sendWhatsappTemplate"] = (
  ...args
) => activeWhatsappProvider().sendWhatsappTemplate(...args);
export const sendWhatsappInteractiveList: WhatsappProvider["sendWhatsappInteractiveList"] =
  (...args) => activeWhatsappProvider().sendWhatsappInteractiveList(...args);
export const sendWhatsappInteractiveButtons: WhatsappProvider["sendWhatsappInteractiveButtons"] =
  (...args) => activeWhatsappProvider().sendWhatsappInteractiveButtons(...args);
export const sendWhatsappLocation: WhatsappProvider["sendWhatsappLocation"] = (
  ...args
) => activeWhatsappProvider().sendWhatsappLocation(...args);

export function isWhatsappConfigured(): boolean {
  return activeWhatsappProvider().isConfigured();
}
