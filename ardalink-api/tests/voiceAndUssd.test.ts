import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";

/**
 * End-to-end tests for the Africa's Talking webhook surface.
 *
 * These tests verify the response shapes match the AT spec — not the
 * business logic (that's covered by the route-specific tests). If AT
 * changes its callback contract, these break loud and early.
 *
 * What's covered:
 *   POST /api/voice-callback   → returns 200 + valid <Response>/<Stream> XML
 *   POST /api/voice-events     → returns 200 + JSON ack
 *   POST /api/ussd-callback    → returns 200 + CON/END text/plain
 *   POST /api/sms-callback     → returns 200 + text/plain reply body
 *
 * What's NOT covered here:
 *   - actually calling AT (we use the sandbox simulator for that)
 *   - Azure Realtime WebSocket bridging (covered in voiceStream tests)
 *   - tenant isolation (covered in tenancy.test.ts)
 */

let app: ReturnType<typeof createApp>;

beforeAll(() => {
  app = createApp();
});

describe("POST /api/voice-callback — AT voice webhook", () => {
  it("deterministic default: returns <Say>+<GetDigits> opener XML", async () => {
    // Since 2026-07-07 the default CALL_PIPELINE_MODE is `deterministic`.
    // AT gets a value-first opener + DTMF menu instead of the Stream XML.
    // See ardalink-api/docs/llm-integration.md §5.
    const res = await request(app)
      .post("/api/voice-callback")
      .type("form")
      .send({
        callerNumber: "+254711082200",
        destinationNumber: "+254700000000",
        sessionId: "AT-test-001",
        direction: "outbound",
      });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/xml/);
    expect(res.text).toContain("<?xml");
    expect(res.text).toContain("<Response>");
    expect(res.text).toContain("<Say>");
    expect(res.text).toContain("<GetDigits");
    expect(res.text).toContain("stage=dtmf");
    expect(res.text).toContain("</Response>");
  });

  it("realtime mode (?mode=realtime): returns <Stream/> XML", async () => {
    const res = await request(app)
      .post("/api/voice-callback?mode=realtime")
      .set("x-forwarded-host", "localhost:3000")
      .set("x-forwarded-proto", "http")
      .type("form")
      .send({
        callerNumber: "+254711082200",
        destinationNumber: "+254700000000",
        sessionId: "AT-test-rt",
        direction: "outbound",
      });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/xml/);
    expect(res.text).toContain("<Stream");
    expect(res.text).toContain("/api/voice-stream");
    expect(res.text).toContain("</Response>");
  });

  it("does NOT require Bearer auth (AT can't sign JWTs)", async () => {
    // No Authorization header — request still succeeds
    const res = await request(app)
      .post("/api/voice-callback")
      .type("form")
      .send({ destinationNumber: "+254700000000", sessionId: "AT-test-002" });
    expect(res.status).toBe(200);
  });
});

describe("POST /api/voice-events — AT call lifecycle events", () => {
  it.each(["queued", "ringing", "answered", "completed", "failed", "busy"])(
    "accepts state=%s and returns 200 ack",
    async (state) => {
      const res = await request(app)
        .post("/api/voice-events")
        .type("form")
        .send({
          sessionId: `AT-evt-${state}`,
          callSessionState: state,
          callerNumber: "+254711082200",
          destinationNumber: "+254700000000",
          durationInSeconds: "0",
        });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
    },
  );
});

describe("POST /api/ussd-callback — AT USSD gateway", () => {
  it("returns CON menu on first dial-in (text='')", async () => {
    const res = await request(app)
      .post("/api/ussd-callback")
      .type("form")
      .send({
        sessionId: "AT-ussd-001",
        serviceCode: "*123*8#",
        phoneNumber: "+254711082200",
        text: "",
      });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/plain/);
    expect(res.text).toMatch(/^CON /);
    expect(res.text).toContain("Bula Pesa");
    expect(res.text).toContain("Malisho");
    expect(res.text).toContain("Ongea");
    expect(res.text).toContain("Toka");
  });

  it("returns END on Toka (selection 4)", async () => {
    const res = await request(app)
      .post("/api/ussd-callback")
      .type("form")
      .send({
        sessionId: "AT-ussd-002",
        serviceCode: "*123*8#",
        phoneNumber: "+254711082200",
        text: "4",
      });

    expect(res.status).toBe(200);
    expect(res.text).toMatch(/^END /);
    expect(res.text).toMatch(/Kwaheri|Goodbye/i);
  });

  it("drills into Bula Pesa → Swahili brief (text='1*1')", async () => {
    const res = await request(app)
      .post("/api/ussd-callback")
      .type("form")
      .send({
        sessionId: "AT-ussd-003",
        serviceCode: "*123*8#",
        phoneNumber: "+254711082200",
        text: "1*1",
      });

    expect(res.status).toBe(200);
    // Without a satellite run the brief says "no report today" — either way
    // it's a valid END response with Swahili or English copy.
    expect(res.text).toMatch(/^END /);
  });

  it("returns Malisho list on selection 2", async () => {
    const res = await request(app)
      .post("/api/ussd-callback")
      .type("form")
      .send({
        sessionId: "AT-ussd-004",
        serviceCode: "*123*8#",
        phoneNumber: "+254711082200",
        text: "2",
      });

    expect(res.status).toBe(200);
    expect(res.text).toMatch(/^END /);
    expect(res.text).toContain("Bulla Pesa");
    expect(res.text).toContain("Wabera");
  });

  it("returns CON submenu on Ongea (selection 3)", async () => {
    const res = await request(app)
      .post("/api/ussd-callback")
      .type("form")
      .send({
        sessionId: "AT-ussd-005",
        serviceCode: "*123*8#",
        phoneNumber: "+254711082200",
        text: "3",
      });

    expect(res.status).toBe(200);
    expect(res.text).toMatch(/^CON /);
    expect(res.text).toContain("Sasa");
  });

  it("handles too-many-levels cleanly (no infinite menu)", async () => {
    const res = await request(app)
      .post("/api/ussd-callback")
      .type("form")
      .send({
        sessionId: "AT-ussd-006",
        serviceCode: "*123*8#",
        phoneNumber: "+254711082200",
        text: "1*2*3*4*5",
      });

    expect(res.status).toBe(200);
    expect(res.text).toMatch(/^END /);
  });

  it("rejects invalid first-level choice with END + menu", async () => {
    const res = await request(app)
      .post("/api/ussd-callback")
      .type("form")
      .send({
        sessionId: "AT-ussd-007",
        serviceCode: "*123*8#",
        phoneNumber: "+254711082200",
        text: "9",
      });

    expect(res.status).toBe(200);
    expect(res.text).toMatch(/^END /);
    expect(res.text).toContain("Bula Pesa");
  });

  it("does NOT require Bearer auth (AT can't sign JWTs)", async () => {
    const res = await request(app)
      .post("/api/ussd-callback")
      .type("form")
      .send({
        serviceCode: "*123*8#",
        phoneNumber: "+254711082200",
        text: "4",
      });
    expect(res.status).toBe(200);
  });
});

