/**
 * Unit tests for the outbound Evolution API client. Zero real network —
 * the global fetch is mocked per-test so we can inspect exactly what
 * shape reaches Evolution and how the client interprets each response.
 * Mirrors tests/threeSixtyDialog.test.ts's structure/conventions.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  sendWhatsappSessionMessage,
  sendWhatsappTemplate,
  sendWhatsappInteractiveList,
  sendWhatsappInteractiveButtons,
  sendWhatsappLocation,
  isEvolutionApiConfigured,
  _resetRateLimits,
} from "../src/lib/evolutionApi";

const originalFetch = globalThis.fetch;

function mockFetch(
  handler: (req: Request | URL, init?: RequestInit) => Response | Promise<Response>,
) {
  globalThis.fetch = vi.fn(handler as unknown as typeof fetch) as unknown as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  _resetRateLimits();
  vi.stubEnv("EVOLUTION_API_KEY", "test-key");
  vi.stubEnv("EVOLUTION_INSTANCE_NAME", "ardalink-dev");
  vi.stubEnv("EVOLUTION_API_BASE_URL", "http://localhost:8080");
  vi.stubEnv("WA_OUTBOUND_ENABLED", "true");
  // WA_TEMPLATE_DAILY_CAP / WA_SESSION_MSG_PER_HOUR_CAP are read once at
  // module load (same gotcha as threeSixtyDialog.ts) — these stubs only
  // matter if they happen to match the module's already-loaded default;
  // tests below exercise the fallback defaults (1 and 20) directly.
  vi.stubEnv("WA_TEMPLATE_DAILY_CAP", "1");
  vi.stubEnv("WA_SESSION_MSG_PER_HOUR_CAP", "20");
});

afterEach(() => {
  vi.unstubAllEnvs();
  globalThis.fetch = originalFetch;
});

describe("isEvolutionApiConfigured", () => {
  it("returns true when api key + instance name are set", () => {
    expect(isEvolutionApiConfigured()).toBe(true);
  });

  it("returns false when unset", () => {
    vi.stubEnv("EVOLUTION_API_KEY", "");
    vi.stubEnv("EVOLUTION_INSTANCE_NAME", "");
    expect(isEvolutionApiConfigured()).toBe(false);
  });
});

describe("sendWhatsappSessionMessage", () => {
  it("posts to /message/sendText/:instance with digits-only number", async () => {
    let capturedUrl = "";
    let capturedBody: Record<string, unknown> = {};
    let capturedHeaders: Record<string, string> = {};
    mockFetch(async (req, init) => {
      capturedUrl = typeof req === "string" ? req : req.toString();
      capturedBody = JSON.parse(String(init?.body ?? "{}"));
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
      return jsonResponse({ key: { id: "wamid.test1" }, status: "PENDING" });
    });

    const result = await sendWhatsappSessionMessage("+254712345678", "Habari");
    expect(result.ok).toBe(true);
    expect(result.messageId).toBe("wamid.test1");
    expect(capturedUrl).toBe("http://localhost:8080/message/sendText/ardalink-dev");
    expect(capturedHeaders.apikey).toBe("test-key");
    expect(capturedBody).toMatchObject({ number: "254712345678", text: "Habari" });
  });

  it("returns skipped=disabled without dispatching when kill switch is off", async () => {
    vi.stubEnv("WA_OUTBOUND_ENABLED", "false");
    let called = false;
    mockFetch(async () => {
      called = true;
      return jsonResponse({});
    });
    const result = await sendWhatsappSessionMessage("+254712345678", "hi");
    expect(result).toEqual({ ok: false, skipped: true, reason: "disabled" });
    expect(called).toBe(false);
  });

  it("returns not_configured when credentials are missing", async () => {
    vi.stubEnv("EVOLUTION_API_KEY", "");
    vi.stubEnv("EVOLUTION_INSTANCE_NAME", "");
    let called = false;
    mockFetch(async () => {
      called = true;
      return jsonResponse({});
    });
    const result = await sendWhatsappSessionMessage("+254712345678", "hi");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("not_configured");
    expect(called).toBe(false);
  });

  it("hits the hourly cap after the configured number of dispatches", async () => {
    // WA_SESSION_MSG_PER_HOUR_CAP is read once at module load (same
    // module-scope-const pattern as threeSixtyDialog.ts's rate caps), so
    // re-stubbing the env mid-test has no effect — exercise the
    // fallback default (20) instead of trying to override it.
    mockFetch(async () => jsonResponse({ key: { id: "x" } }));
    const phone = "+254712345678";
    for (let i = 0; i < 20; i++) {
      const r = await sendWhatsappSessionMessage(phone, `msg-${i}`);
      expect(r.ok).toBe(true);
    }
    const capped = await sendWhatsappSessionMessage(phone, "one-too-many");
    expect(capped.ok).toBe(false);
    expect(capped.reason).toBe("rate_limited");
  });

  it("returns network_error when fetch throws", async () => {
    mockFetch(async () => {
      throw new Error("dns failed");
    });
    const r = await sendWhatsappSessionMessage("+254712345678", "x");
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("network_error");
  });

  it("maps a non-2xx to the generic wa_error reason (no outside-window detection — known gap)", async () => {
    mockFetch(async () =>
      jsonResponse({ message: "Bad Request", statusCode: 400 }, 400),
    );
    const r = await sendWhatsappSessionMessage("+254712345678", "x");
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("wa_error");
  });
});

describe("sendWhatsappTemplate", () => {
  it("passes components through unchanged to /message/sendTemplate/:instance", async () => {
    let capturedBody: Record<string, unknown> = {};
    mockFetch(async (_req, init) => {
      capturedBody = JSON.parse(String(init?.body ?? "{}"));
      return jsonResponse({ key: { id: "wamid.tmpl1" } });
    });

    const components = [
      { type: "body" as const, parameters: [{ type: "text" as const, text: "Bula Pesa" }] },
    ];
    const result = await sendWhatsappTemplate(
      "+254712345678",
      "drought_alert_utility",
      "sw",
      components,
      { tier: "verified" },
    );
    expect(result.ok).toBe(true);
    expect(capturedBody).toMatchObject({
      number: "254712345678",
      name: "drought_alert_utility",
      language: "sw",
      components,
    });
  });

  it("refuses to send when tier is unknown", async () => {
    let called = false;
    mockFetch(async () => {
      called = true;
      return jsonResponse({ key: { id: "x" } });
    });
    const result = await sendWhatsappTemplate(
      "+254712345678",
      "drought_alert_utility",
      "sw",
      [],
      { tier: "unknown" },
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("unknown_tier");
    expect(called).toBe(false);
  });

  it("hits the daily cap after WA_TEMPLATE_DAILY_CAP dispatches", async () => {
    mockFetch(async () => jsonResponse({ key: { id: "x" } }));
    const phone = "+254712345678";
    const first = await sendWhatsappTemplate(phone, "t", "sw", []);
    const second = await sendWhatsappTemplate(phone, "t", "sw", []);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    expect(second.reason).toBe("rate_limited");
  });

  it("bypasses the cap when opts.bypassRateLimit is set", async () => {
    mockFetch(async () => jsonResponse({ key: { id: "x" } }));
    const phone = "+254712345678";
    await sendWhatsappTemplate(phone, "t", "sw", []);
    const bypass = await sendWhatsappTemplate(phone, "t", "sw", [], {
      bypassRateLimit: true,
    });
    expect(bypass.ok).toBe(true);
  });
});

describe("sendWhatsappInteractiveList", () => {
  it("remaps WaListSection's rows[].id to Evolution's rowId", async () => {
    let capturedBody: {
      sections?: Array<{ rows: Array<{ rowId?: string; title?: string }> }>;
    } = {};
    mockFetch(async (_req, init) => {
      capturedBody = JSON.parse(String(init?.body ?? "{}"));
      return jsonResponse({ key: { id: "wamid.list1" } });
    });
    const result = await sendWhatsappInteractiveList(
      "+254712345678",
      "Karibu ArdaLink",
      "Chagua huduma",
      "Chagua",
      [{ title: "Huduma", rows: [{ id: "bula_pesa", title: "Bula Pesa" }] }],
    );
    expect(result.ok).toBe(true);
    expect(capturedBody.sections?.[0]?.rows?.[0]?.rowId).toBe("bula_pesa");
    expect(capturedBody.sections?.[0]?.rows?.[0]?.title).toBe("Bula Pesa");
  });
});

describe("sendWhatsappInteractiveButtons", () => {
  it("remaps {id,title} to Evolution's {type:reply, displayText, id}, capped at 3", async () => {
    let capturedBody: {
      buttons?: Array<{ type?: string; displayText?: string; id?: string }>;
    } = {};
    mockFetch(async (_req, init) => {
      capturedBody = JSON.parse(String(init?.body ?? "{}"));
      return jsonResponse({ key: { id: "wamid.btn1" } });
    });
    const result = await sendWhatsappInteractiveButtons("+254712345678", "Pick one", [
      { id: "a", title: "A" },
      { id: "b", title: "B" },
      { id: "c", title: "C" },
      { id: "d", title: "D" },
    ]);
    expect(result.ok).toBe(true);
    expect(capturedBody.buttons?.length).toBe(3);
    expect(capturedBody.buttons?.[0]).toMatchObject({
      type: "reply",
      displayText: "A",
      id: "a",
    });
  });
});

describe("sendWhatsappLocation", () => {
  it("posts unchanged field names to /message/sendLocation/:instance", async () => {
    let capturedBody: Record<string, unknown> = {};
    mockFetch(async (_req, init) => {
      capturedBody = JSON.parse(String(init?.body ?? "{}"));
      return jsonResponse({ key: { id: "wamid.loc1" } });
    });
    const result = await sendWhatsappLocation(
      "+254712345678",
      0.3453,
      37.581,
      "Bula Pesa Dam",
      "near Bula Pesa center",
    );
    expect(result.ok).toBe(true);
    expect(capturedBody).toMatchObject({
      number: "254712345678",
      latitude: 0.3453,
      longitude: 37.581,
      name: "Bula Pesa Dam",
      address: "near Bula Pesa center",
    });
  });
});
