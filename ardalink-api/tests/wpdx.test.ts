import { describe, expect, it, vi } from "vitest";

// Mock the snapshot so the tests are independent of whatever WPDx looks
// like today. Three synthetic points across two wards with mixed status.
vi.mock("../src/lib/data/wpdxIsiolo.js", () => ({
  WPDX_ISIOLO: [
    {
      wpdxId: "AAA+0001",
      county: "Isiolo",
      subCounty: "Isiolo North",
      ward: "Ngare Mara",
      lat: 0.500,
      lon: 37.700,
      waterSource: "Borehole/Tubewell",
      waterTech: "Hand Pump - Rope",
      facilityType: "Improved",
      statusClean: "Functional",
      reportDate: "2024-06-01",
      installYear: null,
      management: null,
      pay: null,
      isLatest: true,
    },
    {
      wpdxId: "BBB+0002",
      county: "Isiolo",
      subCounty: "Isiolo North",
      ward: "Ngare Mara",
      lat: 0.520,
      lon: 37.680,
      waterSource: "Piped Water",
      waterTech: "Public Tapstand",
      facilityType: "Improved",
      statusClean: "Non-Functional",
      reportDate: "2020-06-01",
      installYear: null,
      management: null,
      pay: null,
      isLatest: true,
    },
    {
      wpdxId: "CCC+0003",
      county: "Isiolo",
      subCounty: "Isiolo North",
      ward: "Burat",
      lat: 0.400,
      lon: 37.500,
      waterSource: "Borehole/Tubewell",
      waterTech: "Hand Pump - Rope",
      facilityType: "Improved",
      statusClean: "Functional but needs repair",
      reportDate: "2023-01-01",
      installYear: null,
      management: null,
      pay: null,
      isLatest: true,
    },
  ],
}));

import {
  distanceKm,
  displayName,
  nearestPoints,
  pointsForWard,
  statusFor,
  totalCount,
  workingCount,
} from "../src/lib/wpdx.js";

describe("wpdx helpers", () => {
  it("statusFor classifies WPDx status_clean strings tri-state", () => {
    expect(statusFor({ statusClean: "Functional" } as never)).toBe("working");
    expect(
      statusFor({ statusClean: "Functional but needs repair" } as never),
    ).toBe("working");
    expect(statusFor({ statusClean: "Non-Functional" } as never)).toBe(
      "broken",
    );
    expect(statusFor({ statusClean: null } as never)).toBe("unknown");
    expect(statusFor({ statusClean: "Something Else" } as never)).toBe(
      "unknown",
    );
  });

  it("distanceKm returns 0 for the same point and increases with separation", () => {
    const a = { lat: 0.5, lon: 37.7 };
    expect(distanceKm(a, a)).toBeCloseTo(0);
    const b = { lat: 0.6, lon: 37.7 };
    const c = { lat: 1.0, lon: 37.7 };
    expect(distanceKm(a, b)).toBeGreaterThan(0);
    expect(distanceKm(a, c)).toBeGreaterThan(distanceKm(a, b));
    // ~1 degree of latitude at the equator is ~111 km.
    const oneDeg = distanceKm({ lat: 0, lon: 37 }, { lat: 1, lon: 37 });
    expect(oneDeg).toBeGreaterThan(110);
    expect(oneDeg).toBeLessThan(112);
  });

  it("displayName synthesises a readable label from ward + source + wpdx suffix", () => {
    const name = displayName({
      ward: "Ngare Mara",
      waterSource: "Borehole/Tubewell",
      wpdxId: "AAA+0001",
    } as never);
    // Uses lowercased source and the tail after '+' for the code suffix.
    expect(name.toLowerCase()).toContain("ngare mara");
    expect(name.toLowerCase()).toContain("borehole/tubewell");
    expect(name).toContain("0001");
  });

  it("nearestPoints orders by distance", () => {
    // Origin near ward Ngare Mara — the two NM points should come first.
    const near = nearestPoints({ lat: 0.5, lon: 37.7 }, 3);
    expect(near).toHaveLength(3);
    expect(near[0].point.wpdxId).toBe("AAA+0001");
    expect(near[0].distanceKm).toBeLessThan(near[1].distanceKm);
    expect(near[1].distanceKm).toBeLessThanOrEqual(near[2].distanceKm);
  });

  it("nearestPoints workingOnly filters out non-functional points", () => {
    const near = nearestPoints({ lat: 0.5, lon: 37.7 }, 5, {
      workingOnly: true,
    });
    // BBB is Non-Functional; must not appear.
    expect(near.map((n) => n.point.wpdxId)).not.toContain("BBB+0002");
    expect(near.map((n) => n.point.wpdxId)).toEqual(
      expect.arrayContaining(["AAA+0001", "CCC+0003"]),
    );
    // Every returned row must be status='working'.
    for (const n of near) expect(n.status).toBe("working");
  });

  it("nearestPoints caps at N even when more matches exist", () => {
    const near = nearestPoints({ lat: 0.5, lon: 37.7 }, 1);
    expect(near).toHaveLength(1);
  });

  it("pointsForWard returns points for the requested ward", () => {
    const nm = pointsForWard("Ngare Mara");
    expect(nm.map((n) => n.point.wpdxId).sort()).toEqual(
      ["AAA+0001", "BBB+0002"].sort(),
    );
  });

  it("pointsForWard is case-insensitive and honours ward aliases", () => {
    // Snapshot has 'Burat' — an ArdaLink tenant slug 'burat' should hit.
    expect(pointsForWard("burat")).toHaveLength(1);
    // Alias: our tenant 'oldonyiro' vs WPDx 'Oldo/Nyiro' (not in this
    // fixture but the alias table still resolves — expect empty here).
    expect(pointsForWard("oldonyiro")).toHaveLength(0);
  });

  it("totalCount + workingCount reflect the snapshot", () => {
    expect(totalCount()).toBe(3);
    // Functional + Functional-needs-repair both count as working.
    expect(workingCount()).toBe(2);
  });
});
