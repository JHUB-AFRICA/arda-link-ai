/**
 * Herder-natural phrasing — no jargon. Pure functions over a resolved
 * HerderContext, no Supabase/local-mirror dependencies of their own.
 */

import type { HerderContext } from "./types.js";

/**
 * Build a short bilingual (Swahili/English) herder-specific brief string,
 * suitable for TTS or SMS. If the herder is known we use their name and
 * location; otherwise we fall back to ward-level info. Bounded to ~300
 * characters so it fits in a USSD screen or single-segment SMS budget.
 */
export function buildLocalizedBrief(ctx: HerderContext, lang: "sw" | "en"): string {
  const firstName = ctx.name ? ctx.name.trim().split(/\s+/)[0] : null;
  const namePart = firstName ? `${firstName}, ` : "";

  // Herders don't say "VCI 81" or "NDVI 0.28" — those are our
  // internal signals. Convert them into a plain word ranking:
  //   severity ∈ 'severe' | 'stressed' | 'moderate' | 'fair'
  // derived from vciDerived when we have a proper baseline, else
  // from wardStressedPct as a fallback.
  const severity = severityFromCtx(ctx);

  // Rainfall — herders think in "no rain lately" not "3mm/30d".
  const rainLine =
    ctx.wardRainfall30dMm != null
      ? ctx.wardRainfall30dMm < 5
        ? { sw: "mvua ni ndogo sana mwezi huu", en: "very little rain this month" }
        : ctx.wardRainfall30dMm < 20
          ? { sw: "mvua bado ni kidogo", en: "rain has been light" }
          : { sw: "mvua imepatikana kidogo", en: "some rain has fallen" }
      : null;

  // Neighbor migration hint. Only surface when the delta is
  // meaningful AND we have a name — no point saying "consider
  // moving somewhere" without pointing.
  const neighborLine =
    ctx.neighborWardName &&
    ctx.neighborNdviDelta != null &&
    ctx.neighborNdviDelta >= 0.05
      ? {
          sw: `${ctx.neighborWardName} jirani ina majani zaidi kidogo — fikiria kuhamia huko`,
          en: `${ctx.neighborWardName} nearby has slightly more pasture — consider moving that way`,
        }
      : null;

  // Water point line — prefer working over broken. When only broken
  // is known within 30km, invite the herder to update us if it's
  // been fixed. When no working point exists at all, say so plainly.
  const waterLine = buildWaterLine(ctx, lang);

  // Peer signal — turn "isolated" into "part of a community".
  // Requires at least 2 other callers in the window to feel real;
  // one lonely report reads like the caller's own echo.
  const peerLine =
    ctx.peerCallerCount != null && ctx.peerCallerCount >= 2
      ? {
          sw: `Wachungaji ${ctx.peerCallerCount} karibu nawe wameripoti wiki hii`,
          en: `${ctx.peerCallerCount} herders near you also reported this week`,
        }
      : null;

  // Personal echo — the herder's own last report, so they know we
  // remember. First name only, natural phrasing.
  const lastBcsLine =
    ctx.lastBcsScore != null
      ? {
          sw: `Ripoti yako ya mwisho: mifugo yako BCS ${ctx.lastBcsScore.toFixed(1)}`,
          en: `Your last report: BCS ${ctx.lastBcsScore.toFixed(1)}`,
        }
      : null;

  if (lang === "sw") {
    const parts: string[] = [];
    parts.push(
      `Habari ${namePart}ArdaLink hapa` +
        (ctx.wardName ? ` (${ctx.wardName})` : "") +
        ".",
    );
    if (severity) parts.push(swSeverityLine(severity, rainLine?.sw ?? null));
    else if (rainLine) parts.push(rainLine.sw + ".");
    if (neighborLine) parts.push(neighborLine.sw + ".");
    if (waterLine) parts.push(waterLine + ".");
    if (peerLine) parts.push(peerLine.sw + ".");
    if (lastBcsLine) parts.push(lastBcsLine.sw + ".");
    return parts.join(" ").slice(0, 300);
  }

  const parts: string[] = [];
  parts.push(
    `Hello ${namePart}ArdaLink here` +
      (ctx.wardName ? ` (${ctx.wardName})` : "") +
      ".",
  );
  if (severity) parts.push(enSeverityLine(severity, rainLine?.en ?? null));
  else if (rainLine) parts.push(rainLine.en + ".");
  if (neighborLine) parts.push(neighborLine.en + ".");
  if (waterLine) parts.push(waterLine + ".");
  if (peerLine) parts.push(peerLine.en + ".");
  if (lastBcsLine) parts.push(lastBcsLine.en + ".");
  return parts.join(" ").slice(0, 300);
}

type Severity = "severe" | "stressed" | "moderate" | "fair";

function severityFromCtx(ctx: HerderContext): Severity | null {
  // Prefer VCI-based severity when we have >=5 years of baseline.
  if (
    ctx.vciDerived != null &&
    ctx.baselineYears != null &&
    ctx.baselineYears >= 5
  ) {
    if (ctx.vciDerived <= 25) return "severe";
    if (ctx.vciDerived <= 50) return "stressed";
    if (ctx.vciDerived <= 75) return "moderate";
    return "fair";
  }
  // Fallback to stressed-pixel-pct when no baseline.
  if (ctx.wardStressedPct != null) {
    if (ctx.wardStressedPct >= 70) return "severe";
    if (ctx.wardStressedPct >= 40) return "stressed";
    if (ctx.wardStressedPct >= 20) return "moderate";
    return "fair";
  }
  return null;
}

