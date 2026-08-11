/**
 * Unit tests for the voice copy library.
 *
 * These are pure-function tests — no Supabase, no AT, no Azure. The
 * HerderContext is stubbed inline so we can exercise language routing
 * and variance determinism in isolation.
 */

import { describe, it, expect } from "vitest";
import {
  categoryLabelFor,
  dtmfConfirmation,
  dtmfMenuPrompt,
  languageForCaller,
  noInputFallback,
  postRecordThanks,
  resetMessage,
  voiceOpener,
} from "../src/lib/voiceCopy";
import type { HerderContext } from "../src/lib/herderContext";

function makeCtx(patch: Partial<HerderContext> = {}): HerderContext {
  return {
    known: true,
    tier: "verified",
    peerCallerCount: null,
    peerThinAnimalsCount: null,
    peerBrokenWaterCount: null,
    peerWindowDays: null,
    source: "supabase",
    phone: "+254712000004",
    canonicalPhone: "+254712000004",
    pastoralistId: "uuid-abc",
    name: "Mohamed Ali",
    location: null,
    preferredLanguage: "sw",
    herdSize: null,
    cattle: null,
    goats: null,
    camels: null,
    waterSource: null,
    lastContactAt: null,
    lastBcsScore: null,
    lastBcsSpecies: null,
    lastActionTag: null,
    lastReportedLocation: null,
    lastReportedQuadrant: null,
    lastReportAt: null,
    wardId: "242",
    wardName: "Bulla Pesa",
    wardMonth: "JUL",
    wardStressedPct: null,
    wardNdviPct: null,
    wardNdviMean: 0.28,
    wardNdviAsOf: null,
    wardVci: null,
    wardRainfall30dMm: null,
    wardTemperatureC: null,
    wardHumidityPct: null,
    wardEt0Mm: null,
    wardDroughtSeverity: null,
    wardRiskLevel: null,
    wardRecommendation: null,
    neighborWardName: null,
    neighborNdviMean: null,
    neighborNdviDelta: null,
    nearestWaterPointName: null,
    nearestWaterPointDistanceKm: null,
    nearestWaterPointStatus: null,
    nearestWorkingWaterPointName: null,
    nearestWorkingWaterPointDistanceKm: null,
    lastKnownLat: null,
    lastKnownLon: null,
    lastKnownLocationSource: null,
    baselineMonth: 7,
    baselineYears: 7,
    ndviBaselineP50: 0.24,
    ndviBaselineP5: 0.18,
    ndviBaselineP95: 0.33,
    vciDerived: 20,
    worseThanYears: 6,
    driestYearOnRecord: 2020,
    wardCellCount: null,
    wardStressedCellCount: null,
    wardCellNdviMedian: null,
    nearestCellId: null,
    nearestCellNdvi: null,
    nearestCellAnomaly: null,
    ...patch,
  };
}

describe("languageForCaller", () => {
  it("respects a Supabase 'sw' preference", () => {
    expect(languageForCaller(makeCtx({ preferredLanguage: "sw" }))).toBe("sw");
    expect(languageForCaller(makeCtx({ preferredLanguage: "swahili" }))).toBe("sw");
    expect(languageForCaller(makeCtx({ preferredLanguage: "kiswahili" }))).toBe(
      "sw",
    );
  });

  it("respects a Supabase 'en' preference", () => {
    expect(languageForCaller(makeCtx({ preferredLanguage: "en" }))).toBe("en");
    expect(languageForCaller(makeCtx({ preferredLanguage: "english" }))).toBe(
      "en",
    );
    expect(languageForCaller(makeCtx({ preferredLanguage: "ENG" }))).toBe("en");
  });

  it("defaults to Swahili when preference is null or unknown", () => {
    expect(languageForCaller(makeCtx({ preferredLanguage: null }))).toBe("sw");
    expect(languageForCaller(makeCtx({ preferredLanguage: "spanish" }))).toBe(
      "sw",
    );
    expect(languageForCaller(makeCtx({ preferredLanguage: "" }))).toBe("sw");
  });
});

