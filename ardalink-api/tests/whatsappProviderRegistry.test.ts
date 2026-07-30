import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Mock both concrete provider modules so we can assert the registry
 * dispatches to exactly one of them based on WA_PROVIDER, without any
 * real network activity.
 */
const calls: { provider: string; fn: string }[] = [];

vi.mock("../src/lib/threeSixtyDialog.js", () => ({
  threeSixtyDialogProvider: {
    isConfigured: () => {
      calls.push({ provider: "360dialog", fn: "isConfigured" });
      return true;
    },
    sendWhatsappSessionMessage: async () => {
      calls.push({ provider: "360dialog", fn: "sendWhatsappSessionMessage" });
      return { ok: true, messageId: "360dialog-msg" };
    },
    sendWhatsappTemplate: async () => ({ ok: true }),
    sendWhatsappInteractiveList: async () => ({ ok: true }),
    sendWhatsappInteractiveButtons: async () => ({ ok: true }),
    sendWhatsappLocation: async () => ({ ok: true }),
  },
}));

vi.mock("../src/lib/evolutionApi.js", () => ({
  evolutionApiProvider: {
    isConfigured: () => {
      calls.push({ provider: "evolution", fn: "isConfigured" });
      return true;
    },
    sendWhatsappSessionMessage: async () => {
      calls.push({ provider: "evolution", fn: "sendWhatsappSessionMessage" });
      return { ok: true, messageId: "evolution-msg" };
    },
    sendWhatsappTemplate: async () => ({ ok: true }),
    sendWhatsappInteractiveList: async () => ({ ok: true }),
    sendWhatsappInteractiveButtons: async () => ({ ok: true }),
    sendWhatsappLocation: async () => ({ ok: true }),
  },
}));

import {
  activeWhatsappProvider,
  sendWhatsappSessionMessage,
  isWhatsappConfigured,
} from "../src/lib/whatsappProviderRegistry";

beforeEach(() => {
  calls.length = 0;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("activeWhatsappProvider", () => {
  it("defaults to 360dialog when WA_PROVIDER is unset", () => {
    vi.stubEnv("WA_PROVIDER", "");
    expect(isWhatsappConfigured()).toBe(true);
    expect(calls).toEqual([{ provider: "360dialog", fn: "isConfigured" }]);
  });

  it("selects evolution when WA_PROVIDER=evolution", () => {
    vi.stubEnv("WA_PROVIDER", "evolution");
    isWhatsappConfigured();
    expect(calls).toEqual([{ provider: "evolution", fn: "isConfigured" }]);
  });

  it("is case-insensitive", () => {
    vi.stubEnv("WA_PROVIDER", "EVOLUTION");
    isWhatsappConfigured();
    expect(calls).toEqual([{ provider: "evolution", fn: "isConfigured" }]);
  });

  it("falls back to 360dialog for an invalid value", () => {
    vi.stubEnv("WA_PROVIDER", "bogus");
    isWhatsappConfigured();
    expect(calls).toEqual([{ provider: "360dialog", fn: "isConfigured" }]);
  });
});

describe("re-exported bound functions", () => {
  it("sendWhatsappSessionMessage delegates to the active provider only", async () => {
    vi.stubEnv("WA_PROVIDER", "evolution");
    const result = await sendWhatsappSessionMessage("+254712345678", "hi");
    expect(result.messageId).toBe("evolution-msg");
    expect(calls).toEqual([
      { provider: "evolution", fn: "sendWhatsappSessionMessage" },
    ]);
  });

  it("switching WA_PROVIDER between calls switches the active provider", async () => {
    vi.stubEnv("WA_PROVIDER", "360dialog");
    await sendWhatsappSessionMessage("+254712345678", "a");
    vi.stubEnv("WA_PROVIDER", "evolution");
    await sendWhatsappSessionMessage("+254712345678", "b");
    expect(calls.map((c) => c.provider)).toEqual(["360dialog", "evolution"]);
  });
});

describe("activeWhatsappProvider()", () => {
  it("returns an object satisfying the full WhatsappProvider shape", () => {
    const provider = activeWhatsappProvider();
    expect(typeof provider.isConfigured).toBe("function");
    expect(typeof provider.sendWhatsappSessionMessage).toBe("function");
    expect(typeof provider.sendWhatsappTemplate).toBe("function");
    expect(typeof provider.sendWhatsappInteractiveList).toBe("function");
    expect(typeof provider.sendWhatsappInteractiveButtons).toBe("function");
    expect(typeof provider.sendWhatsappLocation).toBe("function");
  });
});
