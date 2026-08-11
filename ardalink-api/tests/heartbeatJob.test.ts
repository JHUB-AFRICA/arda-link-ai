/**
 * Unit tests for the heartbeat / staleness probe.
 *
 * Focus: threshold evaluation (fresh/stale/informational/unknown), the
 * writer-vs-herder role distinction (herder silence never degrades),
 * config-missing fallback, and the scheduler start/stop lifecycle. The
 * end-to-end fetch shape mirrors the vciBackfillJob test style.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const nowIso = () => new Date().toISOString();
const isoAgo = (ms: number) => new Date(Date.now() - ms).toISOString();

const HOUR_MS = 60 * 60 * 1000;

describe("Heartbeat — snapshot logic", () => {
  beforeEach(() => {
    process.env.SUPABASE_URL = "https://test.supabase.co";
    process.env.SUPABASE_SECRET_KEY = "test-key";
    delete process.env.HEARTBEAT_JOB_ENABLED;
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("marks fresh writer tables as healthy", async () => {
    const fresh = nowIso();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      return new Response(
        JSON.stringify([{ created_at: fresh, occurred_at: fresh }]),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    });
    const { runHeartbeat, resetHeartbeatCacheForTest } = await import(
      "../src/jobs/heartbeatJob.js"
    );
    resetHeartbeatCacheForTest();
    const snap = await runHeartbeat();
    expect(snap.status).toBe("healthy");
    expect(snap.tables.length).toBeGreaterThan(0);
    const writers = snap.tables.filter((t) => t.role === "writer-driven");
    expect(writers.every((t) => t.status === "fresh")).toBe(true);
  });

  it("marks a stale writer table as degraded", async () => {
    // 72h old is stale for every writer-driven threshold in the default set.
    const stale = isoAgo(72 * HOUR_MS);
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      return new Response(
        JSON.stringify([{ created_at: stale, occurred_at: stale }]),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    });
    const { runHeartbeat, resetHeartbeatCacheForTest } = await import(
      "../src/jobs/heartbeatJob.js"
    );
    resetHeartbeatCacheForTest();
    const snap = await runHeartbeat();
    expect(snap.status).toBe("degraded");
    const staleTables = snap.tables.filter((t) => t.status === "stale");
    expect(staleTables.length).toBeGreaterThan(0);
    expect(staleTables.every((t) => t.role === "writer-driven")).toBe(true);
  });

  it("herder-driven tables never cause degraded status when silent", async () => {
    const fresh = nowIso();
    const veryStale = isoAgo(30 * 24 * HOUR_MS);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const u = String(url);
      const isHerder =
        u.includes("lead_interactions") || u.includes("ground_truth_calls");
      const iso = isHerder ? veryStale : fresh;
      return new Response(
        JSON.stringify([{ created_at: iso, occurred_at: iso }]),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    });
    const { runHeartbeat, resetHeartbeatCacheForTest } = await import(
      "../src/jobs/heartbeatJob.js"
    );
    resetHeartbeatCacheForTest();
    const snap = await runHeartbeat();
    expect(snap.status).toBe("healthy");
    const herder = snap.tables.filter((t) => t.role === "herder-driven");
    expect(herder.length).toBeGreaterThan(0);
    expect(herder.every((t) => t.status === "informational")).toBe(true);
  });

  it("marks pipeline unknown when Supabase is not configured", async () => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SECRET_KEY;
    const { runHeartbeat, resetHeartbeatCacheForTest } = await import(
      "../src/jobs/heartbeatJob.js"
    );
    resetHeartbeatCacheForTest();
    const snap = await runHeartbeat();
    expect(snap.status).toBe("unknown");
    expect(snap.tables.every((t) => t.status === "unknown")).toBe(true);
  });

  it("marks a table as unknown when the probe returns non-2xx", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      return new Response(
        '{"code":"42703","message":"column does not exist"}',
        {
          status: 400,
          headers: { "content-type": "application/json" },
        },
      );
    });
    const { runHeartbeat, resetHeartbeatCacheForTest } = await import(
      "../src/jobs/heartbeatJob.js"
    );
    resetHeartbeatCacheForTest();
    const snap = await runHeartbeat();
    // Every writer probe failed → unknown overall.
    expect(snap.status).toBe("unknown");
    expect(snap.tables.every((t) => t.status === "unknown")).toBe(true);
  });

  it("empty writer-driven table is treated as stale", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      return new Response("[]", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const { runHeartbeat, resetHeartbeatCacheForTest } = await import(
      "../src/jobs/heartbeatJob.js"
    );
    resetHeartbeatCacheForTest();
    const snap = await runHeartbeat();
    expect(snap.status).toBe("degraded");
    const writers = snap.tables.filter((t) => t.role === "writer-driven");
    expect(writers.every((t) => t.status === "stale")).toBe(true);
    const herders = snap.tables.filter((t) => t.role === "herder-driven");
    expect(herders.every((t) => t.status === "informational")).toBe(true);
  });

  it("escalates an otherwise-healthy pipeline to degraded when a schema check fails", async () => {
    const fresh = nowIso();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes("water_point_name")) {
        return new Response(
          '{"code":"PGRST204","message":"Could not find the \'water_point_name\' column"}',
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify([{ created_at: fresh, occurred_at: fresh }]),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const { runHeartbeat, resetHeartbeatCacheForTest } = await import(
      "../src/jobs/heartbeatJob.js"
    );
    resetHeartbeatCacheForTest();
    const snap = await runHeartbeat();
    expect(snap.status).toBe("degraded");
    expect(snap.schemaChecks).toEqual([
      { table: "ground_truth_calls", column: "water_point_name", ok: false },
    ]);
  });

  it("reports schemaChecks ok and leaves status untouched when the column exists", async () => {
    const fresh = nowIso();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      return new Response(
        JSON.stringify([{ created_at: fresh, occurred_at: fresh, water_point_name: null }]),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const { runHeartbeat, resetHeartbeatCacheForTest } = await import(
      "../src/jobs/heartbeatJob.js"
    );
    resetHeartbeatCacheForTest();
    const snap = await runHeartbeat();
    expect(snap.status).toBe("healthy");
    expect(snap.schemaChecks.every((c) => c.ok)).toBe(true);
  });

  it("a schema mismatch never downgrades an already-degraded/unknown status label", async () => {
    // Every fetch (freshness AND schema) fails identically — mirrors the
    // existing "non-2xx" test's mock shape. The freshness verdict already
    // lands on "unknown" (all writers unknown); the schema failure must
    // not fight with that by forcing "degraded" instead.
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      return new Response('{"code":"42703","message":"column does not exist"}', {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    });
    const { runHeartbeat, resetHeartbeatCacheForTest } = await import(
      "../src/jobs/heartbeatJob.js"
    );
    resetHeartbeatCacheForTest();
    const snap = await runHeartbeat();
    expect(snap.status).toBe("unknown");
    expect(snap.schemaChecks.every((c) => !c.ok)).toBe(true);
  });

  it("getLastHeartbeat returns the cached snapshot after runHeartbeat", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      return new Response(
        JSON.stringify([{ created_at: nowIso(), occurred_at: nowIso() }]),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    });
    const { runHeartbeat, getLastHeartbeat, resetHeartbeatCacheForTest } =
      await import("../src/jobs/heartbeatJob.js");
    resetHeartbeatCacheForTest();
    expect(getLastHeartbeat()).toBeNull();
    const snap = await runHeartbeat();
    expect(getLastHeartbeat()).toEqual(snap);
  });
});

describe("Heartbeat — scheduler", () => {
  beforeEach(() => {
    delete process.env.HEARTBEAT_JOB_ENABLED;
    delete process.env.HEARTBEAT_INTERVAL_MS;
    process.env.SUPABASE_URL = "https://test.supabase.co";
    process.env.SUPABASE_SECRET_KEY = "test-key";
    vi.resetModules();
    // Silence the boot-run fetch so no real DNS attempts leak across
    // test files.
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response("[]", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is enabled by default", async () => {
    const { isHeartbeatJobEnabled, startHeartbeatJob, stopHeartbeatJob } =
      await import("../src/jobs/heartbeatJob.js");
    startHeartbeatJob();
    try {
      expect(isHeartbeatJobEnabled()).toBe(true);
    } finally {
      stopHeartbeatJob();
    }
  });

  it("can be disabled via env var", async () => {
    process.env.HEARTBEAT_JOB_ENABLED = "false";
    const { isHeartbeatJobEnabled, startHeartbeatJob, stopHeartbeatJob } =
      await import("../src/jobs/heartbeatJob.js");
    startHeartbeatJob();
    try {
      expect(isHeartbeatJobEnabled()).toBe(false);
    } finally {
      stopHeartbeatJob();
    }
  });

  it("start/stop clears the interval timer", async () => {
    process.env.HEARTBEAT_JOB_ENABLED = "false";
    const { startHeartbeatJob, stopHeartbeatJob } = await import(
      "../src/jobs/heartbeatJob.js"
    );
    startHeartbeatJob();
    stopHeartbeatJob();
    expect(() => stopHeartbeatJob()).not.toThrow();
  });
});

describe("Heartbeat — jobs registry re-export", () => {
  it("jobs/index.js re-exports the heartbeat surface", async () => {
    const jobs = await import("../src/jobs/index.js");
    expect(typeof jobs.runHeartbeat).toBe("function");
    expect(typeof jobs.startHeartbeatJob).toBe("function");
    expect(typeof jobs.stopHeartbeatJob).toBe("function");
    expect(typeof jobs.isHeartbeatJobEnabled).toBe("function");
    expect(typeof jobs.getLastHeartbeat).toBe("function");
    expect(Array.isArray(jobs.DEFAULT_CHECKS)).toBe(true);
    expect(Array.isArray(jobs.DEFAULT_SCHEMA_CHECKS)).toBe(true);
  });
});
