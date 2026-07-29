import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

/**
 * Route-level tests for the WhatsApp webhook, following the same
 * dependency-mocking convention as voiceDeterministicPipeline.test.ts:
 * every collaborator (herderContext, wpdx, threeSixtyDialog, supabase,
 * openai) is mocked at module level so the test exercises whatsapp.ts's
 * own branching logic in isolation, not the full DB/Supabase/LLM stack.
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
  sentLists: Array<{ phone: string }>;
  sentLocations: Array<{ phone: string; lat: number; lon: number; name: string }>;
  loggedMessages: Array<Record<string, unknown>>;
  insertGtCalls: Array<Record<string, unknown>>;
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
  sentLists: [],
  sentLocations: [],
  loggedMessages: [],
  insertGtCalls: [],
};

vi.mock("../src/lib/herderContext.js", () => ({
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

vi.mock("../src/lib/threeSixtyDialog.js", () => ({
  sendWhatsappSessionMessage: async (phone: string, text: string) => {
    fx.sentSessionMessages.push({ phone, text });
    return { ok: true, messageId: "wamid.test" };
  },
  sendWhatsappInteractiveList: async (phone: string) => {
    fx.sentLists.push({ phone });
    return { ok: true, messageId: "wamid.list" };
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

vi.mock("../src/lib/supabase.js", () => ({
  logWhatsappMessage: async (row: Record<string, unknown>) => {
    fx.loggedMessages.push(row);
  },
  hasPriorWhatsappMessages: async () => fx.hasPrior,
  insertGroundTruthCall: async (row: Record<string, unknown>) => {
    fx.insertGtCalls.push(row);
    return { call_id: "call-1", call_timestamp: "2026-07-27" };
  },
  isSupabaseConfigured: () => true,
}));

vi.mock("../src/lib/openai.js", () => ({
  extractIndicators: async () => fx.indicators,
  generateActionTag: async () => "WhatsApp Report",
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
  complete: async () => ({
    content: fx.llmContent,
    provider: "mock",
    model: "mock",
    cached: false,
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    latencyMs: 1,
  }),
}));

vi.mock("../src/lib/whatsappConversation.js", () => ({
  buildWhatsappSystemPrompt: () => "system prompt",
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
  fx.sentLists = [];
  fx.sentLocations = [];
  fx.loggedMessages = [];
  fx.insertGtCalls = [];

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
  it("sends the welcome interactive list on first-ever contact", async () => {
    fx.hasPrior = false;
    const res = await request(app)
      .post("/api/whatsapp-webhook")
      .send(webhookBody({ type: "text", text: { body: "hi" } }));

    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 0));
    expect(fx.sentLists).toHaveLength(1);
    expect(fx.sentLists[0].phone).toBe("+254712345678");
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
    expect(fx.sentLists).toHaveLength(0);
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
});
