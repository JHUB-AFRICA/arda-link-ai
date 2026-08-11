import { describe, it, expect } from "vitest";
import { isSatelliteReadingStale, satelliteAsOfPhrase } from "../src/lib/dataFreshness.js";

const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();

describe("isSatelliteReadingStale", () => {
  it("is false for a reading within the last 30 days", () => {
    expect(isSatelliteReadingStale(daysAgo(10))).toBe(false);
  });

  it("is true for a reading over 30 days old — the confirmed live incident was ~32 days", () => {
    expect(isSatelliteReadingStale(daysAgo(32))).toBe(true);
  });

  it("is false when there's no reading at all (a different, already-handled case)", () => {
    expect(isSatelliteReadingStale(null)).toBe(false);
  });

  it("is false for an unparseable date rather than throwing", () => {
    expect(isSatelliteReadingStale("not-a-date")).toBe(false);
  });
});

describe("satelliteAsOfPhrase", () => {
  it("returns a Swahili phrase anchored to the real date", () => {
    const phrase = satelliteAsOfPhrase("2026-07-09T00:00:00Z", "sw");
    expect(phrase).toMatch(/^kwa taarifa ya /);
  });

  it("returns an English phrase anchored to the real date", () => {
    const phrase = satelliteAsOfPhrase("2026-07-09T00:00:00Z", "en");
    expect(phrase).toMatch(/^as of /);
  });

  it("returns null when there's nothing to anchor to", () => {
    expect(satelliteAsOfPhrase(null, "en")).toBeNull();
  });
});
