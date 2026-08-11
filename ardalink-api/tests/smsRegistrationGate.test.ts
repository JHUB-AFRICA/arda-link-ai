/**
 * Regression coverage for the SMS mandatory registration gate
 * (2026-08-11) — net-new for this channel (no prior self-registration
 * flow existed on SMS at all). Mounts just the SMS router (not the
 * full createApp()), same convention as tests/whatsapp.test.ts and
 * tests/ussdRegistrationGate.test.ts, and mocks supabase/index.js
 * (partially — identity/config only) plus africastalking.js entirely
 * so no real network call (Supabase or Africa's Talking) is ever
 * attempted.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

const fx: {
  supabaseConfigured: boolean;
  tier: "verified" | "lead" | "unknown";
  upsertedLeads: Array<Record<string, unknown>>;
  setCurrentLocationCalls: Array<Record<string, unknown>>;
  sentSms: Array<{ phone: string; message: string }>;
  wardPromptPending: boolean;
  promptCleared: boolean;
  promptMarked: boolean;
} = {
  supabaseConfigured: true,
  tier: "unknown",
  upsertedLeads: [],
  setCurrentLocationCalls: [],
  sentSms: [],
  wardPromptPending: false,
  promptCleared: false,
  promptMarked: false,
};

vi.mock("../src/lib/supabase/index.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/lib/supabase/index.js")>();
  return {
    ...actual,
    isSupabaseConfigured: () => fx.supabaseConfigured,
    logLeadInteraction: async () => {},
    upsertPastoralistLead: async (row: Record<string, unknown>) => {
      fx.upsertedLeads.push(row);
      return null;
    },
    setCurrentLocation: async (row: Record<string, unknown>) => {
      fx.setCurrentLocationCalls.push(row);
      return null;
    },
  };
});

vi.mock("../src/lib/herderContext/index.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/lib/herderContext/index.js")>();
  return {
    ...actual,
    resolveHerderContext: async (phone: string) => ({
      ...(await actual.resolveHerderContext(phone, "bula-pesa")),
      tier: fx.tier,
    }),
  };
});

vi.mock("../src/lib/africastalking.js", () => ({
  sendSmsViaAt: async (phone: string, message: string) => {
    fx.sentSms.push({ phone, message });
    return { ok: true, skipped: false };
  },
  initiateOutboundCall: async () => ({ ok: true }),
}));

vi.mock("../src/lib/smsRegistrationPending.js", () => ({
  isWardPromptPending: async () => fx.wardPromptPending,
  markWardPromptSent: async () => {
    fx.promptMarked = true;
  },
  clearWardPrompt: async () => {
    fx.promptCleared = true;
  },
}));

let app: Express;

beforeEach(async () => {
  fx.supabaseConfigured = true;
  fx.tier = "unknown";
  fx.upsertedLeads = [];
  fx.setCurrentLocationCalls = [];
  fx.sentSms = [];
  fx.wardPromptPending = false;
  fx.promptCleared = false;
  fx.promptMarked = false;

  const { default: smsRouter } = await import("../src/routes/sms.js");
  app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { log: Record<string, (...args: unknown[]) => void> }).log = {
      info: () => {},
      warn: () => {},
      error: () => {},
    };
    next();
  });
  app.use("/api", smsRouter);
}, 20_000);

afterEach(() => {
  vi.clearAllMocks();
});

describe("SMS mandatory registration gate", () => {
  it("sends the ward picker instead of answering an unregistered number's keyword", async () => {
    const res = await request(app)
      .post("/api/sms-callback")
      .send({ from: "+254700777888", text: "BULA" });
    expect(res.status).toBe(200);
    expect(fx.promptMarked).toBe(true);
    expect(fx.sentSms).toHaveLength(1);
    expect(fx.sentSms[0]?.message).toMatch(/ward gani/);
    expect(fx.sentSms[0]?.message).not.toMatch(/NDVI|Malisho karibu/);
  });

  it("completes registration on a valid ward digit reply and unlocks the normal flow", async () => {
    fx.wardPromptPending = true;
    const res = await request(app)
      .post("/api/sms-callback")
      .send({ from: "+254700777888", text: "2" });
    expect(res.status).toBe(200);
    expect(fx.upsertedLeads).toHaveLength(1);
    expect(fx.upsertedLeads[0]).toMatchObject({
      phone_number: "+254700777888",
      enrollment_source: "sms_self",
    });
    expect(fx.setCurrentLocationCalls).toHaveLength(1);
    expect(fx.promptCleared).toBe(true);
    expect(fx.sentSms[0]?.message).toMatch(/Registered|Umesajiliwa/);
  });

  it("re-prompts instead of guessing on an invalid ward digit", async () => {
    fx.wardPromptPending = true;
    const res = await request(app)
      .post("/api/sms-callback")
      .send({ from: "+254700777888", text: "99" });
    expect(res.status).toBe(200);
    expect(fx.upsertedLeads).toHaveLength(0);
    expect(fx.sentSms[0]?.message).toMatch(/ward gani/);
  });

  it("still lets STOP/SITAKI escape the gate for an unregistered number", async () => {
    const res = await request(app)
      .post("/api/sms-callback")
      .send({ from: "+254700777888", text: "STOP" });
    expect(res.status).toBe(200);
    expect(fx.promptMarked).toBe(false);
    expect(fx.upsertedLeads).toHaveLength(0);
  });

  it("does not gate an already-known (lead/verified) number — normal keyword flow proceeds", async () => {
    fx.tier = "lead";
    const res = await request(app)
      .post("/api/sms-callback")
      .send({ from: "+254700777888", text: "BULA" });
    expect(res.status).toBe(200);
    expect(fx.promptMarked).toBe(false);
    expect(fx.sentSms[0]?.message).not.toMatch(/ward gani/);
  });

  it("never forces registration when Supabase is unreachable/unconfigured", async () => {
    fx.supabaseConfigured = false;
    const res = await request(app)
      .post("/api/sms-callback")
      .send({ from: "+254700777888", text: "BULA" });
    expect(res.status).toBe(200);
    expect(fx.promptMarked).toBe(false);
    expect(fx.sentSms[0]?.message).not.toMatch(/ward gani/);
  });
});
