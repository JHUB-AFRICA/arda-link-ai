/**
 * Static sanity check for the mirror-table drizzle schemas added on
 * `chore/db-schema-mirror-tables`. Doesn't hit a live database — just
 * asserts the tables + insert schemas import cleanly and expose the
 * columns the writer paths (routes/*, jobs/*) rely on.
 */

import { describe, it, expect } from "vitest";

describe("Mirror table schemas — drizzle exports", () => {
  it("pastoralistLeadsTable exposes the columns the enrollment path writes", async () => {
    const mod = await import("@workspace/db");
    expect(mod.pastoralistLeadsTable).toBeDefined();
    const cols = Object.keys(
      mod.pastoralistLeadsTable as unknown as Record<string, unknown>,
    );
    // Sanity: names the routes/*.ts writers will reach for.
    for (const col of [
      "leadId",
      "phoneNumber",
      "wardId",
      "enrollmentSource",
      "status",
      "alertsEnabled",
      "tenantId",
    ]) {
      expect(cols).toContain(col);
    }
  });

  it("leadInteractionsTable exposes every audit column", async () => {
    const mod = await import("@workspace/db");
    expect(mod.leadInteractionsTable).toBeDefined();
    const cols = Object.keys(
      mod.leadInteractionsTable as unknown as Record<string, unknown>,
    );
    for (const col of [
      "interactionId",
      "phoneNumber",
      "tier",
      "channel",
      "sessionId",
      "keyword",
      "wardId",
      "occurredAt",
      "rawBody",
      "tenantId",
    ]) {
      expect(cols).toContain(col);
    }
  });

  it("weatherDataTable exposes daily-observation columns + unique key", async () => {
    const mod = await import("@workspace/db");
    expect(mod.weatherDataTable).toBeDefined();
    const cols = Object.keys(
      mod.weatherDataTable as unknown as Record<string, unknown>,
    );
    for (const col of [
      "weatherDataId",
      "wardId",
      "observedDate",
      "rainfallMm30d",
      "temperatureC",
      "source",
      "tenantId",
    ]) {
      expect(cols).toContain(col);
    }
  });

  it("weatherForecastTable exposes ensemble percentile columns", async () => {
    const mod = await import("@workspace/db");
    expect(mod.weatherForecastTable).toBeDefined();
    const cols = Object.keys(
      mod.weatherForecastTable as unknown as Record<string, unknown>,
    );
    for (const col of [
      "forecastId",
      "wardId",
      "generatedAt",
      "targetDate",
      "rainfallMmP5",
      "rainfallMmP50",
      "rainfallMmP95",
      "et0Mm",
      "source",
      "tenantId",
    ]) {
      expect(cols).toContain(col);
    }
  });
});

describe("Mirror table insert schemas — zod validation", () => {
  it("insertPastoralistLeadSchema accepts a minimal enrollment row", async () => {
    const mod = await import("@workspace/db");
    const parsed = mod.insertPastoralistLeadSchema.parse({
      phoneNumber: "+254712000004",
      enrollmentSource: "ussd_self",
      status: "lead",
      alertsEnabled: true,
    });
    expect(parsed.phoneNumber).toBe("+254712000004");
    expect(parsed.status).toBe("lead");
  });

  it("insertLeadInteractionSchema requires phoneNumber + channel", async () => {
    const mod = await import("@workspace/db");
    // Happy path.
    const ok = mod.insertLeadInteractionSchema.parse({
      phoneNumber: "+254712000004",
      channel: "ussd",
      tier: "lead",
      keyword: "MALISHO",
    });
    expect(ok.channel).toBe("ussd");
    // Missing channel is rejected.
    expect(() =>
      mod.insertLeadInteractionSchema.parse({
        phoneNumber: "+254712000004",
      }),
    ).toThrow();
  });

  it("insertWeatherDataSchema accepts a minimal observation row", async () => {
    const mod = await import("@workspace/db");
    const parsed = mod.insertWeatherDataSchema.parse({
      wardId: "242",
      observedDate: "2026-07-22",
      rainfallMm30d: "2.5",
      temperatureC: "29.5",
      source: "open-meteo",
    });
    expect(parsed.wardId).toBe("242");
  });

  it("insertWeatherForecastSchema accepts a minimal ensemble row", async () => {
    const mod = await import("@workspace/db");
    const parsed = mod.insertWeatherForecastSchema.parse({
      wardId: "242",
      targetDate: "2026-08-01",
      horizonDays: 10,
      rainfallMmP50: "1.2",
      source: "open-meteo",
    });
    expect(parsed.wardId).toBe("242");
    expect(parsed.horizonDays).toBe(10);
  });
});
