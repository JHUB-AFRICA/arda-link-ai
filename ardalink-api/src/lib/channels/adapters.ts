/**
 * Channel Adapters — Format responses for USSD, SMS, and Voice.
 *
 * Each adapter implements the ChannelFormatter interface with
 * channel-specific response formatting.
 */

import type {
  Channel,
  ChannelFormatter,
  IntelligenceContext,
  AiResponse,
} from "./intelligenceCore";

// ── USSD Adapter ───────────────────────────────────────────────────────────────

export class UssdAdapter implements ChannelFormatter {
  /**
   * Format response for USSD.
   * USSD responses must start with "CON " (continue) or "END " (terminate).
   */
  static format(aiResponse: AiResponse): string {
    const prefix = aiResponse.ended ? "END " : "CON ";
    return prefix + aiResponse.text;
  }

  formatBrief(ctx: IntelligenceContext, lang: "sw" | "en"): string {
    const sat = ctx.satellite;
    const forecast = ctx.forecast;

    if (!sat) {
      return lang === "sw"
        ? "END Samahani, hatuna ripoti ya satellite leo."
        : "END Sorry, no satellite data today.";
    }

    if (lang === "sw") {
      return `END Bula Pesa: VCI ${sat.vci?.toFixed(1) ?? "?"}/100 (${sat.vciDroughtClass ?? "?"}), ${sat.stressedPixelPct?.toFixed(0) ?? "?"}% stressed. Risk: ${forecast?.riskLevel ?? "?"}`;
    }
    return `END Bula Pesa: VCI ${sat.vci?.toFixed(1) ?? "?"}/100 (${sat.vciDroughtClass ?? "?"}), ${sat.stressedPixelPct?.toFixed(0) ?? "?"}% stressed. Risk: ${forecast?.riskLevel ?? "?"}`;
  }

  formatWaterPoints(): string {
    return `END Malisho:
1. Bulla Pesa BH (SW, 2km)
2. Wabera Well (NW, 7km)
3. Ngare Mara Spring (NE, 9km)`;
  }

  formatCallConfirmation(when: "now" | "tomorrow"): string {
    if (when === "now") {
      return "END ArdaLink atapiga simu hivi karibuni.";
    }
    return "END ArdaLink atapiga simu kesho.";
  }

  formatOptOut(): string {
    return "END Umefungiwa. Tuma 'ONGEA' kufungua tena.";
  }

  formatUnknown(): string {
    return "END Chaguo batili. Jaribu tena.";
  }

  formatHomeMenu(): string {
    return `CON ArdaLink — Bula Pesa
1. Bula Pesa (brief)
2. Malisho (water)
3. Ongea na AI
4. Toka`;
  }
}

// ── SMS Adapter ────────────────────────────────────────────────────────────────

export class SmsAdapter implements ChannelFormatter {
  private static readonly MAX_CHARS = 160;

  /**
   * Format response for SMS.
   * SMS responses are plain text, capped at 160 chars.
   */
  static format(aiResponse: AiResponse): string {
    return this.truncate(aiResponse.text);
  }

  private static truncate(text: string): string {
    if (text.length <= this.MAX_CHARS) return text;
    return text.slice(0, this.MAX_CHARS - 1) + "…";
  }

  formatBrief(ctx: IntelligenceContext, lang: "sw" | "en"): string {
    const sat = ctx.satellite;
    const forecast = ctx.forecast;

    if (!sat) {
      return SmsAdapter.truncate(
        lang === "sw"
          ? "Bula Pesa: Hakuna ripoti mpya. Tuma 'ONGEA' kwa mazungumzo."
          : "Bula Pesa: No new report. Text 'ONGEA' for a call.",
      );
    }

    if (lang === "sw") {
      return SmsAdapter.truncate(
        `Bula Pesa: VCI ${sat.vci?.toFixed(1) ?? "?"}/100, ${sat.stressedPixelPct?.toFixed(0) ?? "?"}% stressed. Risk: ${forecast?.riskLevel ?? "?"}. Piga simu kwa detail.`,
      );
    }
    return SmsAdapter.truncate(
      `Bula Pesa: VCI ${sat.vci?.toFixed(1) ?? "?"}/100, ${sat.stressedPixelPct?.toFixed(0) ?? "?"}% stressed. Risk: ${forecast?.riskLevel ?? "?"}. Call for detail.`,
    );
  }

  formatWaterPoints(): string {
    return SmsAdapter.truncate(
      "Malisho: 1) Bulla Pesa BH (SW, 2km) 2) Wabera Well (NW, 7km) 3) Ngare Mara Spring (NE, 9km)",
    );
  }

