/**
 * Unit tests for the Supabase → local sync worker.
 *
 * Focus: the watermark-crawl contract and error-isolation guarantee.
 * Neither a real Supabase connection nor a live Postgres pool is
 * required — both are mocked via vi.doMock().
 *
 * Drizzle builder: same Proxy chain as localMirror.test.ts.
 * Supabase: sbQuery + isSupabaseConfigured are vi.doMock'd in-module.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Drizzle chain mock ─────────────────────────────────────────────────────

type Executor = () => Promise<unknown>;

function makeChain(executor: Executor) {
  const chain: unknown = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "then") {
          return (
            resolve: (v: unknown) => unknown,
            reject?: (e: unknown) => unknown,
          ) => executor().then(resolve, reject);
        }
        return () => chain;
      },
    },
  );
  return chain;
}

interface DbControl {
  selectResult: () => Promise<unknown>;
  insertResult: () => Promise<unknown>;
  updateResult: () => Promise<unknown>;
  setSelect: (fn: () => Promise<unknown>) => void;
  setInsert: (fn: () => Promise<unknown>) => void;
  setUpdate: (fn: () => Promise<unknown>) => void;
  reset: () => void;
}

function installDbMock(): DbControl {
  let selectFn: () => Promise<unknown> = () => Promise.resolve([]);
  let insertFn: () => Promise<unknown> = () => Promise.resolve(undefined);
  let updateFn: () => Promise<unknown> = () => Promise.resolve(undefined);

  vi.doMock("@workspace/db", () => ({
    db: {
      select: () => makeChain(() => selectFn()),
      insert: () => makeChain(() => insertFn()),
      update: () => makeChain(() => updateFn()),
    },
    pastoralistLeadsTable: {
      phoneNumber: "phone_number",
      updatedAt: "updated_at",
    },
    weatherDataTable: {
      wardId: "ward_id",
      observedDate: "observed_date",
      source: "source",
      updatedAt: "updated_at",
    },
  }));

  return {
    selectResult: () => selectFn(),
    insertResult: () => insertFn(),
    updateResult: () => updateFn(),
    setSelect: (fn) => {
      selectFn = fn;
    },
    setInsert: (fn) => {
      insertFn = fn;
    },
    setUpdate: (fn) => {
      updateFn = fn;
    },
    reset: () => {
      selectFn = () => Promise.resolve([]);
      insertFn = () => Promise.resolve(undefined);
      updateFn = () => Promise.resolve(undefined);
    },
  };
}

// ── Supabase mock ──────────────────────────────────────────────────────────

interface SbControl {
  setQueryResult: (rows: unknown[] | null) => void;
  setConfigured: (v: boolean) => void;
}

function installSbMock(
  initialRows: unknown[] | null = null,
  configured = true,
): SbControl {
  let queryResult: unknown[] | null = initialRows;
  let isConfigured = configured;

  vi.doMock("../src/lib/supabase/index.js", () => ({
    isSupabaseConfigured: () => isConfigured,
    sbQuery: () => Promise.resolve(queryResult),
  }));

  return {
    setQueryResult: (rows) => {
      queryResult = rows;
    },
    setConfigured: (v) => {
      isConfigured = v;
    },
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────

function makeLead(phone = "+254712000001", updatedAt = "2026-07-20T00:00:00Z") {
  return {
    lead_id: "abc-123",
    phone_number: phone,
    full_name: "Test Herder",
    preferred_language: "sw",
    ward_id: "242",
    herd_size: 30,
    enrollment_source: "ussd_self",
    status: "lead",
    alerts_enabled: true,
    first_contact_at: "2026-07-01T00:00:00Z",
    last_contact_at: "2026-07-20T00:00:00Z",
    verified_at: null,
    verified_by: null,
    promoted_pastoralist_id: null,
    notes: null,
    tenant_id: null,
    updated_at: updatedAt,
  };
}

function makeWeather(
  wardId = "242",
  date = "2026-07-20",
  updatedAt = "2026-07-20T06:00:00Z",
) {
  return {
    ward_id: wardId,
    observed_date: date,
    rainfall_mm_30d: 2.5,
    humidity_pct: 45,
    temperature_c: 28,
    evapotranspiration_mm: 4.1,
    source: "open-meteo",
    tenant_id: null,
    updated_at: updatedAt,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("syncJob — runSyncCycle", () => {
  let db: DbControl;
  let sb: SbControl;

  beforeEach(() => {
    vi.resetModules();
    db = installDbMock();
    sb = installSbMock();
  });

  afterEach(() => {
    vi.doUnmock("@workspace/db");
    vi.doUnmock("../src/lib/supabase/index.js");
    vi.restoreAllMocks();
  });

  it("returns zero counts when Supabase returns empty arrays", async () => {
    sb.setQueryResult([]);
    db.setSelect(() => Promise.resolve([]));
    const { runSyncCycle, resetSyncCacheForTest } = await import(
      "../src/jobs/syncJob.js"
    );
    resetSyncCacheForTest();
    const result = await runSyncCycle();
    expect(result.pastoralistLeads.pulled).toBe(0);
    expect(result.weatherData.pulled).toBe(0);
  });

  it("returns zero counts when Supabase returns null (network error)", async () => {
    sb.setQueryResult(null);
    db.setSelect(() => Promise.resolve([]));
    const { runSyncCycle, resetSyncCacheForTest } = await import(
      "../src/jobs/syncJob.js"
    );
    resetSyncCacheForTest();
    const result = await runSyncCycle();
    expect(result.pastoralistLeads.pulled).toBe(0);
    expect(result.weatherData.pulled).toBe(0);
    expect(result.pastoralistLeads.errors).toBe(0);
  });

  it("counts new lead as upserted (insert path)", async () => {
    const lead = makeLead();
    // sbQuery returns the lead; SELECT finds no existing phone → insert
    let callCount = 0;
    vi.doMock("../src/lib/supabase/index.js", () => ({
      isSupabaseConfigured: () => true,
      sbQuery: () =>
        Promise.resolve(callCount++ === 0 ? [lead] : []), // leads first, weather second
    }));
    db.setSelect(() => Promise.resolve([])); // no existing phones
    db.setInsert(() => Promise.resolve(undefined));

    const { runSyncCycle, resetSyncCacheForTest } = await import(
      "../src/jobs/syncJob.js"
    );
    resetSyncCacheForTest();
    const result = await runSyncCycle();
    expect(result.pastoralistLeads.pulled).toBe(1);
    expect(result.pastoralistLeads.upserted).toBe(1);
  });

  it("counts existing lead as upserted (update path)", async () => {
    const lead = makeLead();
    let callCount = 0;
    vi.doMock("../src/lib/supabase/index.js", () => ({
      isSupabaseConfigured: () => true,
      sbQuery: () =>
        Promise.resolve(callCount++ === 0 ? [lead] : []),
    }));
    // SELECT returns existing phone → update path
    db.setSelect(() =>
      Promise.resolve([{ phone: lead.phone_number }]),
    );
    db.setUpdate(() => Promise.resolve(undefined));

    const { runSyncCycle, resetSyncCacheForTest } = await import(
      "../src/jobs/syncJob.js"
    );
    resetSyncCacheForTest();
    const result = await runSyncCycle();
    expect(result.pastoralistLeads.pulled).toBe(1);
    expect(result.pastoralistLeads.upserted).toBe(1);
  });

  it("advances watermark to last row's updated_at after a successful leads pull", async () => {
    const lead1 = makeLead("+254712000001", "2026-07-20T00:00:00Z");
    const lead2 = makeLead("+254712000002", "2026-07-21T00:00:00Z");
    let callCount = 0;
    vi.doMock("../src/lib/supabase/index.js", () => ({
      isSupabaseConfigured: () => true,
      sbQuery: () =>
        Promise.resolve(callCount++ === 0 ? [lead1, lead2] : []),
    }));
    db.setSelect(() => Promise.resolve([]));

    const { runSyncCycle, resetSyncCacheForTest } = await import(
      "../src/jobs/syncJob.js"
    );
    resetSyncCacheForTest();
    const result = await runSyncCycle();
    expect(result.pastoralistLeads.newWatermark).toBe(
      "2026-07-21T00:00:00Z",
    );
  });

  it("upserts weather_data row via batch insert", async () => {
    const weather = makeWeather();
    let callCount = 0;
    vi.doMock("../src/lib/supabase/index.js", () => ({
      isSupabaseConfigured: () => true,
      sbQuery: () =>
        Promise.resolve(callCount++ === 0 ? [] : [weather]),
    }));
    db.setSelect(() => Promise.resolve([]));
    db.setInsert(() => Promise.resolve(undefined));

    const { runSyncCycle, resetSyncCacheForTest } = await import(
      "../src/jobs/syncJob.js"
    );
    resetSyncCacheForTest();
    const result = await runSyncCycle();
    expect(result.weatherData.pulled).toBe(1);
    expect(result.weatherData.upserted).toBe(1);
    expect(result.weatherData.newWatermark).toBe("2026-07-20T06:00:00Z");
  });

  it("swallows a lead UPDATE error and counts it as error", async () => {
    const lead = makeLead();
    let callCount = 0;
    vi.doMock("../src/lib/supabase/index.js", () => ({
      isSupabaseConfigured: () => true,
      sbQuery: () =>
        Promise.resolve(callCount++ === 0 ? [lead] : []),
    }));
    // Phone exists → update path; update rejects
    db.setSelect(() =>
      Promise.resolve([{ phone: lead.phone_number }]),
    );
    db.setUpdate(() => Promise.reject(new Error("constraint violation")));

    const { runSyncCycle, resetSyncCacheForTest } = await import(
      "../src/jobs/syncJob.js"
    );
    resetSyncCacheForTest();
    const result = await runSyncCycle();
    expect(result.pastoralistLeads.errors).toBe(1);
    expect(result.pastoralistLeads.upserted).toBe(0);
  });

  it("weather sync failure does not affect leads result", async () => {
    const lead = makeLead();
    let callCount = 0;
    vi.doMock("../src/lib/supabase/index.js", () => ({
      isSupabaseConfigured: () => true,
      sbQuery: () => {
        const n = callCount++;
        if (n === 0) return Promise.resolve([lead]);
        return Promise.reject(new Error("network error"));
      },
    }));
    db.setSelect(() => Promise.resolve([]));

    const { runSyncCycle, resetSyncCacheForTest } = await import(
      "../src/jobs/syncJob.js"
    );
    resetSyncCacheForTest();
    const result = await runSyncCycle();
    expect(result.pastoralistLeads.pulled).toBe(1);
    expect(result.weatherData.pulled).toBe(0);
  });

  it("caches last result in getLastSyncResult()", async () => {
    sb.setQueryResult([]);
    db.setSelect(() => Promise.resolve([]));
    const { runSyncCycle, getLastSyncResult, resetSyncCacheForTest } =
      await import("../src/jobs/syncJob.js");
    resetSyncCacheForTest();
    expect(getLastSyncResult()).toBeNull();
    await runSyncCycle();
    expect(getLastSyncResult()).not.toBeNull();
    expect(getLastSyncResult()?.pastoralistLeads).toBeDefined();
  });

  it("skips entirely when Supabase is not configured", async () => {
    let queryCalled = false;
    vi.doMock("../src/lib/supabase/index.js", () => ({
      isSupabaseConfigured: () => false,
      sbQuery: () => {
        queryCalled = true;
        return Promise.resolve([]);
      },
    }));
    db.setSelect(() => Promise.resolve([]));

    const { startSyncJob, stopSyncJob, resetSyncCacheForTest } = await import(
      "../src/jobs/syncJob.js"
    );
    resetSyncCacheForTest();
    startSyncJob();
    stopSyncJob();
    expect(queryCalled).toBe(false);
  });

  it("isSyncJobEnabled() returns false when env is 'false'", async () => {
    process.env.SYNC_JOB_ENABLED = "false";
    const { isSyncJobEnabled } = await import("../src/jobs/syncJob.js");
    expect(isSyncJobEnabled()).toBe(false);
    delete process.env.SYNC_JOB_ENABLED;
  });
});
