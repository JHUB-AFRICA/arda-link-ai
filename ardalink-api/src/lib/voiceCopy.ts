/**
 * Voice copy library — language-aware, natural, non-robotic templates
 * for every audible turn of the deterministic voice pipeline.
 *
 * Design goals (from 2026-07-09 review):
 *   1. Pick language from ctx.preferredLanguage (Supabase) rather than
 *      code-switching mid-sentence. A caller who chose Kiswahili hears
 *      Kiswahili end-to-end; an English caller hears English end-to-end.
 *      Callers with no preference default to Kiswahili (majority in
 *      Isiolo).
 *   2. Variance pool so two consecutive calls don't hear the same script.
 *      Choice is deterministic given (phone, UTC-day) so a single caller's
 *      calls within a day sound consistent, but different days rotate.
 *   3. One primary insight per opener. The intelligence stacks (drought
 *      + neighbor + water) picks the strongest signal and mentions ONE.
 *      The rest are available on USSD / SMS as pull surfaces.
 *   4. Natural constructions. No "eighty-one out of one hundred", no
 *      "WPDx-recorded", no month-abbreviations like "JULs". Herders
 *      speak in weeks, seasons, past hard years — not in percentiles.
 *   5. Warm closes, not corporate ones. "Asante sana, mifugo ni yako"
 *      lands, "Thank you for your report" does not.
 *
 * Text is emitted as plain UTF-8 strings and pushed to Azure TTS via
 * whatever voice matches the language (sw-KE-ZuriNeural for Swahili,
 * en-KE-AsiliaNeural for English) — the AT `<Say>` primitive.
 */

import { createHash } from "node:crypto";
import type { HerderContext } from "./herderContext/index.js";

export type VoiceLang = "sw" | "en";

/**
 * Resolve the language to speak. Order:
 *   1. Explicit preferred_language from Supabase (values seen so far:
 *      "sw", "en", "swahili", "english"). Anything else falls through.
 *   2. Default: Swahili — matches Isiolo majority + our TTS quality.
 */
export function languageForCaller(ctx: HerderContext): VoiceLang {
  const raw = (ctx.preferredLanguage ?? "").trim().toLowerCase();
  if (raw === "en" || raw === "english" || raw === "eng") return "en";
  if (raw === "sw" || raw === "swahili" || raw === "kiswahili") return "sw";
  return "sw";
}

/**
 * Deterministic variant pick. Same caller within the same UTC day gets
 * the same template so if AT retries the callback we don't switch
 * scripts mid-call. Different days rotate — a returning caller doesn't
 * memorise our exact wording.
 */
function pickVariant(
  callerKey: string,
  templateCount: number,
  bucketDate: Date = new Date(),
): number {
  const day = bucketDate.toISOString().slice(0, 10); // YYYY-MM-DD
  const digest = createHash("sha1")
    .update(`${callerKey}|${day}`)
    .digest();
  // First 4 bytes → uint32 → modulo template count.
  const n = digest.readUInt32BE(0);
  return n % Math.max(1, templateCount);
}

// ── Month names in each language ────────────────────────────────────────

const SW_MONTHS = [
  "januari",
  "februari",
  "machi",
  "aprili",
  "mei",
  "juni",
  "julai",
  "agosti",
  "septemba",
  "oktoba",
  "novemba",
  "desemba",
];
const EN_MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function monthName(monthNumber: number | null, lang: VoiceLang): string {
  if (!monthNumber || monthNumber < 1 || monthNumber > 12) {
    return lang === "sw" ? "mwezi huu" : "this month";
  }
  return (lang === "sw" ? SW_MONTHS : EN_MONTHS)[monthNumber - 1] ?? "";
}

// ── Primary-insight selection ───────────────────────────────────────────

/**
 * The three signals we surface. We only speak ONE per call — the
 * strongest — to keep the opener under ~15 s of audio and avoid
 * bombarding the caller. The rest are available on USSD / SMS.
 */
type InsightKind = "drought" | "neighbor" | "water";

interface Insight {
  kind: InsightKind;
  text: string;
}

/**
 * Pick the most useful insight to voice. Priority is severity-first:
 *   1. Severe drought (VCI < 25) — the caller needs to hear it.
 *   2. Broken water point near them — actionable + easy to verify.
 *   3. Neighboring ward has better pasture — actionable migration hint.
 * When nothing meets threshold we return null and the opener keeps
 * things brief with just a greeting + ask.
 */
