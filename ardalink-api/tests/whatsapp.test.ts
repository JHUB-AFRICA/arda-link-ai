import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

/**
 * Route-level tests for the WhatsApp webhook, following the same
 * dependency-mocking convention as voiceDeterministicPipeline.test.ts:
 * every collaborator (herderContext, wpdx, whatsappProviderRegistry,
 * supabase, openai) is mocked at module level so the test exercises
 * whatsapp.ts's parsing + whatsappTurn.ts's branching logic in
 * isolation, not the full DB/Supabase/LLM stack or a real WhatsApp
 * provider.
 *
 * A minimal local Express app (not the full createApp()) mounts just
 * the whatsapp router, avoiding the need to configure every other
 * route's dependencies (DATABASE_URL, etc.) just to run this suite.
 */

interface Fx {
  ctx: {
    tier: "verified" | "lead" | "unknown";
    wardId: string | null;
    wardName: string | null;
    pastoralistId: string | null;
    preferredLanguage: string | null;
  };
  lang: "sw" | "en";
  hasPrior: boolean;
  brief: string;
  waterPoints: Array<{
    point: { lat: number; lon: number };
    displayName: string;
    status: string;
    distanceKm: number;
  }>;
  indicators: Record<string, unknown> | null;
  llmContent: string;
  sentSessionMessages: Array<{ phone: string; text: string }>;
  sentButtons: Array<{ phone: string }>;
  sentLocations: Array<{ phone: string; lat: number; lon: number; name: string }>;
  loggedMessages: Array<Record<string, unknown>>;
  insertGtCalls: Array<Record<string, unknown>>;
  history: Array<{
    direction: "in" | "out" | "status";
    message_type: string;
    body_text: string | null;
    occurred_at: string;
  }>;
  loggedInteractions: Array<Record<string, unknown>>;
  leadStatusCalls: Array<{ phone: string; status: string }>;
  optedOutPhones: string[];
  lastCompleteMessages: Array<{ role: string; content: string }>;
  pendingLocation: { lat: number; lon: number } | null;
  grazingAdvisory: Record<string, unknown> | null;
}

const fx: Fx = {
  ctx: {
    tier: "verified",
    wardId: "242",
    wardName: "Bula Pesa",
    pastoralistId: "past-uuid-1",
    preferredLanguage: "sw",
  },
  lang: "sw",
  hasPrior: true,
  brief: "Hali ya ukame Bula Pesa: NDVI -38%",
  waterPoints: [
    {
      point: { lat: 0.34, lon: 37.58 },
      displayName: "Bula Pesa Dam",
      status: "working",
      distanceKm: 2,
    },
  ],
  indicators: null,
  llmContent: "Asante, nimeelewa.",
  sentSessionMessages: [],
  sentButtons: [],
  sentLocations: [],
  loggedMessages: [],
  insertGtCalls: [],
  history: [],
  loggedInteractions: [],
  leadStatusCalls: [],
  optedOutPhones: [],
  lastCompleteMessages: [],
  pendingLocation: null,
  grazingAdvisory: null,
};

vi.mock("../src/lib/herderContext/index.js", () => ({
  resolveHerderContext: async () => fx.ctx,
  buildLocalizedBrief: () => fx.brief,
}));

vi.mock("../src/lib/voiceCopy.js", () => ({
  languageForCaller: () => fx.lang,
}));

vi.mock("../src/lib/wpdx.js", () => ({
  centroidForTenant: () => ({ lat: 0.3453, lon: 37.581 }),
  nearestWorkingKnownPoints: () => fx.waterPoints,
}));

vi.mock("../src/lib/whatsappProviderRegistry.js", () => ({
  sendWhatsappSessionMessage: async (phone: string, text: string) => {
    fx.sentSessionMessages.push({ phone, text });
    return { ok: true, messageId: "wamid.test" };
  },
  sendWhatsappInteractiveButtons: async (phone: string) => {
    fx.sentButtons.push({ phone });
    return { ok: true, messageId: "wamid.buttons" };
  },
  sendWhatsappLocation: async (
    phone: string,
    lat: number,
    lon: number,
    name: string,
  ) => {
    fx.sentLocations.push({ phone, lat, lon, name });
    return { ok: true, messageId: "wamid.loc" };
  },
}));

vi.mock("../src/lib/supabase/index.js", () => ({
  logWhatsappMessage: async (row: Record<string, unknown>) => {
    fx.loggedMessages.push(row);
  },
  hasPriorWhatsappMessages: async () => fx.hasPrior,
  recentWhatsappMessages: async () => fx.history,
  insertGroundTruthCall: async (row: Record<string, unknown>) => {
    fx.insertGtCalls.push(row);
    return { call_id: "call-1", call_timestamp: "2026-07-27" };
  },
  isSupabaseConfigured: () => true,
  logLeadInteraction: async (row: Record<string, unknown>) => {
    fx.loggedInteractions.push(row);
  },
  setLeadStatus: async (phone: string, status: string) => {
    fx.leadStatusCalls.push({ phone, status });
    return true;
  },
  markPastoralistOptedOut: async (phone: string) => {
    fx.optedOutPhones.push(phone);
    return true;
  },
}));

