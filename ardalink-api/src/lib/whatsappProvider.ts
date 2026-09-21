/**
 * Shared contract every WhatsApp provider implementation satisfies.
 *
 * routes/whatsapp.ts, whatsappAlerts.ts, and channelTier.ts depend on
 * this interface (via whatsappProviderRegistry.ts) only — never on a
 * concrete provider module — so the active provider is swappable via
 * WA_PROVIDER with zero changes to any of those files' logic.
 *
 * Two implementations exist: threeSixtyDialog.ts (360dialog BSP,
 * Meta-Cloud-API-shaped wire protocol) and evolutionApi.ts (self-hosted
 * Evolution API, its own simplified wire protocol even when Cloud-API
 * backed) — see each file's header for its wire-format specifics.
 * Payload-building is NOT shared between them; only this domain-level
 * shape is.
 */

export interface WaSendResult {
  ok: boolean;
  skipped?: boolean;
  reason?:
    | "disabled"
    | "rate_limited"
    | "not_configured"
    | "wa_error"
    | "network_error"
    | "outside_session_window"
    | "unknown_tier";
  waResponse?: unknown;
  messageId?: string;
  status?: string;
}

export interface WaTemplateComponent {
  type: "body" | "header" | "button";
  parameters: Array<{ type: "text"; text: string }>;
}

export interface WaListSection {
  title: string;
  rows: Array<{ id: string; title: string; description?: string }>;
}

export interface WhatsappProvider {
  isConfigured(): boolean;
  sendWhatsappSessionMessage(
    phone: string,
    text: string,
    opts?: { bypassRateLimit?: boolean },
  ): Promise<WaSendResult>;
  sendWhatsappTemplate(
    phone: string,
    templateName: string,
    languageCode: string,
    components: WaTemplateComponent[],
    opts?: {
      tier?: "verified" | "lead" | "unknown";
      bypassRateLimit?: boolean;
    },
  ): Promise<WaSendResult>;
  sendWhatsappInteractiveList(
    phone: string,
    header: string,
    body: string,
    buttonText: string,
    sections: WaListSection[],
  ): Promise<WaSendResult>;
  sendWhatsappInteractiveButtons(
    phone: string,
    body: string,
    buttons: Array<{ id: string; title: string }>,
  ): Promise<WaSendResult>;
  sendWhatsappLocation(
    phone: string,
    lat: number,
    lon: number,
    name: string,
    address?: string,
  ): Promise<WaSendResult>;
}
