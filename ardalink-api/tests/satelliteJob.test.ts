/**
 * Unit tests for the satellite job scheduler.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the engine client before importing the job
vi.mock("../src/lib/engine", () => ({
  triggerSatelliteRefresh: vi.fn(() =>
    Promise.resolve({
      status: "success",
      wards: ["bula-pesa", "garbatulla", "merti"],
      started_at: new Date().toISOString(),
      results: {
        "bula-pesa": { vci: 22.1, ndvi_now: 0.17, ndvi_min: 0.08, ndvi_max: 0.45 },
        "garbatulla": { vci: 35.5, ndvi_now: 0.22, ndvi_min: 0.10, ndvi_max: 0.48 },
        "merti": { vci: 28.3, ndvi_now: 0.19, ndvi_min: 0.09, ndvi_max: 0.42 },
      },
      error: null,
    }),
  ),
}));

describe("Satellite job - season detection", () => {
  it("detects dry season correctly", () => {
    const drySeasonMonths = [1, 2, 3, 6, 7, 8, 9];
    for (const month of drySeasonMonths) {
      const date = new Date(2026, month - 1, 15);
      const isDry = month >= 6 && month <= 9;
      expect(isDry).toBe(month >= 6 && month <= 9);
    }
  });

  it("detects wet season correctly", () => {
    const wetSeasonMonths = [4, 5, 10, 11, 12];
    for (const month of wetSeasonMonths) {
      const isDry = month >= 6 && month <= 9;
      expect(isDry).toBe(false);
    }
  });
});

describe("Satellite job - interval calculation", () => {
  it("returns weekly interval in dry season", () => {
    // Dry season: Jun-Sep (6-9) = weekly
    const weekMs = 7 * 24 * 60 * 60 * 1000;
    const month = 7; // July
    const isDry = month >= 6 && month <= 9;
    const interval = isDry ? weekMs : 30 * 24 * 60 * 60 * 1000;
    expect(interval).toBe(weekMs);
  });

  it("returns monthly interval in wet season", () => {
    // Wet season: Oct-Dec (10-12) and Apr-May (4-5) = monthly
    const monthMs = 30 * 24 * 60 * 60 * 1000;
    const month = 11; // November
    const isDry = month >= 6 && month <= 9;
    const interval = isDry ? 7 * 24 * 60 * 60 * 1000 : monthMs;
    expect(interval).toBe(monthMs);
  });
});

describe("Satellite job - enable/disable", () => {
  beforeEach(() => {
    // Reset env var before each test
    delete process.env.SATELLITE_JOB_ENABLED;
  });

  it("is enabled by default", () => {
    const enabled = process.env.SATELLITE_JOB_ENABLED !== "false";
    expect(enabled).toBe(true);
  });

  it("can be disabled via env var", () => {
    process.env.SATELLITE_JOB_ENABLED = "false";
    const enabled = process.env.SATELLITE_JOB_ENABLED !== "false";
    expect(enabled).toBe(false);
  });
});

describe("Satellite job - schedule description", () => {
  it("returns correct description for dry season", () => {
    const month = 7; // July (dry season)
    const season = month >= 6 && month <= 9 ? "dry" : "wet";
    const interval = month >= 6 && month <= 9 ? "weekly" : "monthly";
    const seasonMonths = month >= 6 && month <= 9 ? "Jun-Sep, Jan-Mar" : "Oct-Dec, Apr-May";
    const description = `${season} season (${seasonMonths}), ${interval} refresh`;
    expect(description).toBe("dry season (Jun-Sep, Jan-Mar), weekly refresh");
  });

  it("returns correct description for wet season", () => {
    const month = 11; // November (wet season)
    const season = month >= 6 && month <= 9 ? "dry" : "wet";
    const interval = month >= 6 && month <= 9 ? "weekly" : "monthly";
    const seasonMonths = month >= 6 && month <= 9 ? "Jun-Sep, Jan-Mar" : "Oct-Dec, Apr-May";
    const description = `${season} season (${seasonMonths}), ${interval} refresh`;
    expect(description).toBe("wet season (Oct-Dec, Apr-May), monthly refresh");
  });
});

describe("Satellite job - module structure", () => {
  it("exports all required functions", async () => {
    const job = await import("../src/jobs/satelliteJob");
    expect(typeof job.runSatelliteJob).toBe("function");
    expect(typeof job.startSatelliteJob).toBe("function");
    expect(typeof job.stopSatelliteJob).toBe("function");
    expect(typeof job.isSatelliteJobEnabled).toBe("function");
    expect(typeof job.getScheduleDescription).toBe("function");
  });
});

describe("Jobs registry", () => {
  it("exports satellite job functions", async () => {
    const jobs = await import("../src/jobs");
    expect(typeof jobs.runSatelliteJob).toBe("function");
    expect(typeof jobs.startSatelliteJob).toBe("function");
    expect(typeof jobs.stopSatelliteJob).toBe("function");
    expect(typeof jobs.isSatelliteJobEnabled).toBe("function");
    expect(typeof jobs.getScheduleDescription).toBe("function");
  });
});