describe("POST /api/sms-callback — AT inbound SMS", () => {
  it("replies to BULA keyword", async () => {
    const res = await request(app)
      .post("/api/sms-callback")
      .type("form")
      .send({
        from: "+254711082200",
        to: "+254711082200",
        text: "BULA",
        id: "AT-sms-001",
      });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/plain/);
    // Reply is plain text, ≤160 chars so it fits a single SMS segment
    expect(res.text.length).toBeGreaterThan(0);
    expect(res.text.length).toBeLessThanOrEqual(160);
    expect(res.text.toLowerCase()).toMatch(/bula|ardalink|stress|risk/);
  });

  it("replies to MALISHO with water-point list", async () => {
    const res = await request(app)
      .post("/api/sms-callback")
      .type("form")
      .send({
        from: "+254711082200",
        to: "+254711082200",
        text: "MALISHO",
        id: "AT-sms-002",
      });

    expect(res.status).toBe(200);
    expect(res.text.length).toBeLessThanOrEqual(160);
    expect(res.text).toContain("Bulla Pesa");
  });

  it("replies to ONGEA with callback confirmation", async () => {
    const res = await request(app)
      .post("/api/sms-callback")
      .type("form")
      .send({
        from: "+254711082200",
        to: "+254711082200",
        text: "ONGEA",
        id: "AT-sms-003",
      });

    expect(res.status).toBe(200);
    expect(res.text.toLowerCase()).toMatch(/ardalink|call/);
  });

  it("replies to STOP with empty body (no auto-reply)", async () => {
    const res = await request(app)
      .post("/api/sms-callback")
      .type("form")
      .send({
        from: "+254711082200",
        to: "+254711082200",
        text: "STOP",
        id: "AT-sms-004",
      });

    expect(res.status).toBe(200);
    expect(res.text).toBe("");
  });

  it("falls back to help text for unknown keywords", async () => {
    const res = await request(app)
      .post("/api/sms-callback")
      .type("form")
      .send({
        from: "+254711082200",
        to: "+254711082200",
        text: "JAMBO",
        id: "AT-sms-005",
      });

    expect(res.status).toBe(200);
    expect(res.text).toMatch(/BULA|MALISHO|ONGEA|STOP/);
  });

  it("truncates overlong replies with ellipsis (single-segment guarantee)", async () => {
    const res = await request(app)
      .post("/api/sms-callback")
      .type("form")
      .send({
        from: "+254711082200",
        to: "+254711082200",
        text: "BULA",
        id: "AT-sms-006",
      });

    expect(res.status).toBe(200);
    // Either the reply is short enough already, or it ends in …
    if (res.text.length > 160) {
      expect(res.text).toMatch(/…$/);
    }
  });

  it("does NOT require Bearer auth (AT can't sign JWTs)", async () => {
    const res = await request(app)
      .post("/api/sms-callback")
      .type("form")
      .send({
        from: "+254711082200",
        to: "+254711082200",
        text: "STOP",
      });
    expect(res.status).toBe(200);
  });
});

describe("AT webhook surface — public-path posture", () => {
  // AT cannot sign JWTs and does not send Bearer tokens. All four
  // webhook endpoints must be reachable without auth, otherwise the
  // sandbox flow breaks the moment AT dials in.
  const paths = [
    "/api/voice-callback",
    "/api/voice-events",
    "/api/ussd-callback",
    "/api/sms-callback",
  ];

  it.each(paths)("GET %s is reachable (not blocked by middleware)", async (p) => {
    // AT does not GET but the middleware checks req.path regardless of
    // method. We only need to verify the path bypass is in PUBLIC_PATHS.
    const res = await request(app).get(p);
    // GET on a POST-only route → 404 from Express is fine; 401 would
    // mean the tenant middleware rejected it.
    expect([404, 405]).toContain(res.status);
  });
});