function pickInsight(ctx: HerderContext, lang: VoiceLang): Insight | null {
  const month = monthName(ctx.baselineMonth, lang);

  // 1. Severe drought — always leads.
  if (
    ctx.vciDerived != null &&
    ctx.baselineYears != null &&
    ctx.baselineYears >= 5
  ) {
    const vci = ctx.vciDerived;
    if (vci <= 25) {
      const since = ctx.driestYearOnRecord;
      if (lang === "sw") {
        return {
          kind: "drought",
          text: since
            ? `Majani ni machache mno mwezi huu, kama ${month} ya mwaka ${since}`
            : `Majani ni machache mno ${month} mwezi huu`,
        };
      }
      return {
        kind: "drought",
        text: since
          ? `Grass is very thin this month, like the hard ${month} of ${since}`
          : `Grass is very thin this ${month}`,
      };
    }
    if (vci <= 50) {
      // Moderate — mention comparison but frame gently.
      if (lang === "sw") {
        return {
          kind: "drought",
          text: `Malisho ni kidogo chini ya wastani wa ${month}`,
        };
      }
      return {
        kind: "drought",
        text: `Pasture is a bit below the ${month} average`,
      };
    }
  }

  // 2. Broken nearby water point — actionable ground-truth ask.
  if (
    ctx.nearestWaterPointName &&
    ctx.nearestWaterPointDistanceKm != null &&
    ctx.nearestWaterPointDistanceKm < 30 &&
    ctx.nearestWaterPointStatus === "broken"
  ) {
    const wardOfPoint = extractWardFromPointName(ctx.nearestWaterPointName);
    if (lang === "sw") {
      return {
        kind: "water",
        text: wardOfPoint
          ? `Bwawa la ${wardOfPoint} lilikuwa mbovu ripoti ya mwisho — kama sasa iko sawa tuambie`
          : `Bwawa la karibu lilikuwa mbovu ripoti ya mwisho — kama sasa iko sawa tuambie`,
      };
    }
    return {
      kind: "water",
      text: wardOfPoint
        ? `The ${wardOfPoint} borehole was last reported broken — let us know if it is working now`
        : `The nearest borehole was last reported broken — let us know if it is working now`,
    };
  }

  // 3. Neighboring ward has better pasture.
  if (
    ctx.neighborWardName &&
    ctx.neighborNdviDelta != null &&
    ctx.neighborNdviDelta >= 0.1
  ) {
    if (lang === "sw") {
      return {
        kind: "neighbor",
        text: `Jirani ${ctx.neighborWardName} ana majani bora kidogo — fikiria kuhamia huko`,
      };
    }
    return {
      kind: "neighbor",
      text: `Your neighbour ${ctx.neighborWardName} is a bit greener — worth considering that direction`,
    };
  }

  return null;
}

/**
 * WPDx synthesises point display names as "ward + source + id" (e.g.
 * "Burat borehole/tubewell 89H"). Voice pipelines only want the ward
 * for a natural "the Burat borehole" phrasing.
 */
function extractWardFromPointName(displayName: string): string | null {
  const first = displayName.split(" ")[0];
  return first && first.length > 1 ? first : null;
}

// ── Opener templates ────────────────────────────────────────────────────

/**
 * Compose the greeting sentence. Kept as a template (name / ward
 * substitution) so variance pool can swap phrasings without breaking
 * personalization.
 */
function greeting(ctx: HerderContext, lang: VoiceLang, variant: number): string {
  const nameBit = ctx.name ? ` ${ctx.name}` : "";
  const wardBit = ctx.wardName ? ` ${ctx.wardName}` : "";
  if (lang === "sw") {
    const templates = [
      `Habari${nameBit}. Ni ArdaLink kutoka${wardBit}.`,
      `Salamu${nameBit}. ArdaLink hapa.`,
      `Karibu${nameBit}, ni ArdaLink kutoka${wardBit}.`,
    ];
    return templates[variant % templates.length]!;
  }
  const templates = [
    `Hello${nameBit}, this is ArdaLink calling from${wardBit}.`,
    `Good day${nameBit}, ArdaLink here.`,
    `Hi${nameBit}, ArdaLink from${wardBit}.`,
  ];
  return templates[variant % templates.length]!;
}

/**
 * The single closing ask that hands the caller into the DTMF menu.
 */
function ask(lang: VoiceLang, variant: number): string {
  if (lang === "sw") {
    const templates = [
      "Tunapenda kusikia habari za mifugo yako leo.",
      "Tuseme kidogo kuhusu mifugo yako sasa.",
      "Uko na dakika moja kupokea taarifa yako?",
    ];
    return templates[variant % templates.length]!;
  }
  const templates = [
    "Could you share a short update on your herd today?",
    "Have a moment to tell us how your livestock are doing?",
    "We would love a quick update from you.",
  ];
  return templates[variant % templates.length]!;
}

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Voice opener text for the AT `<Say>` primitive.
 *
 * Structure:  greeting + optional-insight + ask
 *
 * We omit the insight when nothing crosses the "worth interrupting the
 * caller for" bar — a two-sentence opener beats a three-sentence one
 * that ends with filler.
 */
