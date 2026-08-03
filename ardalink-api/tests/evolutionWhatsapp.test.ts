import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import { fromEvolutionWebhook } from "../src/routes/evolutionWhatsapp";

/**
 * Two halves, mirroring tests/whatsapp.test.ts's convention:
 *
 * 1. Pure unit tests on fromEvolutionWebhook() — no Express, no mocks —
 *    covering the CONFIRMED plain-text shape rigorously and the
 *    UNVERIFIED list/button/location/audio shapes with a comment making
 *    clear they're provisional (see evolutionWhatsapp.ts's docstring).
 *
 * 2. Route-level tests mounting just the Evolution router on a bare
 *    express() app, with every collaborator mocked at module level, same
 *    as tests/whatsapp.test.ts does for the 360dialog route.
 */

describe("fromEvolutionWebhook", () => {
  it("parses a plain-text messages.upsert into a normalized text message (confirmed shape)", () => {
    const result = fromEvolutionWebhook({
      event: "messages.upsert",
      instance: "ardalink-dev",
      data: {
        key: { id: "wamid.HBg1", remoteJid: "254712345678@s.whatsapp.net", fromMe: false },
        message: { conversation: "Ng'ombe wangu ni wagonjwa" },
        messageType: "conversation",
      },
    });
    expect(result).toMatchObject({
      from: "+254712345678",
      type: "text",
      text: "Ng'ombe wangu ni wagonjwa",
    });
  });

  it("ignores echoes of our own sends (fromMe: true)", () => {
    const result = fromEvolutionWebhook({
      event: "messages.upsert",
      data: {
        key: { id: "wamid.HBg2", remoteJid: "254712345678@s.whatsapp.net", fromMe: true },
        message: { conversation: "our own reply" },
      },
    });
    expect(result).toBeNull();
  });

  it("parses a messages.update delivery-status event", () => {
    const result = fromEvolutionWebhook({
      event: "messages.update",
      data: {
        keyId: "wamid.HBg1",
        remoteJid: "254712345678@s.whatsapp.net",
        status: "DELIVERED",
      },
    });
    expect(result).toMatchObject({
      from: "+254712345678",
      type: "status",
      status: { id: "wamid.HBg1", status: "DELIVERED", recipientId: "254712345678@s.whatsapp.net" },
    });
  });

  it("returns null for an unrecognized event", () => {
    expect(fromEvolutionWebhook({ event: "connection.update", data: {} })).toBeNull();
    expect(fromEvolutionWebhook({})).toBeNull();
  });

  // UNVERIFIED shapes below — inferred from general Baileys protocol
  // knowledge, not confirmed against Evolution's source or a live
  // instance. Update these if they fail against a real deployment.
  it("parses a list-reply (shape unverified)", () => {
    const result = fromEvolutionWebhook({
      event: "messages.upsert",
      data: {
        key: { remoteJid: "254712345678@s.whatsapp.net", fromMe: false },
        message: {
          listResponseMessage: { singleSelectReply: { selectedRowId: "bula_pesa" } },
        },
      },
    });
    expect(result).toMatchObject({ type: "list_reply", replyId: "bula_pesa" });
  });

  it("parses a button-reply (shape unverified)", () => {
    const result = fromEvolutionWebhook({
      event: "messages.upsert",
      data: {
        key: { remoteJid: "254712345678@s.whatsapp.net", fromMe: false },
        message: { buttonsResponseMessage: { selectedButtonId: "ongea_na_ai" } },
      },
    });
    expect(result).toMatchObject({ type: "button_reply", replyId: "ongea_na_ai" });
  });

  it("parses a static location share (verified against a real payload)", () => {
    const result = fromEvolutionWebhook({
      event: "messages.upsert",
      data: {
        key: { remoteJid: "254712345678@s.whatsapp.net", fromMe: false },
        message: {
          locationMessage: { degreesLatitude: 0.34, degreesLongitude: 37.58 },
        },
      },
    });
    expect(result).toMatchObject({ type: "location", location: { lat: 0.34, lon: 37.58 } });
  });

  it("parses a live location share the same way as a static one", () => {
    // Evolution's own compiled webhook formatter (checked directly
    // against the running v2.3.7 container) treats locationMessage and
    // liveLocationMessage identically, reading the same
    // degreesLatitude/degreesLongitude fields off either — this was
    // previously not handled at all, so tapping "Share Live Location"
    // instead of "Send Current Location" silently dropped the message.
    const result = fromEvolutionWebhook({
      event: "messages.upsert",
      data: {
        key: { remoteJid: "254712345678@s.whatsapp.net", fromMe: false },
        message: {
          liveLocationMessage: { degreesLatitude: 0.3532143, degreesLongitude: 37.5830788 },
        },
      },
    });
    expect(result).toMatchObject({
      type: "location",
      location: { lat: 0.3532143, lon: 37.5830788 },
    });
  });

  it("normalizes a group JID (@g.us) without leaking the suffix into phone_number", () => {
    const result = fromEvolutionWebhook({
      event: "messages.upsert",
      data: {
        key: { remoteJid: "120363426513200023@g.us", fromMe: false },
        message: { conversation: "hello" },
      },
    });
    expect(result?.from).toBe("+120363426513200023");
  });

  it("normalizes a status callback's @lid JID the same way as a message JID", () => {
    const result = fromEvolutionWebhook({
      event: "messages.update",
      data: { remoteJid: "148013565612164@lid", keyId: "ABC123", status: "DELIVERY_ACK" },
    });
    expect(result?.from).toBe("+148013565612164");
  });

  it("parses an audio message (shape unverified)", () => {
    const result = fromEvolutionWebhook({
      event: "messages.upsert",
      data: {
        key: { remoteJid: "254712345678@s.whatsapp.net", fromMe: false },
        message: { audioMessage: { mimetype: "audio/ogg" } },
      },
    });
    expect(result).toMatchObject({ type: "audio" });
  });
});

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
  loggedMessages: Array<Record<string, unknown>>;
  sentButtons: Array<{ phone: string }>;
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
  hasPrior: false,
  loggedMessages: [],
  sentButtons: [],
};

