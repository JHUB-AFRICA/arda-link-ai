import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The Supabase client reads env at call time. Set both vars so
// `isSupabaseConfigured()` and `cfg()` don't short-circuit.
const ENV_URL = "https://project-ref.supabase.co";
const ENV_KEY = "sb_secret_test_key";

beforeEach(() => {
  process.env.SUPABASE_URL = ENV_URL;
  process.env.SUPABASE_SECRET_KEY = ENV_KEY;
  process.env.SUPABASE_TIMEOUT_INTERACTIVE_MS = "2500";
  process.env.SUPABASE_TIMEOUT_BATCH_MS = "8000";
});

afterEach(async () => {
  vi.restoreAllMocks();
  // Purge the in-process cache so each test starts fresh.
  const { clearSupabaseCache } = await import("../src/lib/supabase.js");
  clearSupabaseCache();
});

interface FetchMockCall {
  url: string;
  init?: RequestInit;
}

function makeFetchMock(responses: Array<() => Response>) {
  const calls: FetchMockCall[] = [];
  let i = 0;
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const factory = responses[i] ?? responses[responses.length - 1];
    i++;
    return factory();
  });
  // Cast to the global's shape without pulling in DOM lib types.
  globalThis.fetch = fn as unknown as typeof fetch;
  return { fn, calls };
}

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("supabase client", () => {
  it("isSupabaseConfigured reads both env vars", async () => {
    const { isSupabaseConfigured } = await import("../src/lib/supabase.js");
    expect(isSupabaseConfigured()).toBe(true);

    delete process.env.SUPABASE_URL;
    expect(isSupabaseConfigured()).toBe(false);

    process.env.SUPABASE_URL = ENV_URL;
    delete process.env.SUPABASE_SECRET_KEY;
    expect(isSupabaseConfigured()).toBe(false);
  });

  it("cached reads memoise the response within TTL (one fetch for two reads)", async () => {
    const { fn } = makeFetchMock([
      () => jsonRes([{ ward_id: "242", name: "Bulla Pesa" }]),
    ]);

    const { listActiveWards } = await import("../src/lib/supabase.js");
    const first = await listActiveWards();
    const second = await listActiveWards();

    expect(first).toEqual([{ ward_id: "242", name: "Bulla Pesa" }]);
    expect(second).toEqual(first);
    // Only one physical HTTP round-trip despite two calls.
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("returns null on non-2xx and never throws", async () => {
    makeFetchMock([() => jsonRes({ error: "internal" }, 500)]);
    const { listWards } = await import("../src/lib/supabase.js");
    const rows = await listWards();
    expect(rows).toBeNull();
  });

  it("returns null on network failure and never throws", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    const { latestSatelliteFor } = await import("../src/lib/supabase.js");
    const sat = await latestSatelliteFor("242");
    expect(sat).toBeNull();
  });

  it("honours interactive mode by default on herder-facing reads", async () => {
    // AbortSignal.timeout is what triggers the deadline. We spy on it
    // to observe which timeout was requested for the first call.
    const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
    const timeoutSpy = vi.fn((ms: number) => originalTimeout(ms));
    (AbortSignal as unknown as { timeout: typeof timeoutSpy }).timeout =
      timeoutSpy;

    try {
      makeFetchMock([() => jsonRes([{ pastoralist_id: "abc" }])]);

      const { pastoralistByPhone } = await import("../src/lib/supabase.js");
      await pastoralistByPhone("+254712000004");

      expect(timeoutSpy).toHaveBeenCalled();
      expect(timeoutSpy).toHaveBeenCalledWith(2500);
    } finally {
      (AbortSignal as unknown as { timeout: typeof originalTimeout }).timeout =
        originalTimeout;
    }
  });

  it("honours batch mode on the ground_truth_calls writer", async () => {
    const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
    const timeoutSpy = vi.fn((ms: number) => originalTimeout(ms));
    (AbortSignal as unknown as { timeout: typeof timeoutSpy }).timeout =
      timeoutSpy;

    try {
      makeFetchMock([() => jsonRes([{ call_id: "uuid-1" }])]);

      const { insertGroundTruthCall } = await import("../src/lib/supabase.js");
      await insertGroundTruthCall({ ward_id: "242", bcs_score: 3 });

      // The writer runs after the AT XML response has been sent — a
      // longer timeout is intentional.
      expect(timeoutSpy).toHaveBeenCalledWith(8000);
    } finally {
      (AbortSignal as unknown as { timeout: typeof originalTimeout }).timeout =
        originalTimeout;
    }
  });

  it("upsertPastoralist uses Prefer: resolution=merge-duplicates", async () => {
    const { calls } = makeFetchMock([
      () => jsonRes([{ pastoralist_id: "abc", phone_number: "+254712" }]),
    ]);

    const { upsertPastoralist } = await import("../src/lib/supabase.js");
    const row = await upsertPastoralist({
      phone_number: "+254712000004",
      full_name: "Mohamed Ali",
    });

    expect(row).toEqual({ pastoralist_id: "abc", phone_number: "+254712" });
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers["Prefer"]).toContain("resolution=merge-duplicates");
    expect(headers["Prefer"]).toContain("return=representation");
  });

  it("insertGroundTruthCall returns null on non-2xx (local backup is authoritative)", async () => {
    makeFetchMock([() => jsonRes({ code: "23514" }, 400)]);

    const { insertGroundTruthCall } = await import("../src/lib/supabase.js");
    const result = await insertGroundTruthCall({
      ward_id: "242",
      bcs_score: 2.5,
    });
    expect(result).toBeNull();
  });

  it("hits the right URL path shape", async () => {
    const { calls } = makeFetchMock([() => jsonRes([])]);

    const { listWardNeighbors } = await import("../src/lib/supabase.js");
    await listWardNeighbors("242");

    expect(calls[0]?.url).toContain(
      "/rest/v1/ward_neighbors?ward_id=eq.242",
    );
    expect(calls[0]?.url).toContain(ENV_URL);
  });

  it("attaches apikey + Bearer on every request", async () => {
    const { calls } = makeFetchMock([() => jsonRes([])]);

    const { listWards } = await import("../src/lib/supabase.js");
    await listWards();

    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers.apikey).toBe(ENV_KEY);
    expect(headers.Authorization).toBe(`Bearer ${ENV_KEY}`);
  });

  // ── Cell-level helpers ───────────────────────────────────────────────

  it("listWardCells hits ward_cells with ward filter", async () => {
    const { calls } = makeFetchMock([() => jsonRes([])]);
    const { listWardCells } = await import("../src/lib/supabase.js");
    await listWardCells("246");
    expect(calls[0]?.url).toContain("/rest/v1/ward_cells?");
    expect(calls[0]?.url).toContain("ward_id=eq.246");
  });

  it("latestCellSnapshot returns first row of satellite_cell_indices (base table, no view)", async () => {
    const { calls } = makeFetchMock([
      () =>
        jsonRes([
          {
            ward_cell_id: "246_1000_1_1",
            ward_id: "246",
            ndvi_mean: 0.31,
            ndvi_anomaly: -0.05,
          },
        ]),
    ]);
    const { latestCellSnapshot } = await import("../src/lib/supabase.js");
    const row = await latestCellSnapshot("246_1000_1_1");
    expect(row?.ndvi_mean).toBe(0.31);
    expect(row?.ndvi_anomaly).toBe(-0.05);
    // Must hit the base table, not the broken view.
    expect(calls[0]?.url).toContain("/rest/v1/satellite_cell_indices?");
    expect(calls[0]?.url).not.toContain("api_latest_cell_satellite_indices");
  });

  it("latestCellIndicesForWard first fetches period_end, then paginates the base table", async () => {
    const { calls } = makeFetchMock([
      // Step 1: latest period_end lookup
      () => jsonRes([{ period_end: "2026-06-30" }]),
      // Step 2: page 1 (returns < 1000 rows so no page 2 fires)
      () =>
        jsonRes([
          { ward_cell_id: "246_a", ward_id: "246", period_end: "2026-06-30", ndvi_mean: 0.31 },
          { ward_cell_id: "246_b", ward_id: "246", period_end: "2026-06-30", ndvi_mean: 0.28 },
        ]),
    ]);
    const { latestCellIndicesForWard } = await import("../src/lib/supabase.js");
    const rows = await latestCellIndicesForWard("246");
    expect(rows).toHaveLength(2);
    // Step 1 URL — period_end lookup on the base table
    expect(calls[0]?.url).toContain("satellite_cell_indices?");
    expect(calls[0]?.url).toContain("period_end&order=period_end.desc&limit=1");
    // Step 2 URL — full-period fetch scoped by period_end + Range header
    expect(calls[1]?.url).toContain("period_end=eq.2026-06-30");
    const rangeHdr = (calls[1]?.init?.headers as Record<string, string>)["Range"];
    expect(rangeHdr).toBe("0-999");
    // The broken view must never be hit
    for (const c of calls) {
      expect(c.url).not.toContain("api_latest_cell_satellite_indices");
    }
  });

  it("latestCellIndicesForWard returns empty when the ward has no cell history", async () => {
    makeFetchMock([() => jsonRes([])]);
    const { latestCellIndicesForWard } = await import("../src/lib/supabase.js");
    const rows = await latestCellIndicesForWard("999");
    expect(rows).toEqual([]);
  });

  it("nearestCellForCoordinates picks closest centroid via haversine", async () => {
    makeFetchMock([
      () =>
        jsonRes([
          {
            ward_cell_id: "246_1000_far",
            ward_id: "246",
            cell_i: 0,
            cell_j: 0,
            cell_size_m: 1000,
            area_ha: 100,
            centroid: { type: "Point", coordinates: [37.9, 0.9] },
          },
          {
            ward_cell_id: "246_1000_near",
            ward_id: "246",
            cell_i: 1,
            cell_j: 1,
            cell_size_m: 1000,
            area_ha: 100,
            centroid: { type: "Point", coordinates: [37.4785, 0.4375] },
          },
        ]),
    ]);
    const { nearestCellForCoordinates } = await import("../src/lib/supabase.js");
    const cell = await nearestCellForCoordinates(0.4375, 37.4785, "246");
    expect(cell?.ward_cell_id).toBe("246_1000_near");
  });

  it("nearestCellForCoordinates returns null when ward has no cells", async () => {
    makeFetchMock([() => jsonRes([])]);
    const { nearestCellForCoordinates } = await import("../src/lib/supabase.js");
    const cell = await nearestCellForCoordinates(0.4375, 37.4785, "999");
    expect(cell).toBeNull();
  });

  it("wardCellStressSummary aggregates min/max/median and stressed count", async () => {
    makeFetchMock([
      () =>
        jsonRes([
          {
            ward_cell_id: "246_1", ward_id: "246", period_end: "2026-06-30",
            ndvi_mean: 0.10, vci_value: 10, ndvi_anomaly: -0.2,
          },
          {
            ward_cell_id: "246_2", ward_id: "246", period_end: "2026-06-30",
            ndvi_mean: 0.20, vci_value: 30, ndvi_anomaly: -0.1,
          },
          {
            ward_cell_id: "246_3", ward_id: "246", period_end: "2026-06-30",
            ndvi_mean: 0.40, vci_value: 60, ndvi_anomaly: 0.05,
          },
          {
            ward_cell_id: "246_4", ward_id: "246", period_end: "2026-06-30",
            ndvi_mean: null, vci_value: null, ndvi_anomaly: null,
          },
        ]),
    ]);
    const { wardCellStressSummary } = await import("../src/lib/supabase.js");
    const s = await wardCellStressSummary("246");
    expect(s?.cellCount).toBe(4);
    expect(s?.cellsWithData).toBe(3);
    expect(s?.stressedCellCount).toBe(2);
    expect(s?.ndviMin).toBe(0.10);
    expect(s?.ndviMax).toBe(0.40);
    expect(s?.ndviMedian).toBe(0.20);
    expect(s?.latestPeriodEnd).toBe("2026-06-30");
  });

  it("wardCellStressSummary returns null when Supabase is unreachable", async () => {
    makeFetchMock([() => jsonRes({}, 503)]);
    const { wardCellStressSummary } = await import("../src/lib/supabase.js");
    const s = await wardCellStressSummary("246");
    expect(s).toBeNull();
  });

  // ── RPC wrappers ─────────────────────────────────────────────────────

  it("refreshSatelliteIndicesLatest POSTs to /rpc/... with no args", async () => {
    const { calls } = makeFetchMock([
      () =>
        jsonRes({
          ok: true,
          run_id: "sync_20260715",
          upserted: 5,
          latest_period_end: "2026-06-30",
        }),
    ]);
    const { refreshSatelliteIndicesLatest } = await import("../src/lib/supabase.js");
    const result = await refreshSatelliteIndicesLatest();
    expect(result?.ok).toBe(true);
    expect(result?.upserted).toBe(5);
    expect(calls[0]?.url).toContain("/rest/v1/rpc/refresh_satellite_indices_latest");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(calls[0]?.init?.body).toBe("{}");
  });

  it("upsertWeatherData passes p_* args verbatim", async () => {
    const { calls } = makeFetchMock([() => jsonRes({ weather_data_id: 42 })]);
    const { upsertWeatherData } = await import("../src/lib/supabase.js");
    await upsertWeatherData({
      p_ward_id: "242",
      p_observed_date: "2026-06-30",
      p_rainfall_mm_30d: 12.5,
      p_humidity_pct: 55,
      p_temperature_c: 28.1,
      p_evapotranspiration_mm: 4.2,
      p_source: "open-meteo",
    });
    expect(calls[0]?.url).toContain("/rest/v1/rpc/upsert_weather_data");
    const body = JSON.parse(calls[0]?.init?.body as string);
    expect(body.p_ward_id).toBe("242");
    expect(body.p_rainfall_mm_30d).toBe(12.5);
    expect(body.p_source).toBe("open-meteo");
  });

  it("rebuildWardCells passes the cell size parameter", async () => {
    const { calls } = makeFetchMock([
      () => jsonRes({ ok: true, cell_size_m: 500, upserted: 100 }),
    ]);
    const { rebuildWardCells } = await import("../src/lib/supabase.js");
    await rebuildWardCells(500);
    const body = JSON.parse(calls[0]?.init?.body as string);
    expect(body.p_cell_size_m).toBe(500);
  });

  it("sbRpc returns null on non-2xx so callers can fall back", async () => {
    makeFetchMock([() => jsonRes({ code: "42883" }, 404)]);
    const { refreshSatelliteIndicesLatest } = await import("../src/lib/supabase.js");
    const result = await refreshSatelliteIndicesLatest();
    expect(result).toBeNull();
  });
});
