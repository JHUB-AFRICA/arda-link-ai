/**
 * Regression coverage for the USSD mandatory registration gate
 * (2026-08-11). `voiceAndUssd.test.ts` exercises the rest of the USSD
 * tree against a deliberately-unconfigured Supabase (see tests/setup.ts)
 * and relies on every Supabase call gracefully returning null — which
 * is also exactly the "gate must never apply" case this fix has to get
 * right (see the isSupabaseConfigured() guard in routes/ussd.ts). This
 * file instead partially mocks `identityForPhone`/`isSupabaseConfigured`
 * /`logLeadInteraction` (everything else in supabase/index.js stays
 * real, i.e. still gracefully null) so the gate's own branching can be
 * exercised directly, independent of the rest of the USSD tree.
 *
 * Mounts just the USSD router (not the full createApp()) — same
 * convention as tests/whatsapp.test.ts — so no unrelated route/
 * middleware surface can incidentally attempt a real network call once
 * isSupabaseConfigured() is forced true for these tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

const fx: {
  supabaseConfigured: boolean;
  identity: { tier: string; full_name: string | null } | null;
} = {
  supabaseConfigured: true,
  identity: null,
};

vi.mock("../src/lib/supabase/index.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/lib/supabase/index.js")>();
  return {
    ...actual,
    isSupabaseConfigured: () => fx.supabaseConfigured,
    identityForPhone: async () => fx.identity,
    logLeadInteraction: async () => {},
  };
});

let app: Express;

// First import pays a transitive @workspace/db / esbuild-transform cost
// (same class of slowness vitest.config.ts's testTimeout comment already
// calls out for other route+client modules) — a plain 10s default
// beforeEach hook timeout can get squeezed out under full-suite parallel
// worker contention, so this mirrors that file's own bumped budget
// rather than introducing a new one.
beforeEach(async () => {
  fx.supabaseConfigured = true;
  fx.identity = null;
  const { default: ussdRouter } = await import("../src/routes/ussd.js");
  app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  // ussd.ts calls req.log.info(...) — normally supplied by pino-http in
  // the real app (src/app.ts); stub it here since this harness mounts
  // just the router.
  app.use((req, _res, next) => {
    (req as unknown as { log: Record<string, (...args: unknown[]) => void> }).log = {
      info: () => {},
      warn: () => {},
      error: () => {},
    };
    next();
  });
  app.use("/api", ussdRouter);
}, 20_000);

afterEach(() => {
  vi.clearAllMocks();
});

describe("USSD mandatory registration gate", () => {
  it("routes an unregistered caller's dial-in straight into Jisajili instead of the main menu", async () => {
    const res = await request(app)
      .post("/api/ussd-callback")
      .send({ sessionId: "s1", phoneNumber: "+254700111222", text: "" });
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/^CON /);
    expect(res.text).toContain("Andika jina lako kamili");
    expect(res.text).not.toContain("Malisho");
  });

  it("carries an unregistered caller's typed reply through the SAME registration state machine as explicit option 5", async () => {
    // Because the gate prepends "5", this is equivalent to "5*John Doe"
    // — the existing, already-tested Jisajili level-2 branch.
    const res = await request(app)
      .post("/api/ussd-callback")
      .send({ sessionId: "s1", phoneNumber: "+254700111222", text: "John Doe" });
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/^CON /);
    expect(res.text).toContain("Uko ward gani");
  });

  it("does NOT gate an already-registered (lead or verified) caller — normal menu shows", async () => {
    fx.identity = { tier: "verified", full_name: "Existing Herder" };
    const res = await request(app)
      .post("/api/ussd-callback")
      .send({ sessionId: "s2", phoneNumber: "+254700333444", text: "" });
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/^CON /);
    expect(res.text).toContain("Malisho");
    expect(res.text).not.toContain("Andika jina lako kamili");
  });

  it(
    "never forces registration when Supabase is simply unreachable/unconfigured — a transient " +
      "identity-lookup failure must not lock out already-registered herders",
    async () => {
      fx.supabaseConfigured = false;
      const res = await request(app)
        .post("/api/ussd-callback")
        .send({ sessionId: "s3", phoneNumber: "+254700555666", text: "" });
      expect(res.status).toBe(200);
      expect(res.text).toMatch(/^CON /);
      expect(res.text).toContain("Malisho");
      expect(res.text).not.toContain("Andika jina lako kamili");
    },
  );
});