vi.mock("../src/lib/herderContext/index.js", () => ({
  resolveHerderContext: async () => fx.ctx,
  buildLocalizedBrief: () => "brief",
}));
vi.mock("../src/lib/voiceCopy.js", () => ({ languageForCaller: () => fx.lang }));
vi.mock("../src/lib/wpdx.js", () => ({
  centroidForTenant: () => ({ lat: 0.3453, lon: 37.581 }),
  nearestWorkingKnownPoints: () => [],
}));
vi.mock("../src/lib/whatsappProviderRegistry.js", () => ({
  sendWhatsappSessionMessage: async () => ({ ok: true, messageId: "wamid.test" }),
  sendWhatsappInteractiveButtons: async (phone: string) => {
    fx.sentButtons.push({ phone });
    return { ok: true, messageId: "wamid.buttons" };
  },
  sendWhatsappLocation: async () => ({ ok: true, messageId: "wamid.loc" }),
}));
vi.mock("../src/lib/supabase/index.js", () => ({
  logWhatsappMessage: async (row: Record<string, unknown>) => {
    fx.loggedMessages.push(row);
  },
  hasPriorWhatsappMessages: async () => fx.hasPrior,
  recentWhatsappMessages: async () => [],
  insertGroundTruthCall: async () => ({ call_id: "c1", call_timestamp: "now" }),
  isSupabaseConfigured: () => true,
  logLeadInteraction: async () => undefined,
  setLeadStatus: async () => true,
  markPastoralistOptedOut: async () => true,
}));
vi.mock("../src/lib/openai/index.js", () => ({
  extractIndicators: async () => null,
  generateActionTag: async () => "Report",
}));
vi.mock("../src/lib/trustScore.js", () => ({
  computeTrustScore: () => ({ score: 70, flags: [] }),
  logTrustScore: vi.fn(),
}));
vi.mock("../src/lib/pastoralistContact.js", () => ({
  touchPastoralistLastContact: vi.fn(async () => undefined),
}));
vi.mock("../src/lib/intelligence.js", () => ({ getLastResult: () => null }));
vi.mock("../src/lib/grazingRingPending.js", () => ({
  upsertPendingLocation: async () => {},
  getPendingLocation: async () => null,
  clearPendingLocation: async () => {},
}));
vi.mock("../src/lib/engine.js", () => ({
  fetchGrazingAdvisory: async () => null,
}));

let app: Express;

beforeEach(async () => {
  fx.hasPrior = false;
  fx.loggedMessages = [];
  fx.sentButtons = [];
  const { default: evolutionWhatsappRouter } = await import(
    "../src/routes/evolutionWhatsapp.js"
  );
  app = express();
  app.use(express.json());
  app.use("/api", evolutionWhatsappRouter);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/evolution-whatsapp-webhook", () => {
  it("processes a text message and logs it via the shared handler", async () => {
    const res = await request(app)
      .post("/api/evolution-whatsapp-webhook")
      .send({
        event: "messages.upsert",
        data: {
          key: { id: "wamid.1", remoteJid: "254712345699@s.whatsapp.net", fromMe: false },
          message: { conversation: "hi" },
        },
      });
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 0));
    expect(fx.sentButtons).toHaveLength(1);
    expect(fx.sentButtons[0].phone).toBe("+254712345699");
  });

  it("returns 200 and does nothing for an unrecognized/echo payload", async () => {
    const res = await request(app).post("/api/evolution-whatsapp-webhook").send({
      event: "messages.upsert",
      data: { key: { remoteJid: "254712345699@s.whatsapp.net", fromMe: true } },
    });
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 0));
    expect(fx.sentButtons).toHaveLength(0);
  });
});
