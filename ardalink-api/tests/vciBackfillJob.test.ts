/**
 * Unit tests for the VCI backfill job.
 *
 * Focus: the ward-filter (default = canonical 5 wards only), URL
 * shape (in.(...)), and the scheduler start/stop lifecycle. The
 * end-to-end PATCH + baseline lookup is exercised elsewhere via the
 * ops route; these tests keep fast/deterministic coverage of the
 * new scope-limiting behaviour.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const CANONICAL_WARDS = ["241", "242", "245", "246", "247"];

describe("VCI backfill — ward filter", () => {
  let fetchSpy: { mockRestore: () => void };
  const seenUrls: string[] = [];

  beforeEach(() => {
    seenUrls.length = 0;
    // Ensure Supabase-configured guard passes.
    process.env.SUPABASE_URL = "https://test.supabase.co";
    process.env.SUPABASE_SECRET_KEY = "test-key";

    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      seenUrls.push(String(url));
      // First page returns empty so the loop exits after one iteration.
      return new Response("[]", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("default scope filters to the 5 canonical wards", async () => {
    const { runVciBackfill } = await import("../src/jobs/vciBackfillJob.js");
    await runVciBackfill();
    expect(seenUrls.length).toBeGreaterThan(0);
    const first = seenUrls[0];
    // The IN clause has to contain every canonical ward.
    for (const w of CANONICAL_WARDS) {
      expect(first).toContain(w);
    }
    // And nothing else — the URL contains `ward_id=in.(...)`
    expect(first).toMatch(/ward_id=in\.\([^)]+\)/);
  });

  it("explicit wardIds override the default filter", async () => {
    const { runVciBackfill } = await import("../src/jobs/vciBackfillJob.js");
    await runVciBackfill({ wardIds: ["242"] });
    expect(seenUrls[0]).toMatch(/ward_id=in\.\(242\)/);
  });

  it("wardIds=[] (empty) disables the filter", async () => {
    const { runVciBackfill } = await import("../src/jobs/vciBackfillJob.js");
    await runVciBackfill({ wardIds: [] });
    expect(seenUrls[0]).not.toContain("ward_id=in.");
  });

  it("returns zeroed counters when there is nothing to backfill", async () => {
    const { runVciBackfill } = await import("../src/jobs/vciBackfillJob.js");
    const result = await runVciBackfill();
    expect(result.scanned).toBe(0);
    expect(result.updated).toBe(0);
    expect(result.errors).toBe(0);
  });
});

describe("VCI backfill — scheduler", () => {
  let fetchSpy: { mockRestore: () => void };

  beforeEach(() => {
    delete process.env.VCI_BACKFILL_JOB_ENABLED;
    delete process.env.VCI_BACKFILL_INTERVAL_MS;
    process.env.SUPABASE_URL = "https://test.supabase.co";
    process.env.SUPABASE_SECRET_KEY = "test-key";
    // Mock fetch so start's synchronous kick-off doesn't queue real DNS
    // requests that hang and cross-contaminate other test files.
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response("[]", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("is enabled by default", async () => {
    const { isVciBackfillJobEnabled, stopVciBackfillJob, startVciBackfillJob } =
      await import("../src/jobs/vciBackfillJob.js");
    startVciBackfillJob();
    try {
      expect(isVciBackfillJobEnabled()).toBe(true);
    } finally {
      stopVciBackfillJob();
    }
  });

  it("can be disabled via env var", async () => {
    process.env.VCI_BACKFILL_JOB_ENABLED = "false";
    const { isVciBackfillJobEnabled, stopVciBackfillJob, startVciBackfillJob } =
      await import("../src/jobs/vciBackfillJob.js");
    startVciBackfillJob();
    try {
      expect(isVciBackfillJobEnabled()).toBe(false);
    } finally {
      stopVciBackfillJob();
    }
  });

  it("start/stop clears the interval timer", async () => {
    // Disable so the boot run doesn't fire even mocked fetches.
    process.env.VCI_BACKFILL_JOB_ENABLED = "false";
    const { startVciBackfillJob, stopVciBackfillJob } = await import(
      "../src/jobs/vciBackfillJob.js"
    );
    startVciBackfillJob();
    stopVciBackfillJob();
    // Second stop is a no-op.
    expect(() => stopVciBackfillJob()).not.toThrow();
  });
});

describe("VCI backfill — jobs registry re-export", () => {
  it("jobs/index.js re-exports the VCI backfill surface", async () => {
    const jobs = await import("../src/jobs/index.js");
    expect(typeof jobs.runVciBackfill).toBe("function");
    expect(typeof jobs.startVciBackfillJob).toBe("function");
    expect(typeof jobs.stopVciBackfillJob).toBe("function");
    expect(typeof jobs.isVciBackfillJobEnabled).toBe("function");
  });
});
