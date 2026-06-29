/**
 * Tests for apiFetch Bearer-token injection.
 *
 * These tests guard against the regression that bit the dashboard
 * 2026-06-12: a direct `fetch("/api/...")` call dropped the Bearer
 * token and the api returned 401. All typed hooks now route through
 * apiFetch, so the only contract is "fetch sees the Authorization
 * header".
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mintCallToken } from "../src";

function makeStorageStub() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k: string) => (data.get(k) ?? null) as string | null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
    clear: () => data.clear(),
    key: (i: number) => Array.from(data.keys())[i] ?? null,
    get length() {
      return data.size;
    },
  };
}

let stub: ReturnType<typeof makeStorageStub>;
let originalFetch: typeof fetch;
let originalWindow: unknown;

beforeEach(() => {
  stub = makeStorageStub();
  originalFetch = globalThis.fetch;
  originalWindow = (globalThis as { window?: unknown }).window;
  Object.defineProperty(globalThis, "window", {
    value: {
      localStorage: stub,
      location: { href: "http://localhost/" },
    },
    writable: true,
    configurable: true,
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalWindow === undefined) {
    delete (globalThis as { window?: unknown }).window;
  } else {
    Object.defineProperty(globalThis, "window", {
      value: originalWindow,
      writable: true,
      configurable: true,
    });
  }
});

describe("apiFetch — Bearer token injection", () => {
  it("attaches Authorization: Bearer <jwt> when localStorage holds a token", async () => {
    stub.setItem("ardalink.jwt", "jwt.fake.token");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ token: "x.y.z", expiresAt: 1, ttlSeconds: 900 }),
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await mintCallToken();

    const [, calledInit] = fetchMock.mock.calls[0]!;
    const headers = (calledInit as { headers: Headers }).headers;
    expect(headers.get("authorization")).toBe("Bearer jwt.fake.token");
  });

  it("sets content-type: application/json when a body is provided", async () => {
    stub.setItem("ardalink.jwt", "tok");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ token: "x", expiresAt: 1, ttlSeconds: 900 }),
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await mintCallToken("+254700000123");

    const [, calledInit] = fetchMock.mock.calls[0]!;
    const headers = (calledInit as { headers: Headers }).headers;
    expect(headers.get("content-type")).toBe("application/json");
    expect((calledInit as { body: string }).body).toBe(
      JSON.stringify({ phone: "+254700000123" }),
    );
  });

  it("does not set an Authorization header when no token is present", async () => {
    // storage is empty, URL has no token → Bearer must be absent
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ token: "x", expiresAt: 1, ttlSeconds: 900 }),
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await mintCallToken();

    const [, calledInit] = fetchMock.mock.calls[0]!;
    const headers = (calledInit as { headers: Headers }).headers;
    expect(headers.get("authorization")).toBeNull();
  });
});