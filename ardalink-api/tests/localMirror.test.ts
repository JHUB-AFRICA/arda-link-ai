/**
 * Unit tests for local-Postgres mirror writes.
 *
 * Focus: the "never throws" contract — every mirror function must
 * swallow a downstream db error and log-warn instead. Callers rely on
 * this so a herder-facing route (USSD reply, SMS reply, voice opener)
 * continues even if the local pool is unreachable.
 *
 * Drizzle's chained builder is mocked with a thenable that either
 * resolves undefined (happy) or rejects (failure). We don't verify
 * the exact SQL — that's schema-level, covered by the drizzle types
 * + the integration tests in tests/integration/.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Chain builder that yields to whatever executor the caller wires. */
function makeChain(executor: () => Promise<unknown>) {
  const chain: unknown = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === "then") {
          return (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
            executor().then(resolve, reject);
        }
        // Any other property returns a function that returns the same
        // chain — supports .from().where().limit(), .values().onConflictDoUpdate(),
        // .set(), etc.
        return () => chain;
      },
    },
  );
  return chain;
}

interface DbSpies {
  selectResolves: (value: unknown) => void;
  selectRejects: (err: unknown) => void;
  insertResolves: () => void;
  insertRejects: (err: unknown) => void;
  updateResolves: () => void;
  updateRejects: (err: unknown) => void;
  reset: () => void;
}

function installDbMock(): DbSpies {
  let selectResult: () => Promise<unknown> = () => Promise.resolve([]);
  let insertResult: () => Promise<unknown> = () => Promise.resolve(undefined);
  let updateResult: () => Promise<unknown> = () => Promise.resolve(undefined);

  vi.doMock("@workspace/db", () => ({
    db: {
      select: () => makeChain(selectResult),
      insert: () => makeChain(insertResult),
      update: () => makeChain(updateResult),
    },
    pastoralistLeadsTable: { phoneNumber: "phone_number", leadId: "lead_id" },
    leadInteractionsTable: {},
    weatherDataTable: {
      wardId: "ward_id",
      observedDate: "observed_date",
      source: "source",
    },
    weatherForecastTable: {},
  }));

  return {
    selectResolves: (v) => {
      selectResult = () => Promise.resolve(v);
    },
    selectRejects: (e) => {
      selectResult = () => Promise.reject(e);
    },
    insertResolves: () => {
      insertResult = () => Promise.resolve(undefined);
    },
    insertRejects: (e) => {
      insertResult = () => Promise.reject(e);
    },
    updateResolves: () => {
      updateResult = () => Promise.resolve(undefined);
    },
    updateRejects: (e) => {
      updateResult = () => Promise.reject(e);
    },
    reset: () => {
      selectResult = () => Promise.resolve([]);
      insertResult = () => Promise.resolve(undefined);
      updateResult = () => Promise.resolve(undefined);
    },
  };
}

describe("localMirror — never-throws contract", () => {
  let spies: DbSpies;

  beforeEach(() => {
    vi.resetModules();
    spies = installDbMock();
  });

  afterEach(() => {
    vi.doUnmock("@workspace/db");
    vi.restoreAllMocks();
  });

  it("mirrorPastoralistLead completes when SELECT returns empty (insert path)", async () => {
    spies.selectResolves([]);
    spies.insertResolves();
    const { mirrorPastoralistLead } = await import("../src/lib/localMirror.js");
    await expect(
      mirrorPastoralistLead({
        phoneNumber: "+254712000004",
        enrollmentSource: "ussd_self",
      }),
    ).resolves.toBeUndefined();
  });

  it("mirrorPastoralistLead completes when SELECT returns rows (update path)", async () => {
    spies.selectResolves([{ leadId: "abc-123" }]);
    spies.updateResolves();
    const { mirrorPastoralistLead } = await import("../src/lib/localMirror.js");
    await expect(
      mirrorPastoralistLead({
        phoneNumber: "+254712000004",
        alertsEnabled: false,
      }),
    ).resolves.toBeUndefined();
  });

  it("mirrorPastoralistLead swallows a SELECT error", async () => {
    spies.selectRejects(new Error("pool closed"));
    const { mirrorPastoralistLead } = await import("../src/lib/localMirror.js");
    await expect(
      mirrorPastoralistLead({ phoneNumber: "+254712000004" }),
    ).resolves.toBeUndefined();
  });

  it("mirrorPastoralistLead swallows an INSERT error", async () => {
    spies.selectResolves([]);
    spies.insertRejects(new Error("connection refused"));
    const { mirrorPastoralistLead } = await import("../src/lib/localMirror.js");
    await expect(
      mirrorPastoralistLead({ phoneNumber: "+254712000004" }),
    ).resolves.toBeUndefined();
  });

  it("mirrorLeadInteraction completes on happy INSERT", async () => {
    spies.insertResolves();
    const { mirrorLeadInteraction } = await import("../src/lib/localMirror.js");
    await expect(
      mirrorLeadInteraction({
        phoneNumber: "+254712000004",
        channel: "ussd",
        tier: "lead",
        keyword: "MALISHO",
      }),
    ).resolves.toBeUndefined();
  });

  it("mirrorLeadInteraction swallows an INSERT error", async () => {
    spies.insertRejects(new Error("relation does not exist"));
    const { mirrorLeadInteraction } = await import("../src/lib/localMirror.js");
    await expect(
      mirrorLeadInteraction({
        phoneNumber: "+254712000004",
        channel: "voice",
      }),
    ).resolves.toBeUndefined();
  });

  it("mirrorWeatherData completes on happy upsert", async () => {
    spies.insertResolves();
    const { mirrorWeatherData } = await import("../src/lib/localMirror.js");
    await expect(
      mirrorWeatherData({
        wardId: "242",
        observedDate: "2026-07-24",
        rainfallMm30d: "2.5",
        source: "open-meteo",
      }),
    ).resolves.toBeUndefined();
  });

  it("mirrorWeatherData swallows an upsert error", async () => {
    spies.insertRejects(new Error("unique violation"));
    const { mirrorWeatherData } = await import("../src/lib/localMirror.js");
    await expect(
      mirrorWeatherData({
        wardId: "242",
        observedDate: "2026-07-24",
        source: "open-meteo",
      }),
    ).resolves.toBeUndefined();
  });

  it("mirrorWeatherForecastBatch short-circuits on empty array (no db touch)", async () => {
    // If this touched db.insert we'd see the rejection propagate.
    spies.insertRejects(new Error("must not be called"));
    const { mirrorWeatherForecastBatch } = await import(
      "../src/lib/localMirror.js"
    );
    await expect(mirrorWeatherForecastBatch([])).resolves.toBeUndefined();
  });

  it("mirrorWeatherForecastBatch completes on happy INSERT with rows", async () => {
    spies.insertResolves();
    const { mirrorWeatherForecastBatch } = await import(
      "../src/lib/localMirror.js"
    );
    await expect(
      mirrorWeatherForecastBatch([
        {
          wardId: "242",
          targetDate: "2026-08-01",
          horizonDays: 8,
          rainfallMmP50: "1.2",
          source: "open-meteo",
        },
      ]),
    ).resolves.toBeUndefined();
  });

  it("mirrorWeatherForecastBatch swallows an INSERT error", async () => {
    spies.insertRejects(new Error("connection refused"));
    const { mirrorWeatherForecastBatch } = await import(
      "../src/lib/localMirror.js"
    );
    await expect(
      mirrorWeatherForecastBatch([
        {
          wardId: "242",
          targetDate: "2026-08-01",
          source: "open-meteo",
        },
      ]),
    ).resolves.toBeUndefined();
  });
});