  formatCallConfirmation(when: "now" | "tomorrow"): string {
    if (when === "now") {
      return SmsAdapter.truncate("ArdaLink itapiga simu hivi karibuni.");
    }
    return SmsAdapter.truncate("ArdaLink itapiga simu kesho.");
  }

  formatOptOut(): string {
    return SmsAdapter.truncate("Umefungiwa. Tuma 'ONGEA' kufungua tena.");
  }

  formatUnknown(): string {
    return SmsAdapter.truncate("ArdaLink: BULA, MALISHO, ONGEA, au STOP.");
  }
}

// ── Voice Adapter ───────────────────────────────────────────────────────────────

export class VoiceAdapter implements ChannelFormatter {
  /**
   * Format response for voice.
   * Voice responses include the text to speak and optionally a follow-up question.
   */
  static format(aiResponse: AiResponse): { text: string; question?: string; shouldEnd: boolean } {
    return {
      text: aiResponse.text,
      question: aiResponse.question,
      shouldEnd: aiResponse.ended,
    };
  }

  formatBrief(ctx: IntelligenceContext, lang: "sw" | "en"): string {
    const sat = ctx.satellite;
    const forecast = ctx.forecast;

    if (!sat) {
      return lang === "sw"
        ? "Samahani, hatuna ripoti ya satellite leo."
        : "Sorry, no satellite data today.";
    }

    if (lang === "sw") {
      return `Kwa mujibu wa data ya satellite, VCI ni ${sat.vci?.toFixed(1) ?? "?"} kati ya 100, maana yani ${sat.vciDroughtClass ?? "?"} ukame. ${sat.stressedPixelPct?.toFixed(0) ?? "?"}% ya eneo limeathirika. Hatari ya siku zijazo ni ${forecast?.riskLevel ?? "?"}.`;
    }
    return `According to satellite data, VCI is ${sat.vci?.toFixed(1) ?? "?"} out of 100, meaning ${sat.vciDroughtClass ?? "?"} drought. ${sat.stressedPixelPct?.toFixed(0) ?? "?"}% of the area is stressed. Near-term risk is ${forecast?.riskLevel ?? "?"}.`;
  }

  formatWaterPoints(): string {
    return "Vyanzo vya maji karibu: Bulla Pesa Borehole umbali wa kilomita mbili upande wa kusini-magharibi, Wabera Shallow Well kilomita saba upande wa kaskazini-magharibi, na Ngare Mara Spring kilomita tisa upande wa kaskazini-mashariki.";
  }

  formatCallConfirmation(when: "now" | "tomorrow"): string {
    if (when === "now") {
      return "Sawa, tutakuwapigia simu hivi karibuni.";
    }
    return "Sawa, tutakuwapigia simu kesho.";
  }

  formatOptOut(): string {
    return "Umefungiwa kutoka kwenye orodha ya wanaopigiwa simu.";
  }

  formatUnknown(): string {
    return "Samahani, sikuelewi. Unaweza kurudia?";
  }
}

// ── Web Adapter ────────────────────────────────────────────────────────────────

export class WebAdapter implements ChannelFormatter {
  /**
   * Format response for web demo.
   * Returns structured JSON for frontend rendering.
   */
  static format(aiResponse: AiResponse): {
    text: string;
    question?: string;
    ended: boolean;
    language: string;
    data?: Record<string, unknown>;
  } {
    return {
      text: aiResponse.text,
      question: aiResponse.question,
      ended: aiResponse.ended,
      language: aiResponse.language,
      data: aiResponse.data,
    };
  }

  formatBrief(ctx: IntelligenceContext, lang: "sw" | "en"): string {
    // Same as SMS for web
    return new SmsAdapter().formatBrief(ctx, lang);
  }

  formatWaterPoints(): string {
    return new SmsAdapter().formatWaterPoints();
  }

  formatCallConfirmation(when: "now" | "tomorrow"): string {
    return new SmsAdapter().formatCallConfirmation(when);
  }

  formatOptOut(): string {
    return new SmsAdapter().formatOptOut();
  }

  formatUnknown(): string {
    return "Invalid choice. Please try again.";
  }
}

// ── Unified Router ───────────────────────────────────────────────────────────────

/**
 * Get the appropriate formatter for a channel.
 */
export function getFormatter(channel: Channel): ChannelFormatter {
  switch (channel) {
    case "ussd":
      return new UssdAdapter();
    case "sms":
      return new SmsAdapter();
    case "voice":
    case "web":
      return new WebAdapter();
    default:
      return new WebAdapter();
  }
}
