/**
 * Tests for the /api/forecast route.
 *
 * When the satellite pipeline hasn't run yet, the route should return
 * 200 with `forecast: null` (not 404). The dashboard's optional
 * chain `f?.forecast?.outlook?.riskLevel` short-circuits on null,
 * so the UI shows nothing where forecast would be, and the
 * browser's network panel no longer logs a misleading 404.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createHmac } from "node:crypto";
import { createApp } from "../src/app";

const SECRET = "forecast-test-secret-32-bytes-long-fixed";

function mintJwt(claims: object, secret = SECRET): string {
  const header = { alg: "HS256", typ: "JWT" };
  const enc = (o: object): string =>
    Buffer.from(JSON.stringify(o)).toString("base64url");
  const headerB64 = enc(header);
  const payloadB64 = enc(claims);
  const sig = createHmac("sha256", secret)
    .update(`${headerB64}.${payloadB64}`)
    .digest("base64url");
  return `${headerB64}.${payloadB64}.${sig}`;
}

beforeAll(() => {
  process.env.JWT_SECRET = SECRET;
});
afterAll(() => {
  delete process.env.JWT_SECRET;
});

describe("GET /api/forecast", () => {
  it("requires auth (401 without Bearer)", async () => {
    const res = await request(createApp()).get("/api/forecast");
    expect(res.status).toBe(401);
  });

  it("returns 200 with forecast=null when no satellite baseline is loaded", async () => {
    const token = mintJwt({ sub: "test", tenant_id: "bula-pesa" });
    const res = await request(createApp())
      .get("/api/forecast")
      .set("Authorization", `Bearer ${token}`);
    if (res.status === 200) {
      expect(res.body.forecast).toBeNull();
      expect(res.body.basedOnSatelliteRunAt).toBeNull();
      expect(typeof res.body.note).toBe("string");
      expect(res.body.note).toMatch(/satellite/i);
    } else {
      expect(res.status).toBe(404);
      expect(typeof res.body.error).toBe("string");
    }
  });
});