describe("voiceOpener — insight selection + language routing", () => {
  it("leads with severe-drought line in Swahili when VCI ≤ 25 and history exists", () => {
    const { text, lang } = voiceOpener(
      makeCtx({ vciDerived: 20, baselineYears: 7, driestYearOnRecord: 2020 }),
    );
    expect(lang).toBe("sw");
    expect(text).toMatch(/Habari|Salamu|Karibu/);
    expect(text).toMatch(/machache mno/);
    // Any of the 3 sw ask templates covers these keywords.
    expect(text).toMatch(/mifugo|Tunapenda|Tuseme|dakika|taarifa/);
    // No English words in a Swahili opener.
    expect(text).not.toMatch(/\bthis\b|\bpasture\b|\bhundred\b/i);
    // No jargon leaks.
    expect(text).not.toMatch(/VCI|WPDx|NDVI|JULs/);
  });

  it("leads with severe-drought line in English when preferred_language=en", () => {
    const { text, lang } = voiceOpener(
      makeCtx({
        preferredLanguage: "en",
        vciDerived: 22,
        baselineYears: 8,
        driestYearOnRecord: 2017,
      }),
    );
    expect(lang).toBe("en");
    expect(text).toMatch(/Hello|Good day|Hi/);
    expect(text).toMatch(/grass is very thin/i);
    expect(text).toMatch(/2017/);
    // No Kiswahili in an English opener.
    expect(text).not.toMatch(/\bhabari\b|\bmifugo\b|\bkwaheri\b/i);
    // No jargon.
    expect(text).not.toMatch(/VCI|WPDx|NDVI/);
  });

  it("prefers broken-water insight over neighbor when both present", () => {
    const { text } = voiceOpener(
      makeCtx({
        vciDerived: 65, // not severe
        nearestWaterPointName: "Burat borehole/tubewell 89H",
        nearestWaterPointDistanceKm: 4.2,
        nearestWaterPointStatus: "broken",
        neighborWardName: "Wabera",
        neighborNdviDelta: 0.15,
      }),
    );
    expect(text).toMatch(/Bwawa|borehole/);
    expect(text).not.toMatch(/jirani|neighbour/i);
  });

  it("falls back to neighbor insight when drought is mild and water is unknown", () => {
    const { text } = voiceOpener(
      makeCtx({
        vciDerived: 65,
        nearestWaterPointStatus: null,
        neighborWardName: "Wabera",
        neighborNdviMean: 0.35,
        neighborNdviDelta: 0.12,
      }),
    );
    expect(text).toMatch(/Wabera/);
    expect(text).toMatch(/majani|greener/i);
  });

  it("omits the insight entirely when nothing crosses the threshold", () => {
    const { text } = voiceOpener(
      makeCtx({
        vciDerived: 70, // healthy
        baselineYears: 3, // below the 5-yr min anyway
        nearestWaterPointStatus: "working",
        neighborNdviDelta: 0.02, // too small
      }),
    );
    // No insight phrases surface — assert on absence rather than
    // sentence count (greeting templates B/C are two sentences).
    expect(text).not.toMatch(
      /machache mno|below the .+ average|jirani|greener|Bwawa|borehole/,
    );
  });

  it("is stable within a UTC day for the same caller", () => {
    const ctx = makeCtx({ vciDerived: 20, baselineYears: 7 });
    const a = voiceOpener(ctx).text;
    const b = voiceOpener(ctx).text;
    expect(a).toBe(b);
  });

  it("rotates variant across different phones on the same day", () => {
    // 20 different phones — with 3 templates, we should see at least
    // 2 distinct greetings.
    const phones = Array.from({ length: 20 }, (_, i) => `+2547120000${i.toString().padStart(2, "0")}`);
    const greetings = new Set(
      phones.map(
        (p) => voiceOpener(makeCtx({ canonicalPhone: p, phone: p })).text.split(" ")[0],
      ),
    );
    expect(greetings.size).toBeGreaterThanOrEqual(2);
  });
});

describe("dtmfMenuPrompt", () => {
  it("Swahili menu names 7 options with familiar words", () => {
    const s = dtmfMenuPrompt("sw");
    expect(s).toMatch(/moja.*mbili.*tatu.*nne.*tano.*sita.*saba/s);
    expect(s).toMatch(/mifugo|maji|vifo|lishe|maziwa/);
    expect(s).not.toMatch(/Press|body condition/i);
  });

  it("English menu also names 7 options", () => {
    const e = dtmfMenuPrompt("en");
    expect(e).toMatch(/one.*two.*three.*four.*five.*six.*seven/s);
    expect(e).toMatch(/animal condition|water status|losses|feed|milk/);
    expect(e).not.toMatch(/Bonyeza|mifugo/);
  });
});

describe("categoryLabelFor + dtmfConfirmation", () => {
  it("returns natural Swahili category names", () => {
    expect(categoryLabelFor("sw", "bcs")).toBe("hali ya mifugo");
    expect(categoryLabelFor("sw", "water_point")).toBe("hali ya maji");
    expect(categoryLabelFor("sw", "mortality")).toBe("vifo vya mifugo");
  });

  it("returns natural English category names", () => {
    expect(categoryLabelFor("en", "bcs")).toBe("animal condition");
    expect(categoryLabelFor("en", "water_point")).toBe("water point status");
  });

  it("dtmfConfirmation embeds the label in a natural sentence", () => {
    const sw = dtmfConfirmation("sw", "hali ya mifugo");
    expect(sw).toMatch(/Umechagua hali ya mifugo/);
    expect(sw).toMatch(/Sema baada ya sauti/);

    const en = dtmfConfirmation("en", "animal condition");
    expect(en).toMatch(/You chose animal condition/);
    expect(en).toMatch(/beep/);
  });
});

describe("post-record + fallbacks", () => {
  it("thanks in Swahili by name", () => {
    expect(postRecordThanks(makeCtx({ name: "Amina" }), "sw")).toMatch(
      /Asante Amina/,
    );
  });

  it("thanks in English by name", () => {
    expect(
      postRecordThanks(makeCtx({ name: "Amina", preferredLanguage: "en" }), "en"),
    ).toMatch(/Thank you Amina/);
  });

  it("skips the name gracefully when unknown", () => {
    const sw = postRecordThanks(makeCtx({ name: null }), "sw");
    expect(sw).toBe("Asante. Tunapokea ripoti yako. Kwaheri.");
    const en = postRecordThanks(makeCtx({ name: null }), "en");
    expect(en).toBe("Thank you. Your report is being received. Goodbye.");
  });

  it("no-input fallback + reset are localized", () => {
    expect(noInputFallback("sw")).toMatch(/Hakuna namba/);
    expect(noInputFallback("en")).toMatch(/No key was pressed/);
    expect(resetMessage("sw")).toMatch(/mwanzo/);
    expect(resetMessage("en")).toMatch(/reset/);
  });
});
