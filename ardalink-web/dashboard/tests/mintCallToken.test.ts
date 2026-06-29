/**
 * Tests for the call-tokens mint helper.
 *
 * Regression: the dashboard's "Hear ArdaLink call you" button used to
 * call `fetch("/api/call-tokens", { method: "POST" })` directly, which
 * dropped the Bearer token and caused a 401. The mintCallToken helper
 * in api-client-react routes through apiFetch which attaches the JWT
 * from localStorage, so the dashboard now gets 200.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mintCallToken } from "../../packages/api-client-react/src";

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
const originalFetch = globalThis.fetch;

beforeEach(() => {
  stub = makeStorageStub();
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
});

describe("mintCallToken", () => {
  it("attaches the Bearer token from localStorage", async () => {
    stub.setItem("ardalink.jwt", "jwt.fake.token");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        token: "x.y.z",
        expiresAt: 1782218354094,
        ttlSeconds: 900,
      }),
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await mintCallToken();
    expect(result.token).toBe("x.y.z");
    expect(result.expiresAt).toBe(1782218354094);

    const [calledUrl, calledInit] = fetchMock.mock.calls[0]!;
    expect(String(calledUrl)).toBe("/api/call-tokens");
    const headers = (calledInit as { headers: Headers }).headers;
    expect(headers.get("authorization")).toBe("Bearer jwt.fake.token");
    expect(headers.get("content-type")).toBe("application/json");
  });

  it("forwards an optional phone number in the body", async () => {
    stub.setItem("ardalink.jwt", "tok");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        token: "x.y.z",
        expiresAt: 1,
        ttlSeconds: 900,
      }),
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await mintCallToken("+254700000123");
    const [, calledInit] = fetchMock.mock.calls[0]!;
    expect((calledInit as { body: string }).body).toBe(
      JSON.stringify({ phone: "+254700000123" }),
    );
  });

  it("throws on 401 (the original dashboard bug)", async () => {
    stub.setItem("ardalink.jwt", "tok");
    globalThis.fetch = (async () => ({
      ok: false,
      status: 401,
      text: async () => "Missing Bearer token",
      json: async () => ({ error: "Missing Bearer token" }),
    })) as unknown as typeof fetch;

    await expect(mintCallToken()).rejects.toThrow(/401/);
  });
});
