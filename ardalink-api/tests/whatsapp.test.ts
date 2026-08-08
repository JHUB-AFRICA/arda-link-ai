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
  llmProvider: string;
  llmIsMock: boolean;
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
  centroidForTenantCalls: string[];
  registrationState: Record<string, unknown> | null;
  upsertedLeads: Array<Record<string, unknown>>;
  setCurrentLocationCalls: Array<Record<string, unknown>>;
  wards?: Array<{ ward_id: string; name: string }>;
  satelliteByWard?: Record<string, { ndvi_mean: number | null; vci_value: number | null }>;
  centroidByWard?: Record<string, { lat: number; lon: number } | null>;
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
  llmProvider: "test-provider",
  llmIsMock: false,
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
  centroidForTenantCalls: [],
  registrationState: null,
  upsertedLeads: [],
  setCurrentLocationCalls: [],
};

vi.mock("../src/lib/herderContext/index.js", () => ({
  resolveHerderContext: async () => fx.ctx,
  buildLocalizedBrief: () => fx.brief,
}));

vi.mock("../src/lib/voiceCopy.js", () => ({
  languageForCaller: () => fx.lang,
}));

// Tenant-aware (not a fixed single return) so tests can prove the caller
// resolved the HERDER'S OWN ward, not a hardcoded default — see the
// handleMalisho regression test below for exactly the incident this
// distinction matters for.
const TEST_CENTROIDS: Record<string, { lat: number; lon: number }> = {
  "bula-pesa": { lat: 0.3453, lon: 37.581 },
  "ngare-mara": { lat: 0.6614, lon: 37.904 },
};
vi.mock("../src/lib/wpdx.js", () => ({
  centroidForTenant: (tenantSlug: string) => {
    fx.centroidForTenantCalls.push(tenantSlug);
    return TEST_CENTROIDS[tenantSlug] ?? null;
  },
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
  upsertPastoralistLead: async (row: Record<string, unknown>) => {
    fx.upsertedLeads.push(row);
    return { lead_id: "lead-test-1", ...row };
  },
  setCurrentLocation: async (input: Record<string, unknown>) => {
    fx.setCurrentLocationCalls.push(input);
  },
  // Phase 3's resolveQueryWard() — only exercised when a message names
  // a different ward than the fixture's own (fx.ctx.wardId, default
  // "242"); default to empty/null so pre-existing tests (none of which
  // are testing cross-ward resolution) keep working unchanged.
  listWards: async () => fx.wards ?? [],
  latestSatelliteFor: async (wardId: string) => fx.satelliteByWard?.[wardId] ?? null,
  centroidForWardId: async (wardId: string) => fx.centroidByWard?.[wardId] ?? null,
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

vi.mock("../src/lib/whatsappRegistrationPending.js", () => ({
  startRegistration: async () => {
    fx.registrationState = { step: "ask_name" };
  },
  getRegistrationState: async () => fx.registrationState,
  advanceRegistrationState: async (
    _phone: string,
    patch: Record<string, unknown>,
  ) => {
    fx.registrationState = { ...(fx.registrationState ?? {}), ...patch };
  },
  clearRegistrationState: async () => {
    fx.registrationState = null;
  },
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
      // Real MockClient impersonates the provider it's standing in for
      // (e.g. `new MockClient('z', 'glm-4.5-flash')`) — `provider` is
      // NEVER literally "mock" in practice. `isMock` is the only
      // reliable signal, and this fixture mirrors that shape exactly so
      // the regression test below actually exercises the real bug (a
      // guard that checked `provider === "mock"` could never fire).
      provider: fx.llmProvider,
      model: "test-model",
      cached: false,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      latencyMs: 1,
      isMock: fx.llmIsMock,
    };
  },
}));

vi.mock("../src/lib/whatsappConversation.js", () => ({
  buildWhatsappSystemPrompt: (
    _ctx: unknown,
    _lang: string,
    hasHistory: boolean,
    freshWaterPoint?: { name: string; distanceKm: number; status: string } | null,
    gapMinutes?: number | null,
    queryWard?: { wardId: string; wardName: string } | null,
  ) =>
    `system prompt hasHistory=${hasHistory}` +
    (freshWaterPoint
      ? ` freshWaterPoint=${freshWaterPoint.name}@${freshWaterPoint.distanceKm.toFixed(1)}km(${freshWaterPoint.status}) computed just now by the system`
      : "") +
    (gapMinutes != null ? ` gapMinutes=${gapMinutes.toFixed(1)}` : "") +
    (queryWard ? ` queryWard=${queryWard.wardId}(${queryWard.wardName})` : ""),
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
  fx.llmProvider = "test-provider";
  fx.llmIsMock = false;
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
  fx.centroidForTenantCalls = [];
  fx.registrationState = null;
  fx.upsertedLeads = [];
  fx.setCurrentLocationCalls = [];

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

  it("resolves Malisho's water points from the HERDER'S OWN ward, not a hardcoded default", async () => {
    // Regression test for a real, confirmed-live bug (2026-08-06):
    // handleMalisho always resolved centroidForTenant(DEFAULT_TENANT_ID)
    // ("bula-pesa", a fixed env var) regardless of ctx.wardId — every
    // herder in Wabera, Ngare Mara, Burat, or Oldonyiro who tapped
    // "Malisho" got Bula Pesa's water points sent as real location pins.
    fx.ctx.wardId = "245"; // Ngare Mara
    const res = await request(app).post("/api/whatsapp-webhook").send(
      webhookBody({
        type: "interactive",
        interactive: { list_reply: { id: "malisho", title: "Malisho" } },
      }),
    );
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 0));
    expect(fx.centroidForTenantCalls).toContain("ngare-mara");
    expect(fx.centroidForTenantCalls).not.toContain("bula-pesa");
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

  it("never sends raw MockClient content to a live conversation", async () => {
    // Regression test for a real, CONFIRMED-LIVE incident (2026-08-06,
    // not just a hypothetical): the z.ai->minimax fallback chain
    // bottomed out to MockClient mid-conversation and its raw echo
    // ("[MOCK z/glm-4.5-flash] niko Ngare Mara") went out VERBATIM to a
    // real WhatsApp tester. Root cause: MockClient is constructed as
    // `new MockClient('z', 'glm-4.5-flash')` to impersonate the real
    // provider it stands in for (see providers/mock.ts) — so `provider`
    // is NEVER literally "mock", and the guard that used to check
    // `provider === "mock"` could never fire. This fixture now mirrors
    // that real shape (realistic provider name + `isMock: true`)
    // instead of the fictional `provider: "mock"` the old version of
    // this test used — which is exactly why the old test passed while
    // the real bug shipped to a live tester undetected.
    fx.llmProvider = "z";
    fx.llmIsMock = true;
    fx.llmContent = "[MOCK z/glm-4.5-flash] niko Ngare Mara";
    const res = await request(app)
      .post("/api/whatsapp-webhook")
      .send(webhookBody({ type: "text", text: { body: "niko Ngare Mara" } }));
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 0));
    expect(fx.sentSessionMessages).toHaveLength(1);
    expect(fx.sentSessionMessages[0].text).not.toContain("MOCK");
    expect(fx.sentSessionMessages[0].text).toBe(
      "Samahani, kuna hitilafu ya muda mfupi kwenye mfumo — jaribu tena baada ya dakika chache. 🙏",
    );
  });

  it("answers a species reply typed as free text with the real advisory, never the LLM", async () => {
    // Regression test for a real incident (2026-08-05): a herder shared a
    // real location, got the species buttons, then typed "10 cows"
    // instead of tapping one. handleFreeText's LLM path — with no
    // distance-calculation capability — went on to invent "*25.7 km*"
    // when later asked "how far am I". A pending location plus a
    // detected species keyword must now route to the real, computed
    // grazing advisory and never reach the LLM at all.
    fx.pendingLocation = { lat: 0.34, lon: 37.58 };
    fx.grazingAdvisory = {
      nearestWaterNode: {
        name: "Ngare Mara piped water GW2",
        distanceKm: 4.2,
        direction: "NE",
        functionalStatus: "working",
      },
      speciesGroup: "cattle",
      radiusKm: 5,
      inRing: true,
      vci: 55,
      ndviNow: 0.3,
      dataSources: { water: "wpdx", vegetation: "sentinel-2" },
    };
    const res = await request(app)
      .post("/api/whatsapp-webhook")
      .send(webhookBody({ type: "text", text: { body: "10 cows" } }));
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 0));
    expect(fx.sentSessionMessages).toHaveLength(1);
    expect(fx.sentSessionMessages[0].text).toContain("Ngare Mara piped water GW2");
    expect(fx.sentSessionMessages[0].text).toContain("4.2");
    // Never the generic LLM stub content — the real advisory answered it.
    expect(fx.sentSessionMessages[0].text).not.toBe(fx.llmContent);
  });

  it("re-prompts for species instead of guessing when a distance question follows a pending location", async () => {
    // Same incident as above, other half: if the herder asks "how far am
    // I" with a location pending but no species yet, the fix must not
    // guess a species either — it re-sends the species buttons rather
    // than letting the LLM invent a number for an unknown herd.
    fx.pendingLocation = { lat: 0.34, lon: 37.58 };
    const res = await request(app)
      .post("/api/whatsapp-webhook")
      .send(webhookBody({ type: "text", text: { body: "How far am i" } }));
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 0));
    expect(fx.sentButtons).toHaveLength(1);
    expect(fx.sentSessionMessages).toHaveLength(0);
  });

  it("avails the real nearest water point to the LLM whenever a location is pending, not just for keyword-matched phrasings", async () => {
    // The general fix behind the two tests above: rather than relying on
    // catching every possible phrasing with a keyword regex, whenever a
    // location is pending the real nearest water point (computed
    // synchronously, no backend wait) is put directly into the system
    // prompt every turn — so even a message that matches neither the
    // species nor the distance-question fast path still gets a real,
    // fresh number available to reference instead of an invented one.
    fx.pendingLocation = { lat: 0.34, lon: 37.58 };
    const res = await request(app)
      .post("/api/whatsapp-webhook")
      .send(webhookBody({ type: "text", text: { body: "Sawa, asante" } }));
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 0));
    const systemMessage = fx.lastCompleteMessages.find((m) => m.role === "system");
    expect(systemMessage?.content).toContain("Bula Pesa Dam");
    expect(systemMessage?.content).toContain("2.0km");
    expect(systemMessage?.content).toContain("computed just now by the system");
    expect(systemMessage?.content).toContain("(working)");
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
    // The system message's exact content isn't asserted here beyond the
    // "hasHistory=true" prefix — the fixture's history is dated
    // 2026-07-27, so gapMinutes (computed from the real clock at test
    // time) is large and non-deterministic across when this suite runs.
    // That's exercised precisely by the dedicated "stale thread" test
    // below instead.
    expect(fx.lastCompleteMessages[0]?.role).toBe("system");
    expect(fx.lastCompleteMessages[0]?.content).toMatch(/^system prompt hasHistory=true/);
    expect(fx.lastCompleteMessages.slice(1)).toEqual([
      { role: "user", content: "Isiolo" },
      { role: "assistant", content: "Sawa, una mifugo gani?" },
      { role: "user", content: "Ng'ombe" },
    ]);
  });

  it("tells the prompt builder how long it's been since the herder's last message, not just that history exists", async () => {
    // Regression test for a real incident (2026-08-06): a tester sent
    // only "Uko on?" (are you there?) 4.5 hours after a conversation
    // about a water point, and got the exact same water-point fact
    // re-dumped verbatim — the LLM had no signal that real time had
    // passed, so it "picked up naturally" from stale history exactly as
    // instructed. gapMinutes must be computed and passed through so the
    // prompt builder can tell the model to respond fresh instead.
    const fourAndHalfHoursAgo = new Date(Date.now() - 4.5 * 60 * 60 * 1000).toISOString();
    fx.history = [
      { direction: "in", message_type: "text", body_text: "na zingine uko nazo ni gani", occurred_at: fourAndHalfHoursAgo },
      { direction: "out", message_type: "text", body_text: "Nilikagua data yako...", occurred_at: fourAndHalfHoursAgo },
    ];
    const res = await request(app)
      .post("/api/whatsapp-webhook")
      .send(webhookBody({ type: "text", text: { body: "Uko on?" } }));
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 0));
    const systemMessage = fx.lastCompleteMessages.find((m) => m.role === "system");
    const match = systemMessage?.content.match(/gapMinutes=([\d.]+)/);
    expect(match).not.toBeNull();
    const gapMinutes = Number(match?.[1]);
    expect(gapMinutes).toBeGreaterThan(29); // past the 30-minute "stale thread" threshold
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

  describe("WhatsApp self-registration (Phase 2)", () => {
    it("starts registration on the JISAJILI keyword and asks for a name", async () => {
      const res = await request(app)
        .post("/api/whatsapp-webhook")
        .send(webhookBody({ type: "text", text: { body: "JISAJILI" } }));
      expect(res.status).toBe(200);
      await new Promise((r) => setTimeout(r, 0));
      expect(fx.sentSessionMessages).toHaveLength(1);
      expect(fx.sentSessionMessages[0].text).toMatch(/jina lako/i);
      expect(fx.registrationState).toMatchObject({ step: "ask_name" });
    });

    it("walks name -> ward -> language -> save across separate turns, never touching the LLM", async () => {
      fx.registrationState = { step: "ask_name" };
      let res = await request(app)
        .post("/api/whatsapp-webhook")
        .send(webhookBody({ type: "text", text: { body: "Amina Wanjiku" } }));
      expect(res.status).toBe(200);
      await new Promise((r) => setTimeout(r, 0));
      expect(fx.registrationState).toMatchObject({
        step: "ask_ward",
        draftFullName: "Amina Wanjiku",
      });
      expect(fx.sentSessionMessages.at(-1)?.text).toContain("Ngare Mara");

      res = await request(app)
        .post("/api/whatsapp-webhook")
        .send(webhookBody({ type: "text", text: { body: "3" } })); // 3 = Ngare Mara
      expect(res.status).toBe(200);
      await new Promise((r) => setTimeout(r, 0));
      expect(fx.registrationState).toMatchObject({
        step: "ask_language",
        draftWardId: "245",
      });

      res = await request(app)
        .post("/api/whatsapp-webhook")
        .send(webhookBody({ type: "text", text: { body: "1" } })); // 1 = Kiswahili
      expect(res.status).toBe(200);
      await new Promise((r) => setTimeout(r, 0));

      expect(fx.upsertedLeads).toHaveLength(1);
      expect(fx.upsertedLeads[0]).toMatchObject({
        full_name: "Amina Wanjiku",
        ward_id: "245",
        preferred_language: "sw",
        enrollment_source: "whatsapp_self",
      });
      expect(fx.setCurrentLocationCalls).toHaveLength(1);
      expect(fx.setCurrentLocationCalls[0]).toMatchObject({
        wardId: "245",
        source: "whatsapp_registration",
        confidence: "low",
      });
      expect(fx.registrationState).toBeNull();
      expect(fx.lastCompleteMessages).toHaveLength(0);
    });

    it("re-prompts instead of crashing on an invalid ward digit", async () => {
      fx.registrationState = { step: "ask_ward", draftFullName: "Test" };
      const res = await request(app)
        .post("/api/whatsapp-webhook")
        .send(webhookBody({ type: "text", text: { body: "9" } }));
      expect(res.status).toBe(200);
      await new Promise((r) => setTimeout(r, 0));
      expect(fx.registrationState).toMatchObject({ step: "ask_ward" });
      expect(fx.upsertedLeads).toHaveLength(0);
    });

    it("still escapes to the plain menu on MSAADA mid-registration", async () => {
      fx.registrationState = { step: "ask_ward", draftFullName: "Test" };
      const res = await request(app)
        .post("/api/whatsapp-webhook")
        .send(webhookBody({ type: "text", text: { body: "MSAADA" } }));
      expect(res.status).toBe(200);
      await new Promise((r) => setTimeout(r, 0));
      expect(fx.sentButtons).toHaveLength(1);
      // The registration mock never clears state on its own for this
      // path (MENU_KEYWORDS returns before handleRegistrationTurn is
      // ever reached) — state is left as-is, exactly as a real herder
      // resuming registration afterward would expect.
      expect(fx.registrationState).toMatchObject({ step: "ask_ward" });
    });
  });

  describe("directions from anywhere (Phase 3)", () => {
    it("resolves a different named ward's real facts when the herder asks about it, not their own", async () => {
      // fx.ctx.wardId defaults to "242" (Bulla Pesa) — herder asks about
      // Ngare Mara ("245") instead.
      fx.wards = [
        { ward_id: "242", name: "Bulla Pesa" },
        { ward_id: "245", name: "Ngare Mara" },
      ];
      fx.satelliteByWard = { "245": { ndvi_mean: 0.31, vci_value: 42 } };
      fx.centroidByWard = { "245": { lat: 0.6614, lon: 37.904 } };
      const res = await request(app)
        .post("/api/whatsapp-webhook")
        .send(webhookBody({ type: "text", text: { body: "Kuna maji Ngare Mara?" } }));
      expect(res.status).toBe(200);
      await new Promise((r) => setTimeout(r, 0));
      const systemMessage = fx.lastCompleteMessages.find((m) => m.role === "system");
      expect(systemMessage?.content).toContain("queryWard=245(Ngare Mara)");
    });

    it("never triggers a query-ward resolution when the herder doesn't name a different ward", async () => {
      const res = await request(app)
        .post("/api/whatsapp-webhook")
        .send(webhookBody({ type: "text", text: { body: "Ng'ombe wangu ni wagonjwa" } }));
      expect(res.status).toBe(200);
      await new Promise((r) => setTimeout(r, 0));
      const systemMessage = fx.lastCompleteMessages.find((m) => m.role === "system");
      expect(systemMessage?.content).not.toContain("queryWard=");
    });
  });
});
