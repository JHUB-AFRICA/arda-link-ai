import { describe, it, expect } from "vitest";
import { buildLocalizedBrief } from "../src/lib/herderContext/briefs.js";
import { baseContext } from "../src/lib/herderContext/base.js";
import type { HerderContext } from "../src/lib/herderContext/types.js";

const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();

describe("buildLocalizedBrief — data-age disclosure (2026-08-10 audit finding)", () => {
  it("appends an 'as of' date when the severity claim is based on a reading over a month old", () => {
    const ctx: HerderContext = {
      ...baseContext("+254799954672", "bula-pesa"),
      wardStressedPct: 80, // forces severity = "severe"
      wardNdviAsOf: daysAgo(32),
    };
    const brief = buildLocalizedBrief(ctx, "en");
    expect(brief).toMatch(/\(as of .+\)$/);
  });

  it("says nothing about staleness for a fresh reading", () => {
    const ctx: HerderContext = {
      ...baseContext("+254799954672", "bula-pesa"),
      wardStressedPct: 80,
      wardNdviAsOf: daysAgo(3),
    };
    const brief = buildLocalizedBrief(ctx, "en");
    expect(brief).not.toMatch(/\(as of/);
  });

  it("stays within the 300-char USSD/SMS/voice-safe budget even with the disclosure appended", () => {
    const ctx: HerderContext = {
      ...baseContext("+254799954672", "bula-pesa"),
      name: "Wanjiru Kamau",
      wardStressedPct: 80,
      wardNdviAsOf: daysAgo(40),
      wardRainfall30dMm: 2,
      peerCallerCount: 4,
      lastBcsScore: 2.5,
    };
    const brief = buildLocalizedBrief(ctx, "en");
    expect(brief.length).toBeLessThanOrEqual(300);
  });

  it("uses Swahili 'kwa taarifa ya' phrasing for the Swahili brief", () => {
    const ctx: HerderContext = {
      ...baseContext("+254799954672", "bula-pesa"),
      wardStressedPct: 80,
      wardNdviAsOf: daysAgo(32),
    };
    const brief = buildLocalizedBrief(ctx, "sw");
    expect(brief).toMatch(/\(kwa taarifa ya/);
  });
});