export function voiceOpener(ctx: HerderContext): {
  text: string;
  lang: VoiceLang;
} {
  const lang = languageForCaller(ctx);
  const callerKey = ctx.canonicalPhone || ctx.phone || "anon";
  const variant = pickVariant(callerKey, 3);

  const parts: string[] = [greeting(ctx, lang, variant)];
  const insight = pickInsight(ctx, lang);
  if (insight) parts.push(insight.text + ".");
  parts.push(ask(lang, variant));

  return { text: parts.join(" "), lang };
}

/**
 * The DTMF menu prompt read inside the `<GetDigits>` block. Same
 * options as before (7 categories) — just spoken naturally in the
 * chosen language.
 */
export function dtmfMenuPrompt(lang: VoiceLang): string {
  if (lang === "sw") {
    return (
      "Bonyeza moja kwa hali ya mifugo, mbili kwa maji, " +
      "tatu kwa vifo, nne kwa lishe, tano kwa maziwa, " +
      "sita kwa umbali wa maji, saba kwa jambo lingine."
    );
  }
  return (
    "Press one for animal condition, two for water status, " +
    "three for losses, four for feed, five for milk, " +
    "six for how far you walk to water, seven for anything else."
  );
}

/**
 * Confirmation + "please speak after the beep" prompt after the DTMF
 * selection. Uses the localized category label so the caller hears
 * "you chose animal condition" in their language.
 */
export function dtmfConfirmation(
  lang: VoiceLang,
  categoryLabel: string,
): string {
  if (lang === "sw") {
    return `Umechagua ${categoryLabel}. Sema baada ya sauti. Bonyeza alama ya reli kumaliza.`;
  }
  return `You chose ${categoryLabel}. Please speak after the beep. Press hash to finish.`;
}

/**
 * Warm closing message after AT captures the recording. The
 * post-record STT/LLM pipeline runs after this — the caller doesn't
 * wait for it.
 */
export function postRecordThanks(
  ctx: HerderContext,
  lang: VoiceLang,
): string {
  const nameBit = ctx.name ? ` ${ctx.name}` : "";
  if (lang === "sw") {
    return `Asante${nameBit}. Tunapokea ripoti yako. Kwaheri.`;
  }
  return `Thank you${nameBit}. Your report is being received. Goodbye.`;
}

/**
 * Fallback said when `<GetDigits>` gets no keypress. Same warmth as
 * the thanks message — the caller isn't at fault.
 */
export function noInputFallback(lang: VoiceLang): string {
  if (lang === "sw") {
    return "Hakuna namba iliyobonyezwa. Tafadhali piga tena wakati mwingine. Kwaheri.";
  }
  return "No key was pressed. Please call again later. Goodbye.";
}

/**
 * Message when the call flow lands on an unknown stage (should be
 * rare — usually a webhook path bug).
 */
export function resetMessage(lang: VoiceLang): string {
  if (lang === "sw") {
    return "Mkondo wa simu umerudi mwanzo. Tafadhali piga tena.";
  }
  return "Call flow was reset. Please call again.";
}

/**
 * Localized display label for a DTMF category id, used inside
 * `dtmfConfirmation`.
 */
export function categoryLabelFor(
  lang: VoiceLang,
  id: string,
): string {
  if (lang === "sw") {
    const sw: Record<string, string> = {
      bcs: "hali ya mifugo",
      water_point: "hali ya maji",
      mortality: "vifo vya mifugo",
      feeding: "lishe ya ziada",
      milk: "uzalishaji wa maziwa",
      water_trek: "umbali wa maji",
      drought_signal: "dalili nyingine za ukame",
      unknown: "jambo lingine",
    };
    return sw[id] ?? sw.unknown!;
  }
  const en: Record<string, string> = {
    bcs: "animal condition",
    water_point: "water point status",
    mortality: "livestock losses",
    feeding: "supplementary feeding",
    milk: "milk production",
    water_trek: "water trek distance",
    drought_signal: "other drought signal",
    unknown: "something else",
  };
  return en[id] ?? en.unknown!;
}

// Test seams — exported for the unit tests, not the runtime callers.
export const __test__ = {
  pickVariant,
  pickInsight,
  extractWardFromPointName,
};