function swSeverityLine(severity: Severity, rainTail: string | null): string {
  const rainSuffix = rainTail ? `, ${rainTail}` : "";
  const map: Record<Severity, string> = {
    severe: `Malisho ya ward yako ni mabaya sana mwezi huu${rainSuffix}`,
    stressed: `Malisho ya ward yako ni kidogo chini ya wastani${rainSuffix}`,
    moderate: `Malisho ya ward yako ni ya wastani${rainSuffix}`,
    fair: `Malisho ya ward yako bado ni ya kadri${rainSuffix}`,
  };
  return map[severity] + ".";
}

function enSeverityLine(severity: Severity, rainTail: string | null): string {
  const rainSuffix = rainTail ? `, ${rainTail}` : "";
  const map: Record<Severity, string> = {
    severe: `Pasture is very poor this month${rainSuffix}`,
    stressed: `Pasture is a bit below average${rainSuffix}`,
    moderate: `Pasture is around average${rainSuffix}`,
    fair: `Pasture is holding for now${rainSuffix}`,
  };
  return map[severity] + ".";
}

function buildWaterLine(ctx: HerderContext, lang: "sw" | "en"): string | null {
  if (!ctx.nearestWaterPointName) return null;
  const km = ctx.nearestWaterPointDistanceKm;
  const wardOfPoint = ctx.nearestWaterPointName.split(" ")[0] ?? ctx.nearestWaterPointName;

  if (ctx.nearestWaterPointStatus === "working") {
    if (lang === "sw") {
      return `Bwawa la ${wardOfPoint} lilikuwa likifanya kazi (${km ?? "?"}km)`;
    }
    return `${wardOfPoint} borehole was reported working (${km ?? "?"}km)`;
  }
  if (ctx.nearestWaterPointStatus === "broken") {
    if (lang === "sw") {
      return `Bwawa la karibu (${wardOfPoint}) ilikuwa mbovu — tuambie kama sasa iko sawa`;
    }
    return `The nearest borehole (${wardOfPoint}) was broken — tell us if it works now`;
  }
  return null;
}

/**
 * Very short spoken opener for the deterministic voice pipeline. Kept
 * under ~35 words so the TTS clip is 8–10 seconds and the herder isn't
 * paying for airtime on a monologue.
 */
export function buildLocalizedVoiceOpener(ctx: HerderContext): string {
  const nameBit = ctx.name ? `, ${ctx.name}` : "";
  const locBit = ctx.location
    ? ` in ${ctx.location}`
    : ctx.wardName
      ? ` in ${ctx.wardName}`
      : "";
  // Prefer the real-anomaly line when we have a Supabase baseline —
  // "VCI 12, driest June since 2017" beats "97 percent stressed"
  // because it's grounded in actual history the herder can weigh
  // against their memory of past droughts. Falls back cleanly when
  // there's no baseline yet.
  let stressedBit: string;
  if (ctx.vciDerived != null && ctx.baselineYears != null && ctx.baselineYears >= 5) {
    const vci = Math.round(ctx.vciDerived);
    const monthName = ctx.wardMonth ? ctx.wardMonth.split(" ")[0] : "this month";
    const worseLine =
      ctx.worseThanYears != null && ctx.baselineYears != null
        ? ` — worse than ${ctx.worseThanYears} of the last ${ctx.baselineYears} ${monthName}s`
        : "";
    const sinceLine =
      ctx.driestYearOnRecord != null && ctx.vciDerived <= 20
        ? `, driest since ${ctx.driestYearOnRecord}`
        : "";
    stressedBit = `Vegetation condition is ${vci} out of one hundred${worseLine}${sinceLine}`;
  } else if (ctx.wardStressedPct != null) {
    stressedBit = `About ${ctx.wardStressedPct.toFixed(0)} percent of grazing land is stressed`;
  } else if (ctx.wardNdviMean != null) {
    stressedBit = `Your ward NDVI is ${ctx.wardNdviMean.toFixed(2)}`;
  } else {
    stressedBit = "We have your ward's latest satellite reading";
  }
  const riskBit = ctx.wardRiskLevel ? `, drought risk ${ctx.wardRiskLevel}` : "";
  const memoryBit = ctx.lastBcsScore != null
    ? ` We saw your last report of body condition ${ctx.lastBcsScore.toFixed(1)}.`
    : "";
  const neighborBit =
    ctx.neighborWardName && ctx.neighborNdviMean != null
      ? ` In your neighbor ${ctx.neighborWardName}, pasture is stronger — consider moving that way.`
      : "";
  // Water-point reference is only helpful when we can tell the herder
  // something they can act on: skip when the nearest is >30 km away
  // (probably not the point they use) or when status is unknown.
  const waterBit =
    ctx.nearestWaterPointName &&
    ctx.nearestWaterPointDistanceKm != null &&
    ctx.nearestWaterPointDistanceKm < 30 &&
    ctx.nearestWaterPointStatus !== "unknown"
      ? ctx.nearestWaterPointStatus === "working"
        ? ` Your nearest known water point is ${ctx.nearestWaterPointName}, about ${ctx.nearestWaterPointDistanceKm} km away, last recorded working.`
        : ` The nearest WPDx-recorded water point ${ctx.nearestWaterPointName} was last surveyed broken — please confirm.`
      : "";
  return (
    `Habari${nameBit}. This is ArdaLink${locBit}. ${stressedBit}${riskBit}.${memoryBit}${neighborBit}${waterBit} ` +
    `We would like your report today.`
  );
}
