/**
 * Unit tests for the outbound 360dialog client. Zero real network —
 * the global fetch is mocked per-test so we can inspect exactly what
 * shape reaches 360dialog and how the client interprets each response.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  sendWhatsappSessionMessage,
  sendWhatsappTemplate,
  sendWhatsappInteractiveList,
  sendWhatsappInteractiveButtons,
  sendWhatsappLocation,
  isThreeSixtyDialogConfigured,
  _resetRateLimits,
} from "../src/lib/threeSixtyDialog";

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
  vi.stubEnv("THREESIXTYDIALOG_API_KEY", "test-key");
  vi.stubEnv("THREESIXTYDIALOG_PHONE_NUMBER_ID", "phone-id-123");
  vi.stubEnv("THREESIXTYDIALOG_BASE_URL", "https://waba-v2.360dialog.io");
  vi.stubEnv("WA_OUTBOUND_ENABLED", "true");
  vi.stubEnv("WA_TEMPLATE_DAILY_CAP", "1");
  vi.stubEnv("WA_SESSION_MSG_PER_HOUR_CAP", "20");
});

afterEach(() => {
  vi.unstubAllEnvs();
  globalThis.fetch = originalFetch;
});

describe("isThreeSixtyDialogConfigured", () => {
  it("returns true when api key + phone number id are set", () => {
    expect(isThreeSixtyDialogConfigured()).toBe(true);
  });

  it("returns false when unset", () => {
    vi.stubEnv("THREESIXTYDIALOG_API_KEY", "");
    vi.stubEnv("THREESIXTYDIALOG_PHONE_NUMBER_ID", "");
    expect(isThreeSixtyDialogConfigured()).toBe(false);
  });
});

describe("sendWhatsappSessionMessage", () => {
  it("posts a text payload with the D360-API-KEY header", async () => {
    let capturedUrl = "";
    let capturedBody: Record<string, unknown> = {};
    let capturedHeaders: Record<string, string> = {};
    mockFetch(async (req, init) => {
      capturedUrl = typeof req === "string" ? req : req.toString();
      capturedBody = JSON.parse(String(init?.body ?? "{}"));
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
      return jsonResponse({ messages: [{ id: "wamid.test1" }] });
    });

    const result = await sendWhatsappSessionMessage("+254712345678", "Habari");
    expect(result.ok).toBe(true);
    expect(result.messageId).toBe("wamid.test1");
    expect(capturedUrl).toBe("https://waba-v2.360dialog.io/messages");
    expect(capturedHeaders["D360-API-KEY"]).toBe("test-key");
    expect(capturedBody).toMatchObject({
      messaging_product: "whatsapp",
      to: "+254712345678",
      type: "text",
      text: { body: "Habari" },
    });
  });

  it("maps Meta's outside-window error code to reason:outside_session_window", async () => {
    mockFetch(async () =>
      jsonResponse({ error: { message: "outside window", code: 131047 } }, 400),
    );
    const result = await sendWhatsappSessionMessage("+254712345678", "hi");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("outside_session_window");
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
    vi.stubEnv("THREESIXTYDIALOG_API_KEY", "");
    vi.stubEnv("THREESIXTYDIALOG_PHONE_NUMBER_ID", "");
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
    // module-scope-const pattern as africastalking.ts's rate caps), so
    // re-stubbing the env mid-test has no effect — exercise the
    // fallback default (20) instead of trying to override it.
    mockFetch(async () => jsonResponse({ messages: [{ id: "x" }] }));
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
});

describe("sendWhatsappTemplate", () => {
  it("posts a template payload with components", async () => {
    let capturedBody: Record<string, unknown> = {};
    mockFetch(async (_req, init) => {
      capturedBody = JSON.parse(String(init?.body ?? "{}"));
      return jsonResponse({ messages: [{ id: "wamid.tmpl1" }] });
    });

    const result = await sendWhatsappTemplate(
      "+254712345678",
      "drought_alert_utility",
      "sw",
      [{ type: "body", parameters: [{ type: "text", text: "Bula Pesa" }] }],
      { tier: "verified" },
    );
    expect(result.ok).toBe(true);
    expect(capturedBody).toMatchObject({
      type: "template",
      template: {
        name: "drought_alert_utility",
        language: { code: "sw" },
      },
    });
  });

  it("refuses to send when tier is unknown", async () => {
    let called = false;
    mockFetch(async () => {
      called = true;
      return jsonResponse({ messages: [{ id: "x" }] });
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
    mockFetch(async () => jsonResponse({ messages: [{ id: "x" }] }));
    const phone = "+254712345678";
    const first = await sendWhatsappTemplate(phone, "t", "sw", []);
    const second = await sendWhatsappTemplate(phone, "t", "sw", []);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    expect(second.reason).toBe("rate_limited");
  });

  it("bypasses the cap when opts.bypassRateLimit is set", async () => {
    mockFetch(async () => jsonResponse({ messages: [{ id: "x" }] }));
    const phone = "+254712345678";
    await sendWhatsappTemplate(phone, "t", "sw", []);
    const bypass = await sendWhatsappTemplate(phone, "t", "sw", [], {
      bypassRateLimit: true,
    });
    expect(bypass.ok).toBe(true);
  });
});

describe("sendWhatsappInteractiveList", () => {
  it("posts a list interactive payload", async () => {
    let capturedBody: Record<string, unknown> = {};
    mockFetch(async (_req, init) => {
      capturedBody = JSON.parse(String(init?.body ?? "{}"));
      return jsonResponse({ messages: [{ id: "wamid.list1" }] });
    });
    const result = await sendWhatsappInteractiveList(
      "+254712345678",
      "Karibu ArdaLink",
      "Chagua huduma",
      "Chagua",
      [{ title: "Huduma", rows: [{ id: "bula_pesa", title: "Bula Pesa" }] }],
    );
    expect(result.ok).toBe(true);
    expect(capturedBody).toMatchObject({
      type: "interactive",
      interactive: { type: "list" },
    });
  });
});

describe("sendWhatsappInteractiveButtons", () => {
  it("posts a button interactive payload capped at 3 buttons", async () => {
    let capturedBody: {
      interactive?: { action?: { buttons?: unknown[] } };
    } = {};
    mockFetch(async (_req, init) => {
      capturedBody = JSON.parse(String(init?.body ?? "{}"));
      return jsonResponse({ messages: [{ id: "wamid.btn1" }] });
    });
    const result = await sendWhatsappInteractiveButtons("+254712345678", "Pick one", [
      { id: "a", title: "A" },
      { id: "b", title: "B" },
      { id: "c", title: "C" },
      { id: "d", title: "D" },
    ]);
    expect(result.ok).toBe(true);
    expect(capturedBody.interactive?.action?.buttons?.length).toBe(3);
  });
});

describe("sendWhatsappLocation", () => {
  it("posts a location payload", async () => {
    let capturedBody: Record<string, unknown> = {};
    mockFetch(async (_req, init) => {
      capturedBody = JSON.parse(String(init?.body ?? "{}"));
      return jsonResponse({ messages: [{ id: "wamid.loc1" }] });
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
      type: "location",
      location: { latitude: 0.3453, longitude: 37.581, name: "Bula Pesa Dam" },
    });
  });
});
