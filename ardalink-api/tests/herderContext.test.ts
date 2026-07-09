import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// State captured across mocks so individual tests can control what
// Supabase and the local mirror return.
interface Fixture {
  supabase: {
    configured: boolean;
    callContext: unknown;
    pastoralist: unknown;
    latestSatellite: unknown;
    latestWeather: unknown;
    neighborAdvice: unknown;
  };
  local: {
    pastoralist: unknown;
    lastReport: unknown;
    throwOnRead: boolean;
  };
  intelligenceLast: unknown;
}

const fx: Fixture = {
  supabase: {
    configured: true,
    callContext: null,
    pastoralist: null,
    latestSatellite: null,
    latestWeather: null,
    neighborAdvice: null,
  },
  local: {
    pastoralist: null,
    lastReport: null,
    throwOnRead: false,
  },
  intelligenceLast: null,
};

vi.mock("../src/lib/supabase.js", () => ({
  isSupabaseConfigured: () => fx.supabase.configured,
  callContextByPhone: async () => fx.supabase.callContext,
  pastoralistByPhone: async () => fx.supabase.pastoralist,
  latestSatelliteFor: async () => fx.supabase.latestSatellite,
  latestWeatherFor: async () => fx.supabase.latestWeather,
  bestNeighborForAdvice: async () => fx.supabase.neighborAdvice,
  // Baseline overlay is off-by-default in these fixtures — return null
  // so the historical-anomaly overlay is a no-op and existing
  // assertions don't need to reason about VCI. The baseline maths
  // themselves are covered in tests/supabaseBaseline.test.ts.
  fetchWardMonthlyBaseline: async () => null,
  computeVci: () => null,
  countWorseThanYears: () => null,
}));

vi.mock("../src/lib/intelligence.js", () => ({
  getLastResult: () => fx.intelligenceLast,
}));

vi.mock("../src/lib/tenancy-context.js", () => ({
  withTenantContext: async (
    _tenantId: string,
    fn: (tx: unknown) => Promise<unknown>,
  ) => {
    if (fx.local.throwOnRead) throw new Error("db is on fire");
    // Fake Drizzle-style tx that returns our fixture rows.
    let expectingPastoralists = true;
    const tx = {
      select: () => ({
        from: (_table: unknown) => {
          const stage = expectingPastoralists;
          expectingPastoralists = false;
          return {
            where: () => ({
              limit: async () => {
                if (stage) {
                  return fx.local.pastoralist ? [fx.local.pastoralist] : [];
                }
                return fx.local.lastReport ? [fx.local.lastReport] : [];
              },
              orderBy: () => ({
                limit: async () =>
                  fx.local.lastReport ? [fx.local.lastReport] : [],
              }),
            }),
          };
        },
      }),
    };
    return fn(tx);
  },
}));

vi.mock("@workspace/db", () => ({
  pastoralistsTable: { phone: "phone", tenantId: "tenant_id" },
  groundTruthReportsTable: {
    phone: "phone",
    tenantId: "tenant_id",
    createdAt: "created_at",
  },
}));

vi.mock("drizzle-orm", async () => {
  const actual =
    await vi.importActual<typeof import("drizzle-orm")>("drizzle-orm");
  return {
    ...actual,
    eq: (_c: unknown, _v: unknown) => ({}),
    and: (..._exprs: unknown[]) => ({}),
    desc: (_c: unknown) => ({}),
  };
});

beforeEach(() => {
  fx.supabase.configured = true;
  fx.supabase.callContext = null;
  fx.supabase.pastoralist = null;
  fx.supabase.latestSatellite = null;
  fx.supabase.latestWeather = null;
  fx.supabase.neighborAdvice = null;
  fx.local.pastoralist = null;
  fx.local.lastReport = null;
  fx.local.throwOnRead = false;
  fx.intelligenceLast = null;
});

afterEach(() => vi.clearAllMocks());

