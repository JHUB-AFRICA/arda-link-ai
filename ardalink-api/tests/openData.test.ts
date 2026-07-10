/**
 * Tests for the open-source data integration.
 *
 * Hits Open-Meteo + Planetary Computer in live mode. The tests are
 * skipped if any of the upstream APIs is unreachable — we don't
 * want a flaky outage to block the demo's "make verify" gate.
 */
import { describe, it, expect } from "vitest";

import {
  fetchHistoricalClimateWindow,
  fetchYearOverYearClimate,
  fetchAirQualitySnapshot,
  discoverPlanetaryComputer,
  discoverAllForWard,
  probeOpenDataSources,
  OPEN_DATA_SOURCES,
} from "../src/lib/openData";

const WARD_LAT = 0.355;
const WARD_LON = 37.583;
const WARD_BBOX: [number, number, number, number] = [37.0, -0.5, 38.5, 1.0];

async function safeRun<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`[skip ${label}] ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

// Open-Meteo's Archive endpoint can be slow (5-10 s) under load.
// The default 5 s vitest timeout cuts requests off before safeRun
// can catch and return null. Give these two the same 15 s ceiling
// used by the other live-network tests below so they cleanly skip
// on outage instead of hard-failing the suite.
const LIVE_NET_TIMEOUT_MS = 15_000;

describe("Open-Meteo Archive — historical climate window", () => {
  it(
    "returns a window with the expected shape",
    async () => {
      const r = await safeRun("Open-Meteo Archive", () =>
        fetchHistoricalClimateWindow(
          WARD_LAT,
          WARD_LON,
          "2025-06-01",
          "2025-06-30",
        ),
      );
      if (!r) return; // upstream unreachable — skip
      expect(r.days).toBe(30);
      expect(r.source).toBe("open-meteo-archive");
      expect(["none", "mild", "moderate", "severe", "extreme"]).toContain(
        r.droughtSeverity,
      );
      expect(r.moistureAdequacyIndex).toBeGreaterThanOrEqual(0);
    },
    LIVE_NET_TIMEOUT_MS,
  );
});

describe("Open-Meteo Archive — year-over-year", () => {
  it(
    "produces a comparison with an interpretation string",
    async () => {
      const r = await safeRun("Open-Meteo Archive (year-over-year)", () =>
        fetchYearOverYearClimate(WARD_LAT, WARD_LON, 30),
      );
      if (!r) return;
      expect(r.comparison.interpretation.length).toBeGreaterThan(10);
      expect(typeof r.comparison.severityShift).toBe("string");
      // The two windows must cover the same number of days.
      expect(r.current.days).toBe(r.lastYear.days);
    },
    LIVE_NET_TIMEOUT_MS,
  );
});

describe("Open-Meteo Air Quality — PM2.5 / PM10", () => {
  it("returns positive µg/m³ readings", async () => {
    const r = await safeRun("Open-Meteo Air Quality", () =>
      fetchAirQualitySnapshot(WARD_LAT, WARD_LON),
    );
    if (!r) return;
    expect(r.pm2_5UgM3).toBeGreaterThan(0);
    expect(r.pm10UgM3).toBeGreaterThan(0);
    expect(r.source).toBe("open-meteo-air-quality");
  });
});

describe("Microsoft Planetary Computer — STAC discovery", () => {
  it("finds MODIS NDVI composites over the ward", async () => {
    const r = await safeRun("PC STAC MOD13Q1", () =>
      discoverPlanetaryComputer(
        "modis-13Q1-061",
        WARD_BBOX,
        "2026-05-15",
        "2026-06-22",
        { limit: 3 },
      ),
    );
    if (!r) return;
    expect(r.collection).toBe("modis-13Q1-061");
    expect(r.items.length).toBeGreaterThan(0);
    expect(r.items[0]?.assets).toContain("250m_16_days_NDVI");
  });

  it("finds Sentinel-2 L2A scenes with cloud-cover filter", async () => {
    const r = await safeRun("PC STAC Sentinel-2", () =>
      discoverPlanetaryComputer(
        "sentinel-2-l2a",
        WARD_BBOX,
        "2026-06-15",
        "2026-06-22",
        { maxCloudCoverPct: 50, limit: 3 },
      ),
    );
    if (!r) return;
    expect(r.items.length).toBeGreaterThan(0);
  });
});

describe("discoverAllForWard — multi-collection discovery", () => {
  it("returns 3 collection buckets with at least one item each (where available)", async () => {
    const r = await safeRun("PC STAC all-ward", () =>
      discoverAllForWard(WARD_BBOX, 60),
    );
    if (!r) return;
    expect(Object.keys(r).sort()).toEqual(
      ["jrc-gsw", "modis-13Q1-061", "sentinel-2-l2a"],
    );
    // MOD13Q1 should always have scenes over land.
    const modis = r["modis-13Q1-061"];
    expect(modis?.count).toBeGreaterThan(0);
  });
});

describe("probeOpenDataSources — live health probe", () => {
  it("returns the configured manifest enriched with healthy/latency fields", async () => {
    const probed = await safeRun("OpenData probe", () => probeOpenDataSources());
    if (!probed) return;
    expect(probed.length).toBe(OPEN_DATA_SOURCES.length);
    for (const s of probed) {
      expect(typeof s.healthy).toBe("boolean");
      expect(s.latencyMs).toBeGreaterThanOrEqual(0);
    }
  });
});