vi.mock("../src/lib/openai/index.js", () => ({
  extractIndicators: async () => fx.indicators,
  generateActionTag: async () => "WhatsApp Report",
}));

vi.mock("../src/lib/grazingRingPending.js", () => ({
  upsertPendingLocation: async () => {},
  getPendingLocation: async () => fx.pendingLocation,
  clearPendingLocation: async () => {},
}));

vi.mock("../src/lib/engine.js", () => ({
  fetchGrazingAdvisory: async () => fx.grazingAdvisory,
}));

vi.mock("../src/lib/trustScore.js", () => ({
  computeTrustScore: () => ({ score: 70, flags: [] }),
  logTrustScore: vi.fn(),
}));

vi.mock("../src/lib/pastoralistContact.js", () => ({
  touchPastoralistLastContact: vi.fn(async () => undefined),
}));

vi.mock("../src/lib/intelligence.js", () => ({
  getLastResult: () => null,
}));

vi.mock("../src/lib/llm/index.js", () => ({
  complete: async (
    _task: string,
    req: { messages: Array<{ role: string; content: string }> },
  ) => {
    fx.lastCompleteMessages = req.messages;
    return {
      content: fx.llmContent,
      provider: "mock",
      model: "mock",
      cached: false,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      latencyMs: 1,
    };
  },
}));

vi.mock("../src/lib/whatsappConversation.js", () => ({
  buildWhatsappSystemPrompt: (
    _ctx: unknown,
    _lang: string,
    hasHistory: boolean,
  ) => `system prompt hasHistory=${hasHistory}`,
}));

let app: Express;

beforeEach(async () => {
  fx.ctx = {
    tier: "verified",
    wardId: "242",
    wardName: "Bula Pesa",
    pastoralistId: "past-uuid-1",
    preferredLanguage: "sw",
  };
  fx.hasPrior = true;
  fx.indicators = null;
  fx.sentSessionMessages = [];
  fx.sentButtons = [];
  fx.sentLocations = [];
  fx.loggedMessages = [];
  fx.insertGtCalls = [];
  fx.history = [];
  fx.loggedInteractions = [];
  fx.leadStatusCalls = [];
  fx.optedOutPhones = [];
  fx.lastCompleteMessages = [];
  fx.pendingLocation = null;
  fx.grazingAdvisory = null;

  const { default: whatsappRouter } = await import("../src/routes/whatsapp.js");
  app = express();
  app.use(express.json());
  app.use("/api", whatsappRouter);
});

afterEach(() => {
  vi.clearAllMocks();
});

function webhookBody(message: Record<string, unknown>) {
  return {
    entry: [
      {
        changes: [
          {
            value: {
              contacts: [{ wa_id: "254712345678" }],
              messages: [{ from: "254712345678", id: "wamid.in1", ...message }],
            },
          },
        ],
      },
    ],
  };
}