describe("resolveHerderContext", () => {
  it("returns source='none' base context when phone is unknown to both sides", async () => {
    const { resolveHerderContext } = await import(
      "../src/lib/herderContext.js"
    );
    const ctx = await resolveHerderContext("+254700000000", "bula-pesa");
    expect(ctx.known).toBe(false);
    expect(ctx.source).toBe("none");
    expect(ctx.wardId).toBe("242"); // default from wardIdForTenant('bula-pesa')
    expect(ctx.name).toBeNull();
  });

  it("resolves from Supabase via api_call_context when present", async () => {
    fx.supabase.callContext = {
      pastoralist_id: "pid-42",
      full_name: "Mohamed Ali",
      phone_number: "+254712000004",
      preferred_language: "sw",
      ward_id: "242",
      ward_name: "Bulla Pesa",
      ndvi_mean: 0.25272,
      ndre_mean: null,
      vci_value: 42,
      prosopis_share: null,
      rainfall_mm_30d: 12.5,
      humidity_pct: 30,
      temperature_c: 29.5,
      evapotranspiration_mm: 6.2,
      weather_observed_date: "2026-07-08",
      satellite_period_end: "2026-06-30",
    };

    const { resolveHerderContext } = await import(
      "../src/lib/herderContext.js"
    );
    const ctx = await resolveHerderContext("+254712000004", "bula-pesa");

    expect(ctx.source).toBe("supabase");
    expect(ctx.known).toBe(true);
    expect(ctx.name).toBe("Mohamed Ali");
    expect(ctx.wardId).toBe("242");
    expect(ctx.wardName).toBe("Bulla Pesa");
    expect(ctx.wardNdviMean).toBe(0.25272);
    expect(ctx.wardTemperatureC).toBe(29.5);
  });

  it("enriches Supabase-known herder with local species breakdown", async () => {
    fx.supabase.callContext = {
      pastoralist_id: "pid-42",
      full_name: "Mohamed Ali",
      phone_number: "+254712000004",
      preferred_language: "sw",
      ward_id: "242",
      ward_name: "Bulla Pesa",
      ndvi_mean: 0.25,
      ndre_mean: null,
      vci_value: null,
      prosopis_share: null,
      rainfall_mm_30d: null,
      humidity_pct: null,
      temperature_c: null,
      evapotranspiration_mm: null,
      weather_observed_date: null,
      satellite_period_end: null,
    };
    fx.local.pastoralist = {
      name: "Mohamed Ali",
      location: "Bulla Pesa town",
      cattle: 60,
      goats: 40,
      camels: 0,
      waterSource: "Bulla Pesa dam",
      lastContactAt: new Date("2026-07-07T12:00:00Z"),
    };
    fx.local.lastReport = {
      bcsScore: 2.7,
      bcsSpecies: "cattle",
      actionTag: "livestock_stress",
      reportedLocation: "Bulla Pesa",
      reportedQuadrant: "SW",
      createdAt: new Date("2026-06-22T01:11:17Z"),
    };

    const { resolveHerderContext } = await import(
      "../src/lib/herderContext.js"
    );
    const ctx = await resolveHerderContext("+254712000004", "bula-pesa");

    expect(ctx.source).toBe("supabase");
    // Species breakdown comes from local (Supabase has only herd_size).
    expect(ctx.cattle).toBe(60);
    expect(ctx.goats).toBe(40);
    expect(ctx.waterSource).toBe("Bulla Pesa dam");
    // Last report detail comes from local ground_truth_reports.
    expect(ctx.lastBcsScore).toBe(2.7);
    expect(ctx.lastBcsSpecies).toBe("cattle");
    expect(ctx.lastActionTag).toBe("livestock_stress");
  });

  it("falls back to local-only when Supabase has no match", async () => {
    fx.supabase.callContext = null;
    fx.supabase.pastoralist = null;
    fx.local.pastoralist = {
      name: "Yusuf Omar",
      location: "Ngare Mara",
      cattle: 30,
      goats: 25,
      camels: 5,
      waterSource: "Ngare Mara spring",
      lastContactAt: null,
    };

    const { resolveHerderContext } = await import(
      "../src/lib/herderContext.js"
    );
    const ctx = await resolveHerderContext("+254722000001", "ngare-mara");

    expect(ctx.source).toBe("local");
    expect(ctx.known).toBe(true);
    expect(ctx.name).toBe("Yusuf Omar");
    expect(ctx.wardId).toBe("245"); // ngare-mara -> 245
  });

  it("skips Supabase entirely when isSupabaseConfigured() is false", async () => {
    fx.supabase.configured = false;
    // Even if callContext is set (shouldn't be called), the local
    // path is taken. Prove it by leaving Supabase with data but
    // isSupabaseConfigured=false.
    fx.supabase.callContext = { pastoralist_id: "leaked" };
    fx.local.pastoralist = {
      name: "Local only",
      location: "Ngare Mara",
      cattle: 5,
      goats: 3,
      camels: 0,
      waterSource: "none",
      lastContactAt: null,
    };

    const { resolveHerderContext } = await import(
      "../src/lib/herderContext.js"
    );
    const ctx = await resolveHerderContext("+254700000001", "ngare-mara");

    expect(ctx.source).toBe("local");
    expect(ctx.name).toBe("Local only");
  });

  it("overlays ward reference data from Supabase when the local path resolves the herder", async () => {
    // Local knows the herder; Supabase doesn't. But Supabase HAS the
    // ward's latest satellite + weather, and we still expect those to
    // overlay the base context.
    fx.local.pastoralist = {
      name: "Amina Yusuf",
      location: "Gotu",
      cattle: 18,
      goats: 8,
      camels: 0,
      waterSource: "Gotu pan",
      lastContactAt: null,
    };
    fx.supabase.latestSatellite = {
      ward_id: "242",
      ndvi_mean: 0.19,
      vci_value: 30,
    };
    fx.supabase.latestWeather = {
      ward_id: "242",
      rainfall_mm_30d: 8,
      humidity_pct: 42,
      temperature_c: 27.1,
      evapotranspiration_mm: 5.5,
    };

    const { resolveHerderContext } = await import(
      "../src/lib/herderContext.js"
    );
    const ctx = await resolveHerderContext("+254712000003", "bula-pesa");

    expect(ctx.source).toBe("local");
    expect(ctx.wardNdviMean).toBe(0.19);
    expect(ctx.wardVci).toBe(30);
    expect(ctx.wardTemperatureC).toBe(27.1);
    expect(ctx.wardRainfall30dMm).toBe(8);
  });

  it("handles empty phone gracefully (returns base context)", async () => {
    const { resolveHerderContext } = await import(
      "../src/lib/herderContext.js"
    );
    const ctx = await resolveHerderContext("", "bula-pesa");
    expect(ctx.known).toBe(false);
    expect(ctx.source).toBe("none");
    expect(ctx.canonicalPhone).toBe("");
  });

  it("overlays best-neighbor advice when a neighbor NDVI is meaningfully higher", async () => {
    // Local herder resolution; overlay populates NDVI; neighbor
    // overlay adds the best-beating adjacent ward.
    fx.local.pastoralist = {
      name: "Yusuf Omar",
      location: "Bulla Pesa",
      cattle: 30,
      goats: 25,
      camels: 0,
      waterSource: "Bula Pesa borehole",
      lastContactAt: null,
    };
    fx.supabase.latestSatellite = { ward_id: "242", ndvi_mean: 0.19 };
    fx.supabase.neighborAdvice = {
      wardId: "241",
      wardName: "Wabera",
      ndviMean: 0.32,
      ndviDelta: 0.13,
      sharedBoundaryKm: 8,
    };

    const { resolveHerderContext, buildLocalizedVoiceOpener } = await import(
      "../src/lib/herderContext.js"
    );
    const ctx = await resolveHerderContext("+254712000001", "bula-pesa");

    expect(ctx.neighborWardName).toBe("Wabera");
    expect(ctx.neighborNdviMean).toBeCloseTo(0.32);
    expect(ctx.neighborNdviDelta).toBeCloseTo(0.13);

    const opener = buildLocalizedVoiceOpener(ctx);
    expect(opener).toContain("Wabera");
    expect(opener).toContain("consider moving");
  });
});
