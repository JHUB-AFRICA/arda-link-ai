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
});
