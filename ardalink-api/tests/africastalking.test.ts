/**
 * Unit tests for the outbound AT client. Zero real network — the
 * global fetch is mocked per-test so we can inspect exactly what
 * shape reaches AT and how the client interprets each response.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  sendSmsViaAt,
  initiateOutboundCall,
  isAtConfigured,
  _resetRateLimits,
} from "../src/lib/africastalking";

const originalFetch = globalThis.fetch;

function mockFetch(handler: (req: Request | URL, init?: RequestInit) => Response | Promise<Response>) {
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
  vi.stubEnv("AFRICASTALKING_USERNAME", "sandbox");
  vi.stubEnv("AFRICASTALKING_API_KEY", "test-key");
  vi.stubEnv("AFRICASTALKING_CALLER_ID", "+254711082200");
  vi.stubEnv("AT_OUTBOUND_ENABLED", "true");
  vi.stubEnv("AT_SMS_DAILY_CAP", "3");
  vi.stubEnv("AT_VOICE_15MIN_CAP", "1");
});

afterEach(() => {
  vi.unstubAllEnvs();
  globalThis.fetch = originalFetch;
});

describe("isAtConfigured", () => {
  it("returns true when username + api key are set", () => {
    expect(isAtConfigured()).toBe(true);
  });
});

describe("sendSmsViaAt", () => {
  it("posts to the sandbox host with form-encoded body when username=sandbox", async () => {
    let capturedUrl = "";
    let capturedBody = "";
    let capturedHeaders: Record<string, string> = {};
    mockFetch(async (req, init) => {
      capturedUrl = typeof req === "string" ? req : req.toString();
      capturedBody = String(init?.body ?? "");
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
      return jsonResponse({
        SMSMessageData: {
          Message: "Sent to 1/1 Total Cost: KES 0.8000",
          Recipients: [
            {
              number: "+254712345678",
              status: "Success",
              messageId: "ATSMid_test1",
              cost: "KES 0.8000",
            },
          ],
        },
      });
    });

    const result = await sendSmsViaAt("+254712345678", "Habari — test");
    expect(result.ok).toBe(true);
    expect(result.messageId).toBe("ATSMid_test1");
    expect(result.status).toBe("Success");

    expect(capturedUrl).toContain("api.sandbox.africastalking.com/version1/messaging");
    expect(capturedBody).toContain("username=sandbox");
    expect(capturedBody).toContain("to=%2B254712345678");
    expect(capturedBody).toContain("message=Habari+%E2%80%94+test");
    // sender ID is now optional (blank in sandbox to avoid
    // 'InvalidSenderId' — see africastalking.ts for the rationale).
    expect(capturedBody).not.toContain("from=%2B254711082200");
    expect(capturedHeaders.apiKey).toBe("test-key");
  });

  it("uses the production host when username is not sandbox", async () => {
    vi.stubEnv("AFRICASTALKING_USERNAME", "ardalink-prod");
    let capturedUrl = "";
    mockFetch(async (req) => {
      capturedUrl = typeof req === "string" ? req : req.toString();
      return jsonResponse({
        SMSMessageData: {
          Recipients: [{ status: "Success", messageId: "id2" }],
        },
      });
    });
    await sendSmsViaAt("+254712345678", "hi");
    expect(capturedUrl).toContain("api.africastalking.com/version1/messaging");
    expect(capturedUrl).not.toContain("sandbox");
  });

  it("returns skipped=disabled without dispatching when kill switch is off", async () => {
    vi.stubEnv("AT_OUTBOUND_ENABLED", "false");
    let called = false;
    mockFetch(async () => {
      called = true;
      return jsonResponse({});
    });
    const result = await sendSmsViaAt("+254712345678", "hi");
    expect(result).toEqual({ ok: false, skipped: true, reason: "disabled" });
    expect(called).toBe(false);
  });

  it("returns not_configured when the credentials are missing", async () => {
    // Explicitly stub-empty — vi.unstubAllEnvs restores the process env
    // to whatever was loaded from .env, which HAS the credentials.
    vi.stubEnv("AFRICASTALKING_USERNAME", "");
    vi.stubEnv("AFRICASTALKING_API_KEY", "");
    let called = false;
    mockFetch(async () => {
      called = true;
      return jsonResponse({});
    });
    const result = await sendSmsViaAt("+254712345678", "hi");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("not_configured");
    expect(called).toBe(false);
  });

  it("hits the daily cap after AT_SMS_DAILY_CAP dispatches", async () => {
    mockFetch(async () =>
      jsonResponse({
        SMSMessageData: {
          Recipients: [{ status: "Success", messageId: "capped" }],
        },
      }),
    );
    const phone = "+254712345678";
    const first = await sendSmsViaAt(phone, "1");
    const second = await sendSmsViaAt(phone, "2");
    const third = await sendSmsViaAt(phone, "3");
    const fourth = await sendSmsViaAt(phone, "4");
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(third.ok).toBe(true);
    expect(fourth.ok).toBe(false);
    expect(fourth.reason).toBe("rate_limited");
  });

  it("bypasses the cap when opts.bypassRateLimit is set", async () => {
    mockFetch(async () =>
      jsonResponse({
        SMSMessageData: { Recipients: [{ status: "Success" }] },
      }),
    );
    const phone = "+254712345678";
    for (let i = 0; i < 5; i++) await sendSmsViaAt(phone, "x");
    const bypass = await sendSmsViaAt(phone, "urgent", { bypassRateLimit: true });
    expect(bypass.ok).toBe(true);
  });

  it("truncates message to 160 chars", async () => {
    let capturedBody = "";
    mockFetch(async (_req, init) => {
      capturedBody = String(init?.body ?? "");
      return jsonResponse({
        SMSMessageData: { Recipients: [{ status: "Success" }] },
      });
    });
    const long = "a".repeat(200);
    await sendSmsViaAt("+254712345678", long);
    // Extract message= value from the URL-encoded body
    const params = new URLSearchParams(capturedBody);
    expect(params.get("message")?.length).toBe(160);
  });

  it("returns at_error for a non-2xx from AT", async () => {
    mockFetch(async () => new Response("nope", { status: 401 }));
    const r = await sendSmsViaAt("+254712345678", "x");
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("at_error");
  });

  it("returns network_error when fetch throws", async () => {
    mockFetch(async () => {
      throw new Error("dns failed");
    });
    const r = await sendSmsViaAt("+254712345678", "x");
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("network_error");
  });
});

describe("initiateOutboundCall", () => {
  it("posts to the sandbox voice host with from + to", async () => {
    let capturedUrl = "";
    let capturedBody = "";
    mockFetch(async (req, init) => {
      capturedUrl = typeof req === "string" ? req : req.toString();
      capturedBody = String(init?.body ?? "");
      return jsonResponse({
        entries: [
          {
            phoneNumber: "+254712345678",
            status: "Queued",
            sessionId: "ATVId_test1",
          },
        ],
        errorMessage: "None",
      });
    });
    const r = await initiateOutboundCall("+254712345678");
    expect(r.ok).toBe(true);
    expect(r.messageId).toBe("ATVId_test1");
    expect(r.status).toBe("Queued");
    expect(capturedUrl).toContain("voice.africastalking.com/call");
    expect(capturedBody).toContain("username=sandbox");
    expect(capturedBody).toContain("from=%2B254711082200");
    expect(capturedBody).toContain("to=%2B254712345678");
  });

  it("caps to 1 call per 15 min per phone", async () => {
    mockFetch(async () =>
      jsonResponse({
        entries: [{ status: "Queued", sessionId: "sid" }],
        errorMessage: "None",
      }),
    );
    const phone = "+254712345678";
    const first = await initiateOutboundCall(phone);
    const second = await initiateOutboundCall(phone);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    expect(second.reason).toBe("rate_limited");
  });

  it("returns at_error when AT payload has errorMessage set", async () => {
    mockFetch(async () =>
      jsonResponse({
        entries: [],
        errorMessage: "Insufficient balance",
      }),
    );
    const r = await initiateOutboundCall("+254712345678");
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("at_error");
  });

  it("kill switch skips both dispatches", async () => {
    vi.stubEnv("AT_OUTBOUND_ENABLED", "false");
    let called = false;
    mockFetch(async () => {
      called = true;
      return jsonResponse({});
    });
    const r = await initiateOutboundCall("+254712345678");
    expect(r).toEqual({ ok: false, skipped: true, reason: "disabled" });
    expect(called).toBe(false);
  });
});