describe("POST /api/whatsapp-webhook", () => {
  it("sends the welcome interactive buttons on first-ever contact", async () => {
    fx.hasPrior = false;
    const res = await request(app)
      .post("/api/whatsapp-webhook")
      .send(webhookBody({ type: "text", text: { body: "hi" } }));

    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 0));
    expect(fx.sentButtons).toHaveLength(1);
    expect(fx.sentButtons[0].phone).toBe("+254712345678");
  });

  it("replies with the localized brief on bula_pesa list reply", async () => {
    const res = await request(app).post("/api/whatsapp-webhook").send(
      webhookBody({
        type: "interactive",
        interactive: { list_reply: { id: "bula_pesa", title: "Bula Pesa" } },
      }),
    );
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 0));
    expect(fx.sentSessionMessages).toHaveLength(1);
    expect(fx.sentSessionMessages[0].text).toBe(fx.brief);
  });

  it("sends real water-point location pins on malisho list reply", async () => {
    const res = await request(app).post("/api/whatsapp-webhook").send(
      webhookBody({
        type: "interactive",
        interactive: { list_reply: { id: "malisho", title: "Malisho" } },
      }),
    );
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 0));
    expect(fx.sentLocations).toHaveLength(1);
    expect(fx.sentLocations[0]).toMatchObject({
      lat: 0.34,
      lon: 37.58,
      name: "Bula Pesa Dam",
    });
  });

  it("processes a free-text turn through the LLM and extractor", async () => {
    const res = await request(app)
      .post("/api/whatsapp-webhook")
      .send(webhookBody({ type: "text", text: { body: "Ng'ombe wangu ni wagonjwa" } }));
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 0));
    expect(fx.sentSessionMessages).toHaveLength(1);
    expect(fx.sentSessionMessages[0].text).toBe(fx.llmContent);
  });

  it("writes a ground_truth_calls row with channel=whatsapp when indicators are collected", async () => {
    fx.indicators = {
      bcs_score: 2.5,
      indicators_collected: 3,
      mortality_rate: null,
      offtake_rate: null,
      water_point_status: null,
      water_trekking_distance: null,
      supplementary_feeding: null,
    };
    await request(app)
      .post("/api/whatsapp-webhook")
      .send(webhookBody({ type: "text", text: { body: "report" } }));
    await new Promise((r) => setTimeout(r, 0));
    expect(fx.insertGtCalls).toHaveLength(1);
    expect(fx.insertGtCalls[0]).toMatchObject({
      channel: "whatsapp",
      pastoralist_id: "past-uuid-1",
      ward_id: "242",
    });
  });

  it("does not write ground truth when no indicators were collected", async () => {
    fx.indicators = null;
    await request(app)
      .post("/api/whatsapp-webhook")
      .send(webhookBody({ type: "text", text: { body: "hello" } }));
    await new Promise((r) => setTimeout(r, 0));
    expect(fx.insertGtCalls).toHaveLength(0);
  });

  it("logs only, sends no reply, for a status-only payload", async () => {
    const res = await request(app)
      .post("/api/whatsapp-webhook")
      .send({
        entry: [
          {
            changes: [
              {
                value: {
                  statuses: [
                    { id: "wamid.out1", status: "delivered", recipient_id: "254712345678" },
                  ],
                },
              },
            ],
          },
        ],
      });
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 0));
    expect(fx.sentSessionMessages).toHaveLength(0);
    expect(fx.sentButtons).toHaveLength(0);
    expect(fx.loggedMessages).toHaveLength(1);
    expect(fx.loggedMessages[0]).toMatchObject({ direction: "status" });
  });

  it("replies with a static message and logs message_type=audio for a voice note", async () => {
    const res = await request(app)
      .post("/api/whatsapp-webhook")
      .send(webhookBody({ type: "audio", audio: { id: "media-1" } }));
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 0));
    expect(fx.sentSessionMessages).toHaveLength(1);
    const inboundLog = fx.loggedMessages.find((m) => m.direction === "in");
    expect(inboundLog).toMatchObject({ message_type: "audio" });
  });

  it("resurfaces the welcome buttons for MSAADA/HELP mid-conversation, even with prior contact", async () => {
    fx.hasPrior = true;
    const res = await request(app)
      .post("/api/whatsapp-webhook")
      .send(webhookBody({ type: "text", text: { body: "msaada" } }));
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 0));
    expect(fx.sentButtons).toHaveLength(1);
    expect(fx.sentSessionMessages).toHaveLength(0);
  });

  it("opts a herder out on STOP/SITAKI and sends a confirmation, without calling the LLM", async () => {
    const res = await request(app)
      .post("/api/whatsapp-webhook")
      .send(webhookBody({ type: "text", text: { body: "STOP" } }));
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 0));
    expect(fx.leadStatusCalls).toEqual([
      { phone: "+254712345678", status: "opted_out" },
    ]);
    expect(fx.optedOutPhones).toEqual(["+254712345678"]);
    expect(fx.sentSessionMessages).toHaveLength(1);
    expect(fx.lastCompleteMessages).toHaveLength(0);
  });

  it("passes prior conversation turns to the LLM and tells the prompt builder history exists", async () => {
    fx.history = [
      { direction: "in", message_type: "text", body_text: "Isiolo", occurred_at: "2026-07-27T10:00:00Z" },
      { direction: "out", message_type: "text", body_text: "Sawa, una mifugo gani?", occurred_at: "2026-07-27T10:00:05Z" },
      // Non-conversational rows must be excluded from history.
      { direction: "out", message_type: "interactive_buttons", body_text: "welcome_list", occurred_at: "2026-07-27T09:59:00Z" },
    ];
    const res = await request(app)
      .post("/api/whatsapp-webhook")
      .send(webhookBody({ type: "text", text: { body: "Ng'ombe" } }));
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 0));
    expect(fx.lastCompleteMessages).toEqual([
      { role: "system", content: "system prompt hasHistory=true" },
      { role: "user", content: "Isiolo" },
      { role: "assistant", content: "Sawa, una mifugo gani?" },
      { role: "user", content: "Ng'ombe" },
    ]);
  });

  it("tells the prompt builder there is no history on a genuinely first free-text turn", async () => {
    fx.history = [];
    const res = await request(app)
      .post("/api/whatsapp-webhook")
      .send(webhookBody({ type: "text", text: { body: "Ng'ombe wangu wagonjwa" } }));
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 0));
    expect(fx.lastCompleteMessages[0]).toEqual({
      role: "system",
      content: "system prompt hasHistory=false",
    });
  });
});
