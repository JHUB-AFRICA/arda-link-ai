import { describe, expect, it, vi, beforeEach } from "vitest";

// Mirrors pastoralistContact.test.ts's convention: mock the whole
// @workspace/db module so we don't need a live Postgres, capturing the
// SELECT filter + UPDATE payload/WHERE shape as plain objects.

interface Fx {
  selectResult: Array<{ channelTier: string; lastTierCheckAt: Date | null }>;
  templateResult: {
    ok: boolean;
    reason?: string;
    waResponse?: unknown;
  };
}
const fx: Fx = {
  selectResult: [],
  templateResult: { ok: true },
};

interface CapturedUpdate {
  set: Record<string, unknown> | null;
}
const captured: CapturedUpdate = { set: null };

vi.mock("@workspace/db", () => ({
  db: {
    select: (_cols: unknown) => ({
      from: (_table: unknown) => ({
        where: (_whereExpr: unknown) => ({
          limit: (_n: number) => Promise.resolve(fx.selectResult),
        }),
      }),
    }),
    update: (_table: unknown) => ({
      set: (payload: Record<string, unknown>) => {
        captured.set = payload;
        return { where: (_whereExpr: unknown) => Promise.resolve(undefined) };
      },
    }),
  },
  pastoralistsTable: {
    phone: { columnName: "phone" },
    channelTier: { columnName: "channel_tier" },
    lastTierCheckAt: { columnName: "last_tier_check_at" },
  },
}));

vi.mock("drizzle-orm", async () => {
  const actual = await vi.importActual<typeof import("drizzle-orm")>("drizzle-orm");
  return { ...actual, eq: (column: unknown, value: unknown) => ({ column, value }) };
});

vi.mock("../src/lib/whatsappProviderRegistry.js", () => ({
  sendWhatsappTemplate: async () => fx.templateResult,
}));

import { resolveChannelTier, ensureChannelTierFresh } from "../src/lib/channelTier.js";

describe("resolveChannelTier", () => {
  beforeEach(() => {
    captured.set = null;
    fx.selectResult = [];
    fx.templateResult = { ok: true };
  });

  it("does not probe when last_tier_check_at is fresh (<30 days)", async () => {
    fx.selectResult = [
      { channelTier: "whatsapp", lastTierCheckAt: new Date() },
    ];
    const result = await resolveChannelTier("+254712345678");
    expect(result).toEqual({ tier: "whatsapp", probed: false });
    expect(captured.set).toBeNull();
  });

  it("probes when last_tier_check_at is null (never checked)", async () => {
    fx.selectResult = [{ channelTier: "sms", lastTierCheckAt: null }];
    fx.templateResult = { ok: true };
    const result = await resolveChannelTier("+254712345678");
    expect(result.probed).toBe(true);
    expect(result.tier).toBe("whatsapp");
    expect(captured.set).toMatchObject({ channelTier: "whatsapp" });
  });

  it("probes when last_tier_check_at is >30 days stale", async () => {
    const staleDate = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    fx.selectResult = [{ channelTier: "whatsapp", lastTierCheckAt: staleDate }];
    fx.templateResult = { ok: true };
    const result = await resolveChannelTier("+254712345678");
    expect(result.probed).toBe(true);
  });

  it("downgrades to voice when the probe reports recipient not on WhatsApp", async () => {
    fx.selectResult = [{ channelTier: "whatsapp", lastTierCheckAt: null }];
    fx.templateResult = {
      ok: false,
      reason: "wa_error",
      waResponse: { error: { code: 131026 } },
    };
    const result = await resolveChannelTier("+254712345678");
    expect(result.tier).toBe("voice");
    expect(captured.set).toMatchObject({ channelTier: "voice" });
  });

  it("keeps whatsapp tier when the probe is merely rate-limited", async () => {
    fx.selectResult = [{ channelTier: "whatsapp", lastTierCheckAt: null }];
    fx.templateResult = { ok: false, reason: "rate_limited" };
    const result = await resolveChannelTier("+254712345678");
    expect(result.tier).toBe("whatsapp");
  });

  it("defaults to sms tier for a phone with no existing row", async () => {
    fx.selectResult = [];
    fx.templateResult = { ok: true };
    const result = await resolveChannelTier("+254799999999");
    // No existing row → currentTier defaults to 'sms', but the probe
    // still runs (isStale(null) === true) and sets the resolved tier.
    expect(result.probed).toBe(true);
  });
});

describe("ensureChannelTierFresh", () => {
  it("resolves without throwing", async () => {
    fx.selectResult = [{ channelTier: "whatsapp", lastTierCheckAt: new Date() }];
    await expect(ensureChannelTierFresh("+254712345678")).resolves.toBeUndefined();
  });
});
