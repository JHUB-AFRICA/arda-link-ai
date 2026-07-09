/**
 * Unit tests for the Supabase-baseline maths.
 *
 * We do NOT hit real Supabase here — the `fetchWardMonthlyBaseline`
 * function is exercised via its outputs (`computeVci`,
 * `countWorseThanYears`) using synthetic baseline shapes. Real
 * end-to-end coverage happens via the tunnel probe + integration
 * tests, not unit tests.
 */

import { describe, it, expect } from "vitest";
import {
  computeVci,
  countWorseThanYears,
  type WardMonthlyBaseline,
} from "../src/lib/supabase";

const stubBaseline = (): WardMonthlyBaseline => ({
  wardId: "242",
  month: 6,
  years: 10,
  yearsSpan: [2016, 2025],
  ndvi: {
    min: 0.15,
    max: 0.55,
    p5: 0.18,
    p25: 0.28,
    p50: 0.35,
    p75: 0.42,
    p95: 0.52,
    mean: 0.35,
    stdev: 0.09,
    minYear: 2017,
    maxYear: 2020,
  },
  ndre: { p50: 0.2, mean: 0.2 },
});

describe("computeVci", () => {
  it("clamps to 0 when current is at or below historical min", () => {
    const b = stubBaseline();
    expect(computeVci(0.15, b)).toBe(0);
    expect(computeVci(0.1, b)).toBe(0);
  });

  it("returns 100 at or above historical max", () => {
    const b = stubBaseline();
    expect(computeVci(0.55, b)).toBe(100);
    expect(computeVci(0.6, b)).toBe(100);
  });

  it("returns 50 at the midpoint of min..max (linear interpolation)", () => {
    // (0.35 - 0.15) / (0.55 - 0.15) * 100 = 50
    const b = stubBaseline();
    expect(computeVci(0.35, b)).toBeCloseTo(50, 1);
  });

  it("returns null when baseline is null / current is null", () => {
    expect(computeVci(0.3, null)).toBeNull();
    expect(computeVci(null, stubBaseline())).toBeNull();
    expect(computeVci(undefined, stubBaseline())).toBeNull();
  });

  it("returns null on degenerate (min==max) baseline", () => {
    const degenerate: WardMonthlyBaseline = {
      ...stubBaseline(),
      ndvi: {
        ...stubBaseline().ndvi,
        min: 0.3,
        max: 0.3,
        p5: 0.3,
        p50: 0.3,
        p95: 0.3,
      },
    };
    expect(computeVci(0.3, degenerate)).toBeNull();
  });
});

describe("countWorseThanYears", () => {
  it("current at min is worse than ~all years", () => {
    const b = stubBaseline();
    const r = countWorseThanYears(0.15, b)!;
    expect(r.totalYears).toBe(10);
    expect(r.worseThan).toBe(10); // percentileRank=0 => (1-0)*10
  });

  it("current at max is worse than 0 years", () => {
    const b = stubBaseline();
    const r = countWorseThanYears(0.55, b)!;
    expect(r.worseThan).toBe(0);
  });

  it("current at p50 puts caller worse than half the years", () => {
    const b = stubBaseline();
    const r = countWorseThanYears(0.35, b)!;
    // percentileRank ~= 0.5, so worseThan ~= 5 of 10.
    expect(r.worseThan).toBeGreaterThanOrEqual(4);
    expect(r.worseThan).toBeLessThanOrEqual(6);
  });

  it("current between p5 and p25 puts caller worse than most years", () => {
    const b = stubBaseline();
    const r = countWorseThanYears(0.22, b)!;
    // Between p5 (0.18) and p25 (0.28) — percentileRank ~ 0.05..0.25.
    // worseThan = (1 - rank) * 10 → 7.5..9.5
    expect(r.worseThan).toBeGreaterThanOrEqual(7);
    expect(r.worseThan).toBeLessThanOrEqual(10);
  });

  it("returns null when baseline is null", () => {
    expect(countWorseThanYears(0.3, null)).toBeNull();
    expect(countWorseThanYears(null, stubBaseline())).toBeNull();
  });
});
